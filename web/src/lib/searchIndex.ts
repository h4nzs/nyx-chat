// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F §30.10 poin 3] Indeks pencarian **in-memory** untuk vault lokal.
 *
 * Kenapa: `store/messageSearch.ts` dulu mendekripsi SELURUH percakapan di tiap
 * ketikan (O(n) XChaCha-open), jadi pencarian di riwayat 10k pesan praktis tidak
 * bisa dipakai. Indeks ini dibangun dari plaintext yang **sudah** didekripsi di
 * memori (tidak pernah ditulis ke disk, tidak ada FTS plaintext — jalur
 * token-HMAC ke disk di `docs/30` §30.10 poin 3 bersifat opsional dan sengaja
 * tidak dipakai).
 *
 * Semantik pencarian TIDAK diubah: `candidates()` mengembalikan **superset**
 * dari hasil lama (AND antar token dengan pencocokan *prefix*), lalu pemanggil
 * tetap memverifikasi `plainText.toLowerCase().includes(query)` pada kandidat.
 * Dengan begitu hasilnya identik dengan pencarian substring sebelumnya, tetapi
 * dekripsi hanya dilakukan untuk kandidat — bukan seluruh percakapan.
 */

/** Batas jumlah pesan berindeks (memori): lewat batas → percakapan paling lama dipakai dibuang. */
export const SEARCH_INDEX_MAX_MESSAGES = 20_000;

