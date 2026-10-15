import { createWithEqualityFn } from "zustand/traditional";
import { shadowVault, decryptVaultText } from '@lib/shadowVaultDb';
// [docs/30 WS-F] kolom pengurutan `createdAt` kini ter-seal → urutkan lewat
// lapis presisi (`openOrderInstant`), bukan `sortBy('createdAt')` mentah.
import { openOrderInstant, resolveOrderInstants } from '@lib/localOrderKey';
// [docs/30 WS-F langkah 3] `isViewOnce`/`isDeletedLocal` di-seal di tempat →
// tidak boleh dibaca sebagai boolean mentah (envelope `ENC1:` selalu truthy).
import { openLocalFlag } from '@lib/localAtRest';
// [docs/30 WS-F §30.10 poin 3] indeks pencarian in-memory → pencarian tidak lagi
// mendekripsi seluruh percakapan di tiap ketikan.
import { MessageSearchIndex, searchRowFingerprint, tokenizeSearchText } from '@lib/searchIndex';
import type { DecryptedMessageRecord } from '@lib/db';
import type { Message } from "./conversation";
import type { MessageId } from '@nyx/shared';

/** Batas kandidat per pencarian (query sangat umum tidak boleh membanjiri UI). */
export const SEARCH_CANDIDATE_LIMIT = 200;

/** Indeks hidup selama sesi (module scope); tidak pernah ditulis ke disk. */
const searchIndex = new MessageSearchIndex();
/** convId → id → sidik jari baris terakhir yang diindeks (tanda staleness). */
const indexedFingerprints = new Map<string, Map<string, string>>();
/** id → plaintext yang sudah didekripsi (untuk verifikasi tanpa dekripsi ulang). */
const plaintextCache = new Map<string, string>();

/** Dipakai test: buang seluruh state indeks. */
export function resetSearchIndexForTests(): void {
  searchIndex.clear();
  indexedFingerprints.clear();
  plaintextCache.clear();
}

/**
 * Sinkronkan indeks satu percakapan dengan isi vault.
 *
 * Hanya baris yang **sidik jarinya berubah** (`searchRowFingerprint`, tanpa
 * dekripsi) yang didekripsi ulang — jadi pencarian berulang di riwayat besar
 * tidak membayar O(n) XChaCha-open lagi. Mengembalikan baris mentah percakapan
 * (dipakai jalur fallback untuk query tanpa token, mis. `"!!!"`, agar semantik
 * substring lama tetap utuh).
 */
async function syncConversationIndex(conversationId: string): Promise<DecryptedMessageRecord[]> {
  const rows = await shadowVault.messages.where('conversationId').equals(conversationId).toArray();
  const fingerprints = indexedFingerprints.get(conversationId) ?? new Map<string, string>();
  const seen = new Set<string>();

  for (const row of rows) {
    const id = String(row.id);
    seen.add(id);
    const fingerprint = searchRowFingerprint(row);
    if (fingerprints.get(id) === fingerprint) continue;

    const isViewOnce = (await openLocalFlag(row.isViewOnce)) === true;
    const isDeletedLocal = (await openLocalFlag(row.isDeletedLocal)) === true;
    if (isViewOnce || isDeletedLocal || !row.content) {
      searchIndex.remove(id);
      plaintextCache.delete(id);
      fingerprints.set(id, fingerprint);
      continue;
    }

    const plainText = await decryptVaultText(row.content);
    if (plainText) {
      searchIndex.add(id, conversationId, plainText);
      plaintextCache.set(id, plainText);
    } else {
      searchIndex.remove(id);
      plaintextCache.delete(id);
    }
    fingerprints.set(id, fingerprint);
  }

  // Baris yang sudah tidak ada di vault (dihapus) → buang dari indeks.
  // Snapshot eksplisit: `fingerprints` dimutasi di dalam loop.
  for (const id of Array.from(fingerprints.keys())) {
    if (seen.has(id)) continue;
    searchIndex.remove(id);
    plaintextCache.delete(id);
    fingerprints.delete(id);
  }
  indexedFingerprints.set(conversationId, fingerprints);
  return rows;
}

type State = {
  searchResults: Message[];
  highlightedMessageId: MessageId | null;
  searchQuery: string;
  isSearching: boolean;
  currentSearchToken: string | null;
  
  // Actions
  searchMessages: (query: string, conversationId: string) => Promise<void>;
  setHighlightedMessageId: (messageId: MessageId | null) => void;
  clearSearch: () => void;
};

export const useMessageSearchStore = createWithEqualityFn<State>((set, get) => ({
  searchResults: [],
  highlightedMessageId: null,
  searchQuery: '',
  isSearching: false,
  currentSearchToken: null,

  searchMessages: async (query, conversationId) => {
    if (!query.trim()) {
      set({ searchResults: [], isSearching: false, searchQuery: query });
      return;
    }

    const normalizedQuery = query.toLowerCase();
    let token: string | null = null;

    try {
      const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
      token = sodium.to_hex(sodium.randombytes_buf(16));
      set({ searchQuery: query, isSearching: true, currentSearchToken: token });
      
      // 1. Sinkronkan indeks dengan vault (dekripsi hanya baris yang berubah),
      // lalu ambil kandidat dari indeks.
      const conversationRows = await syncConversationIndex(conversationId);
      const hasTokens = tokenizeSearchText(query).length > 0;
      const candidateIds = hasTokens
        ? searchIndex.candidates(conversationId, query, SEARCH_CANDIDATE_LIMIT)
        : null;

      // Query tanpa token (mis. `"!!!"`) → jatuh ke seluruh baris percakapan,
      // persis seperti pencarian substring lama.
      let rawResults: DecryptedMessageRecord[] = conversationRows;
      if (candidateIds) {
        const fetched = await shadowVault.messages.bulkGet(candidateIds);
        rawResults = fetched.filter((row): row is DecryptedMessageRecord => !!row);
      }

      // Urut lama→baru (perilaku `sortBy('createdAt')` sebelumnya) dihitung dari
      // waktu presisi, karena `createdAt` di DB sudah berupa envelope `ENC1:`
      // atau kosong untuk baris baru.
      const instants = await resolveOrderInstants(rawResults);
      const ordered = rawResults
        .map((row, i) => ({ row, instant: instants[i] ?? null }))
        .sort((a, b) => (a.instant ?? 0) - (b.instant ?? 0));

      // 2. Verifikasi substring pada kandidat saja (hasil identik dengan
      // pencarian lama, yang memakai `plainText.includes(query)`).
      const decryptedResults: Message[] = [];
      for (const { row: msg } of ordered) {
        const id = String(msg.id);
        const plainText = plaintextCache.get(id) ?? (msg.content ? await decryptVaultText(msg.content) : null);
        if (!plainText || !plainText.toLowerCase().includes(normalizedQuery)) continue;

        const instant = await openOrderInstant(msg);
        decryptedResults.push({
          ...msg,
          content: plainText,
          createdAt: new Date(instant ?? 0).toISOString(),
        } as Message);
      }
        
      // ONLY update if the query hasn't changed while we were decrypting
      if (get().currentSearchToken === token) {
        set({ searchResults: decryptedResults, isSearching: false });
      }
    } catch (error) {
      console.error("Iron Vault Search failed:", error);
      if (get().currentSearchToken === token) {
        set({ searchResults: [], isSearching: false });
      }
    }
  },

  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),
  
  clearSearch: () => set({ searchResults: [], searchQuery: '', isSearching: false, highlightedMessageId: null }),
}));
