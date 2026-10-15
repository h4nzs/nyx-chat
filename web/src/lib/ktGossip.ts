// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 tahap C / docs/34 §34.5] Gossip tree head Key Transparency.
 *
 * `docs/34` §34.5 mencatat batas jujur verifikasi KT: **tanpa jangkar**, perubahan
 * pada `search`/`tree head` tidak terdeteksi — verifier tidak punya akar
 * pembanding. Loop monitor menutup sebagian itu (head sendiri dibandingkan
 * dengan head sebelumnya), tapi tidak bisa menangkap **split-view**: log
 * menyajikan pohon A ke klien 1 dan pohon B ke klien 2, dan masing-masing
 * konsisten dengan dirinya sendiri.
 *
 * Gossip menutup celah itu dengan cara paling murah yang ada: dua klien
 * membandingkan `(treeSize, root)` yang mereka lihat. Kalau ukuran pohonnya
 * **sama** tapi root-nya **berbeda**, tidak ada penjelasan sah apa pun — satu
 * pohon hanya punya satu root untuk satu ukuran, jadi itu bukti split-view.
 *
 * Yang **tidak** dilakukan modul ini:
 *  - tidak memverifikasi apa pun sendiri: ia membandingkan angka. Verifikasi
 *    tetap milik WASM `libsignal-keytrans`, dan root yang dipakai di sini berasal
 *    dari layanan yang sama yang buktinya diverifikasi (`/api/keys/kt/head`);
 *    kalau root itu berbeda dari bukti, verifikasi bukti yang gagal.
 *  - tidak menambah data yang dikirim ke server: field gossip hidup **di dalam
 *    payload ter-seal** (`ktG`), sama seperti deklarasi versi ratchet (`ackV`).
 *  - tidak memblokir kirim: split-view dicatat + dilaporkan, keputusan blokir
 *    tetap di jalur pin (`peerIdentityTrust`).
 *  - tidak menyimpan identitas user: kunci baris adalah `conversationId` (sesi
 *    1:1 yang sudah ada di vault), bukan `userId`.
 *
 * Head yang lebih baru dari jangkar lokal **tidak** dipakai untuk menyimpulkan
 * apa pun tanpa bukti konsistensi — karena itu verdict-nya `peer-ahead`, bukan
 * `consistent`. Yang bisa disimpulkan hanya dua hal: sama (`consistent`) atau
 * sama ukuran tapi beda root (`split-view`).
 */

import { db } from './db';
import { decryptValueAtRest, encryptValueAtRest } from './keychainDb';

/** Nama field di payload ter-seal. Pendek: payload ikut ke setiap pesan. */
export const KT_GOSSIP_FIELD = 'ktG';

/** Batas kewarasan ukuran pohon: menolak angka yang jelas bukan ukuran log. */
export const KT_GOSSIP_MAX_TREE_SIZE = 1_000_000_000;

/** Batas jumlah peer yang disimpan (state lokal kecil; peer lama dibuang). */
export const KT_GOSSIP_MAX_PEERS = 64;

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

export interface KtHeadAnchor {
  /** Root pohon 32 byte sebagai hex huruf kecil (64 karakter). */
  root: string;
  treeSize: number;
}

export type KtGossipVerdict =
  /** Klien belum punya jangkar sendiri — tidak ada yang bisa dibandingkan. */
  | 'no-anchor'
  /** Ukuran sama dan root sama. */
  | 'consistent'
  /** Peer melihat pohon yang lebih baru; butuh bukti konsistensi untuk lanjut. */
  | 'peer-ahead'
  /** Peer tertinggal; tidak berbahaya, sekadar informasi. */
  | 'peer-stale'
  /** Ukuran sama, root berbeda → bukti split-view. */
  | 'split-view';

/**
 * Validasi + normalisasi head dari mana pun (payload peer, layanan, DB lokal).
 *
 * Menerima **dua nama field** dengan sengaja:
 *  - `{ r, s }` — bentuk yang dikirim di dalam payload ter-seal (`ktG`). Dipendekkan
 *    karena field ini ikut di SETIAP pesan; satu karakter pun berarti.
 *  - `{ root, treeSize }` — bentuk yang dipakai di dalam proses (cache RAM, baris
 *    DB yang sudah ter-seal utuh, jawaban `/api/keys/kt/head`).
 *
 * Bentuk yang tidak sah → `undefined` (bukan dilempar): pemanggilnya adalah jalur
 * pesan yang tidak boleh gagal karena gossip. */