/** Pemecah kata: huruf/angka Unicode, huruf kecil, token ≥ 1 karakter. */
export function tokenizeSearchText(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

/**
 * Sidik jari murah sebuah baris vault **tanpa dekripsi** — cukup untuk tahu
 * apakah isi baris berubah (panjang + tepi ciphertext + flag mentah). Dipakai
 * pemanggil sebagai penanda staleness indeks: baris dengan sidik jari sama tidak
 * perlu didekripsi ulang.
 */
export function searchRowFingerprint(row: {
  content?: string | null;
  isDeletedLocal?: unknown;
  isViewOnce?: unknown;
}): string {
  const content = typeof row.content === 'string' ? row.content : '';
  const head = content.slice(0, 8);
  const tail = content.slice(-8);
  return [
    content.length,
    head,
    tail,
    typeof row.isDeletedLocal === 'boolean' ? String(row.isDeletedLocal) : String(row.isDeletedLocal ?? ''),
    typeof row.isViewOnce === 'boolean' ? String(row.isViewOnce) : String(row.isViewOnce ?? ''),
  ].join('|');
}

interface IndexedMessage {
  conversationId: string;
  tokens: string[];
}

export class MessageSearchIndex {
  private readonly maxMessages: number;

  /** `maxMessages` bisa diperkecil di test; produksi memakai `SEARCH_INDEX_MAX_MESSAGES`. */
  constructor(options: { maxMessages?: number } = {}) {
    this.maxMessages = options.maxMessages ?? SEARCH_INDEX_MAX_MESSAGES;
  }

  /** token → id pesan */
  private byToken = new Map<string, Set<string>>();
  /** id pesan → percakapan + token-nya (untuk penghapusan) */
  private byId = new Map<string, IndexedMessage>();
  /** token terurut (untuk pencarian prefix); `null` = perlu diurutkan ulang */
  private sortedTokens: string[] | null = null;
  /** LRU percakapan: yang paling akhir dipakai di ujung array */
  private recency: string[] = [];

  get size(): number {
    return this.byId.size;
  }

  get conversationCount(): number {
    return new Set([...this.byId.values()].map((entry) => entry.conversationId)).size;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Tambah satu pesan. Idempoten: id yang sudah ada tidak ditokenisasi ulang. */
  add(id: string, conversationId: string, text: string): void {
    if (this.byId.has(id)) {
      this.touch(conversationId);
      return;
    }
    const tokens = tokenizeSearchText(text);
    if (tokens.length === 0) return;

    this.byId.set(id, { conversationId, tokens });
    for (const token of tokens) {
      const bucket = this.byToken.get(token);
      if (bucket) bucket.add(id);
      else this.byToken.set(token, new Set([id]));
    }
    this.sortedTokens = null;
    this.touch(conversationId);
    this.evictIfNeeded();
  }

  remove(id: string): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    this.byId.delete(id);
    for (const token of entry.tokens) {
      const bucket = this.byToken.get(token);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) {
        this.byToken.delete(token);
        this.sortedTokens = null;
      }
    }
  }

  clear(): void {
    this.byToken.clear();
    this.byId.clear();
    this.recency = [];
    this.sortedTokens = null;
  }

  /**
   * Kandidat id untuk `query` di satu percakapan (AND antar token, pencocokan
   * **prefix**), urut sesuai urutan masuk indeks. `limit` menjaga pekerjaan
   * pemanggil tetap terbatas saat query sangat umum.
   */
  candidates(conversationId: string, query: string, limit = 200): string[] {
    const queryTokens = tokenizeSearchText(query);
    if (queryTokens.length === 0) return [];
    this.touch(conversationId);

    // Setiap token query → gabungan id dari token indeks yang MEMUAT token itu.
    const perToken: Set<string>[] = [];
    for (const token of queryTokens) {
      const matched = this.matchTokenSubstring(token);
      if (matched.size === 0) return []; // satu token tidak ada → mustahil cocok
      perToken.push(matched);
    }

    // Intersect mulai dari set terkecil (biaya paling kecil).
    perToken.sort((a, b) => a.size - b.size);
    let result = perToken[0]!;
    for (let i = 1; i < perToken.length; i++) {
      const next = perToken[i]!;
      const intersection = new Set<string>();
      for (const id of result) {
        if (next.has(id)) intersection.add(id);
      }
      result = intersection;
      if (result.size === 0) return [];
    }

    const out: string[] = [];
    for (const id of this.byId.keys()) {
      if (!result.has(id)) continue;
      const entry = this.byId.get(id);
      if (!entry || entry.conversationId !== conversationId) continue;
      out.push(id);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Semua id pesan yang berindeks untuk satu percakapan. */
  idsForConversation(conversationId: string): string[] {
    const out: string[] = [];
    for (const [id, entry] of this.byId) {
      if (entry.conversationId === conversationId) out.push(id);
    }
    return out;
  }

  /**
   * Gabungan id untuk semua token yang **memuat** `needle` sebagai substring.
   *
   * Pencocokan prefix saja TIDAK cukup untuk mempertahankan semantik lama:
   * pencarian lama memakai `plainText.includes(query)`, jadi query seperti
   * `"o wor"` harus tetap menemukan `"hello world"` — token querynya (`o`)
   * bukan prefix dari token teks (`hello`), hanya substring-nya. Syarat perlu
   * dari `teks.includes(query)` adalah tiap token query termuat di salah satu
   * token teks, dan itulah yang dihitung di sini (superset; pemanggil tetap
   * memverifikasi substring utuh pada kandidat).
   */
  private matchTokenSubstring(needle: string): Set<string> {
    const result = new Set<string>();
    for (const token of this.sortedTokenList()) {
      if (!token.includes(needle)) continue;
      const bucket = this.byToken.get(token);
      if (bucket) for (const id of bucket) result.add(id);
    }
    return result;
  }

  private sortedTokenList(): string[] {
    if (!this.sortedTokens) this.sortedTokens = [...this.byToken.keys()].sort();
    return this.sortedTokens;
  }

  private touch(conversationId: string): void {
    const at = this.recency.indexOf(conversationId);
    if (at !== -1) this.recency.splice(at, 1);
    this.recency.push(conversationId);
  }

  /** Buang percakapan paling lama tidak dipakai sampai di bawah batas memori. */
  private evictIfNeeded(): void {
    while (this.byId.size > this.maxMessages && this.recency.length > 1) {
      const oldest = this.recency[0];
      if (oldest === undefined) return;
      for (const id of this.idsForConversation(oldest)) this.remove(id);
      this.recency.shift();
    }
  }
}