export function parseHeadAnchor(value: unknown): KtHeadAnchor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { r?: unknown; s?: unknown; root?: unknown; treeSize?: unknown };
  const root = typeof candidate.r === 'string' ? candidate.r : candidate.root;
  const size = typeof candidate.s === 'number' ? candidate.s : candidate.treeSize;
  if (typeof root !== 'string' || !HEX_32_BYTES.test(root)) return undefined;
  if (
    typeof size !== 'number' ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > KT_GOSSIP_MAX_TREE_SIZE
  ) {
    return undefined;
  }
  return { root, treeSize: size };
}

/**
 * Field yang digabungkan ke payload ter-seal. Bentuknya sengaja pendek:
 * `{ ktG: { r: <root hex>, s: <treeSize> } }`, dan `{}` bila tidak ada jangkar
 * (klien baru / KT nonaktif) — sehingga klien lama tidak melihat perubahan apa pun.
 */
export function treeHeadField(anchor: KtHeadAnchor | null | undefined): Record<string, unknown> {
  const valid = parseHeadAnchor(anchor);
  if (!valid) return {};
  return { [KT_GOSSIP_FIELD]: { r: valid.root, s: valid.treeSize } };
}

/**
 * Baca field gossip dari plaintext payload. **Tidak pernah melempar**: payload
 * datang dari peer, jadi bentuk aneh apa pun hanya berarti "tidak ada gossip".
 */
export function extractTreeHeadField(plaintext: string): KtHeadAnchor | undefined {
  try {
    const parsed = JSON.parse(plaintext) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parseHeadAnchor(parsed[KT_GOSSIP_FIELD]);
  } catch {
    return undefined;
  }
}

/**
 * Bandingkan head peer dengan jangkar lokal. Murni, tanpa I/O.
 *
 * Aturan yang dipakai adalah satu-satunya fakta yang tidak butuh bukti tambahan:
 * untuk satu `treeSize`, pohon hanya punya satu root.
 */
export function evaluateGossipHead(
  local: KtHeadAnchor | null | undefined,
  peer: KtHeadAnchor | null | undefined
): KtGossipVerdict {
  const peerHead = parseHeadAnchor(peer);
  if (!peerHead) return 'no-anchor';
  const localHead = parseHeadAnchor(local);
  if (!localHead) return 'no-anchor';
  if (peerHead.treeSize === localHead.treeSize) {
    return peerHead.root === localHead.root ? 'consistent' : 'split-view';
  }
  return peerHead.treeSize > localHead.treeSize ? 'peer-ahead' : 'peer-stale';
}

// ---------------------------------------------------------------------------
// Jangkar lokal (cache RAM — jalur kirim tidak boleh membaca DB tiap pesan)
// ---------------------------------------------------------------------------

let localAnchor: KtHeadAnchor | null = null;

/** Setel jangkar lokal (memory; persistensi lewat `KtGossip.setAnchor`). */
export function setLocalAnchor(anchor: KtHeadAnchor | null | undefined): void {
  localAnchor = parseHeadAnchor(anchor) ?? null;
}

/** Jangkar lokal saat ini (atau null). Dibaca jalur kirim tanpa I/O. */
export function getLocalAnchor(): KtHeadAnchor | null {
  return localAnchor;
}

/** Hanya untuk test: kembalikan cache ke keadaan awal. */
export function resetLocalAnchorForTests(): void {
  localAnchor = null;
}

// ---------------------------------------------------------------------------
// Penyimpanan
// ---------------------------------------------------------------------------

export interface KtGossipRecord {
  /** Kunci sesi (percakapan 1:1) — bukan userId: gossip tidak butuh identitas. */
  peerId: string;
  head: KtHeadAnchor;
  at: number;
  verdict: KtGossipVerdict;
}

/** Baris mentah (satu baris JSON yang sudah di-seal, `ENC1:`). */
export interface KtGossipStorage {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

export interface KtGossipDeps {
  storage: KtGossipStorage;
  now?: () => number;
  maxPeers?: number;
  /** Dilaporkan saat split-view terdeteksi (dipakai notifikasi/log). */
  onSplitView?: (record: KtGossipRecord) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface KtGossip {
  /** Simpan head peer + kembalikan verdict terhadap jangkar lokal. */
  recordPeerHead(peerId: string, head: unknown): Promise<KtGossipVerdict>;
  list(): Promise<KtGossipRecord[]>;
  splitViews(): Promise<KtGossipRecord[]>;
  forget(peerId: string): Promise<void>;
  clear(): Promise<void>;
  /** Setel + persist jangkar lokal (dipanggil setelah verifikasi/monitor). */
  setAnchor(anchor: KtHeadAnchor | null): Promise<void>;
  /** Muat jangkar tersimpan ke cache RAM (dipanggil sekali saat app siap). */
  loadAnchor(): Promise<KtHeadAnchor | null>;
}

interface KtGossipBlob {
  /** Jangkar terakhir yang dipercaya (`null` bila belum ada). */
  a: KtHeadAnchor | null;
  /** Head peer terakhir per sesi. */
  p: KtGossipRecord[];
}

function parseRecords(value: unknown): KtGossipRecord[] {
  if (!Array.isArray(value)) return [];
  const out: KtGossipRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Partial<KtGossipRecord>;
    const head = parseHeadAnchor(record.head);
    if (typeof record.peerId !== 'string' || !head) continue;
    out.push({
      peerId: record.peerId,
      head,
      at: typeof record.at === 'number' ? record.at : 0,
      verdict: (record.verdict ?? 'no-anchor') as KtGossipVerdict,
    });
  }
  return out;
}

function parseBlob(value: string | undefined): KtGossipBlob {
  if (!value) return { a: null, p: [] };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { a: null, p: [] };
    const blob = parsed as Partial<KtGossipBlob>;
    return { a: parseHeadAnchor(blob.a) ?? null, p: parseRecords(blob.p) };
  } catch {
    // Baris rusak = tidak ada data; bukan alasan menggagalkan jalur pesan.
    return { a: null, p: [] };
  }
}

/**
 * Buat penyimpan gossip. Satu tulisan per head peer yang **berubah** (dedup
 * berdasarkan `(root, treeSize, verdict)`) supaya pesan beruntun dari peer yang
 * sama tidak menulis IndexedDB setiap kali.
 */
export function createKtGossip(deps: KtGossipDeps): KtGossip {
  const now = deps.now ?? (() => Date.now());
  const maxPeers = deps.maxPeers ?? KT_GOSSIP_MAX_PEERS;
  const log = deps.log ?? (() => {});

  const read = async (): Promise<KtGossipBlob> =>
    parseBlob(await deps.storage.read().catch(() => undefined));

  const write = async (blob: KtGossipBlob): Promise<void> => {
    try {
      await deps.storage.write(JSON.stringify(blob));
    } catch (error) {
      log('kt_gossip_write_failed', { message: (error as Error).message });
    }
  };

  const recordPeerHead = async (peerId: string, head: unknown): Promise<KtGossipVerdict> => {
    const parsed = parseHeadAnchor(head);
    if (!parsed) return 'no-anchor';

    const blob = await read();
    const verdict = evaluateGossipHead(getLocalAnchor() ?? blob.a, parsed);
    const previous = blob.p.find((record) => record.peerId === peerId);
    if (
      previous &&
      previous.verdict === verdict &&
      previous.head.root === parsed.root &&
      previous.head.treeSize === parsed.treeSize
    ) {
      return verdict;
    }

    const record: KtGossipRecord = { peerId, head: parsed, at: now(), verdict };
    const next = [record, ...blob.p.filter((entry) => entry.peerId !== peerId)].slice(0, maxPeers);
    await write({ a: getLocalAnchor() ?? blob.a, p: next });

    if (verdict === 'split-view') {
      log('kt_gossip_split_view', {
        peerId,
        treeSize: parsed.treeSize,
        localRoot: (getLocalAnchor() ?? blob.a)?.root,
        peerRoot: parsed.root,
      });
      deps.onSplitView?.(record);
    }
    return verdict;
  };

  return {
    recordPeerHead,
    async list() {
      return (await read()).p;
    },
    async splitViews() {
      return (await read()).p.filter((record) => record.verdict === 'split-view');
    },
    async forget(peerId: string) {
      const blob = await read();
      const next = blob.p.filter((record) => record.peerId !== peerId);
      if (next.length !== blob.p.length) await write({ a: blob.a, p: next });
    },
    async clear() {
      await write({ a: null, p: [] });
    },
    async setAnchor(anchor: KtHeadAnchor | null) {
      setLocalAnchor(anchor);
      const blob = await read();
      await write({ a: getLocalAnchor(), p: blob.p });
    },
    async loadAnchor() {
      const blob = await read();
      setLocalAnchor(blob.a);
      return getLocalAnchor();
    },
  };
}

// ---------------------------------------------------------------------------
// Instance produksi (Dexie `ktGossip`, nilai ter-seal masterSeed)
// ---------------------------------------------------------------------------

export const KT_GOSSIP_ROW_ID = 'peers';

const dexieStorage: KtGossipStorage = {
  async read(): Promise<string | undefined> {
    const row = await db.ktGossip.get(KT_GOSSIP_ROW_ID);
    if (!row?.blob) return undefined;
    return (await decryptValueAtRest(row.blob)) ?? undefined;
  },
  async write(value: string): Promise<void> {
    await db.ktGossip.put({ id: KT_GOSSIP_ROW_ID, blob: await encryptValueAtRest(value) });
  },
};

let singleton: KtGossip | null = null;

/** Pendengar split-view yang dipasang jalur UI (lazy; hindari siklus impor). */
type SplitViewListener = (record: KtGossipRecord) => void;
const splitViewListeners = new Set<SplitViewListener>();

/** Daftarkan pelapor split-view (dipanggil sekali dari `App.tsx`). */
export function onKtSplitView(listener: SplitViewListener): () => void {
  splitViewListeners.add(listener);
  return () => splitViewListeners.delete(listener);
}

/** Instance gossip produksi (dibuat sekali). */
export function ktGossip(): KtGossip {
  if (!singleton) {
    singleton = createKtGossip({
      storage: dexieStorage,
      log: (event, detail) => {
        try {
          console.warn(`[KT] ${event}`, detail);
        } catch {
          // Log tidak boleh membuat jalur pesan gagal.
        }
      },
      onSplitView: (record) => {
        for (const listener of splitViewListeners) {
          try {
            listener(record);
          } catch {
            // Pelapor yang gagal tidak menghentikan yang lain.
          }
        }
      },
    });
  }
  return singleton;
}

/**
 * Catat head peer dari payload ter-seal. **Fail-open**: gossip adalah sinyal
 * tambahan, bukan syarat pesan bisa dibaca — kesalahan ditelan (setelah dicatat).
 */
export async function recordPeerTreeHead(peerId: string, head: unknown): Promise<KtGossipVerdict> {
  try {
    return await ktGossip().recordPeerHead(peerId, head);
  } catch {
    return 'no-anchor';
  }
}

/** Muat jangkar tersimpan ke cache RAM (sekali per sesi). */
export async function loadStoredAnchor(): Promise<KtHeadAnchor | null> {
  try {
    return await ktGossip().loadAnchor();
  } catch {
    return null;
  }
}

/** Perbarui + persist jangkar lokal (dipanggil setelah verifikasi/monitor). */
export async function storeAnchor(anchor: KtHeadAnchor | null): Promise<void> {
  try {
    await ktGossip().setAnchor(anchor);
  } catch {
    setLocalAnchor(anchor);
  }
}

/**
 * Hapus jangkar + head peer (logout/wipe). Cache RAM dikosongkan lebih dulu
 * supaya jalur kirim berhenti menyisipkan `ktG` walau penulisan gagal.
 */
export async function clearKtGossip(): Promise<void> {
  setLocalAnchor(null);
  try {
    await ktGossip().clear();
  } catch {
    // Baris ikut terhapus bersama IndexedDB saat wipe; kegagalan bukan blocker.
  }
}

/** Hanya untuk test: buang instance produksi. */
export function resetKtGossipForTests(): void {
  singleton = null;
  splitViewListeners.clear();
  resetLocalAnchorForTests();
}
