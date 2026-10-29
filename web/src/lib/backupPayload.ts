// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 2 / docs/31 §31.6] Pengaitan payload: memetakan tabel
 * Keychain (IndexedDB `NyxUnifiedDB`) menjadi frame `backupFormat`, dan kembali.
 *
 * Pembagian tugas:
 *   - `backupFormat.ts` mengurus **bentuk byte** arsip (header, padding, AEAD,
 *     AAD anti-tamper/reorder/truncate). Tidak tahu apa pun soal isi.
 *   - modul ini mengurus **isi**: tabel mana masuk frame bertipe apa, urutan
 *     deterministik, pemecahan (chunking) supaya frame count tidak melampaui
 *     batas header, dan scramble agar frame bertipe sama tidak berurutan
 *     menurut struktur sosial.
 *
 * Yang TIDAK dilakukan di sini (sengaja):
 *   - Tidak mendekripsi nilai at-rest (`ENC1:`). Backup memuat ciphertext apa
 *     adanya; kuncinya (`masterSeed`) berasal dari recovery phrase yang sama,
 *     jadi nilai tetap terbaca di perangkat pengganti. Mendekripsi di sini akan
 *     membuat backup bergantung pada state hidup dan justru memperlebar
 *     plaintext di memori.
 *   - Tidak menyentuh server/R2 (fase 3) atau UX restore (fase 4).
 *
 * Determinisme adalah properti yang diuji: `buildBackupFrames` yang diberi
 * himpunan catatan sama (urutan masukan apa pun) menghasilkan frame identik,
 * sehingga `export(restore(backup))` byte-identik.
 */

import {
  BACKUP_MAX_FRAMES,
  BACKUP_MAX_PAYLOAD_BYTES,
  BackupFormatError,
  type BackupFrameInput,
  type BackupFrameOutput,
  BackupFrameType,
} from './backupFormat';

/** Kodek byte ↔ string. Produksi memakai base64url libsodium (pola `ENC1:`, `__type` lama). */
export interface BackupValueCodec {
  encodeBytes(bytes: Uint8Array): string;
  decodeBytes(text: string): Uint8Array;
}

/** Bentuk sodium yang dibutuhkan — struktural supaya tidak mengikat tipe paket. */
export interface SodiumBase64Like {
  to_base64(data: Uint8Array, variant?: number): string;
  from_base64(data: string, variant?: number): Uint8Array;
  base64_variants: { URLSAFE_NO_PADDING: number };
}

/**
 * Adapter libsodium → `BackupValueCodec`. Satu implementasi dipakai produksi
 * (worker) dan test, jadi encoding yang diuji = encoding yang dikirim.
 */
export function libsodiumBackupValueCodec(sodium: SodiumBase64Like): BackupValueCodec {
  return {
    encodeBytes: (bytes) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING),
    decodeBytes: (text) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING),
  };
}

/** Penanda nilai biner/Date di dalam payload JSON (kompatibel dengan ekspor JSON lama). */
const TAGGED_UINT8 = 'Uint8Array';
const TAGGED_DATE = 'Date';

/** Kedalaman maksimum struktur nilai — mencegah payload rekursif membekukan tab. */
const MAX_VALUE_DEPTH = 32;

/** Ukuran blok chunk default (byte JSON). 256 KB → 65.535 frame ≈ 16 GB payload. */
export const BACKUP_CHUNK_BYTES = 256 * 1024;

/**
 * Tabel yang ikut backup, dipetakan ke tipe frame. Urutan array = urutan
 * deterministik pembuatan frame (sebelum scramble). Sumber daftar: `db.ts`
 * (`NyxUnifiedDB` versi 8). Sejak 2026-10-29 daftar ini adalah **satu-satunya**
 * jalur backup — export JSON lama (`.nyxvault`) sudah dihapus (docs/31 §31.6).
 */
export const BACKUP_TABLE_FRAME_TYPE: Readonly<Record<string, BackupFrameType>> = {
  // Account — identitas & sesi kripto perangkat.
  identityKeys: BackupFrameType.Account,
  preKeys: BackupFrameType.Account,
  sessionKeys: BackupFrameType.Account,
  ratchetSessions: BackupFrameType.Account,
  pqDrSessionsV2: BackupFrameType.Account,
  // Contacts — satu-satunya daftar "pernah bertukar pesan".
  contacts: BackupFrameType.Contacts,
  // Conversation — percakapan + state grup.
  conversations: BackupFrameType.Conversation,
  groupKeys: BackupFrameType.Conversation,
  groupSenderStates: BackupFrameType.Conversation,
  groupReceiverStates: BackupFrameType.Conversation,
  groupSkippedKeys: BackupFrameType.Conversation,
  groupCachedParticipants: BackupFrameType.Conversation,
  // Message — pesan, kunci pesan, antrean, header tertunda.
  messages: BackupFrameType.Message,
  messageKeys: BackupFrameType.Message,
  skippedKeys: BackupFrameType.Message,
  pendingHeaders: BackupFrameType.Message,
  offlineQueue: BackupFrameType.Message,
  // Story — kunci story (isi cerita terenkripsi di kolom pesan).
  storyKeys: BackupFrameType.Story,
  // Settings — KV + cache profil.
  kvStore: BackupFrameType.Settings,
  profileCache: BackupFrameType.Settings,
};

/** Urutan tabel yang stabil & dapat direproduksi. */
export const BACKUP_TABLE_ORDER: readonly string[] = Object.keys(BACKUP_TABLE_FRAME_TYPE);

/**
 * Path kunci primer per tabel (sama dengan keyPath Dexie di `db.ts`). Dipakai
 * untuk pengurutan deterministik; tabel tanpa kunci ini ditolak.
 */
export const BACKUP_TABLE_KEY_PATH: Readonly<Record<string, string>> = {
  messages: 'id',
  messageKeys: 'messageId',
  storyKeys: 'storyId',
  offlineQueue: 'tempId',
  identityKeys: 'userId',
  groupReceiverStates: 'id',
  groupSkippedKeys: 'key',
  sessionKeys: 'storageKey',
  groupKeys: 'conversationId',
  preKeys: 'keyId',
  ratchetSessions: 'conversationId',
  groupSenderStates: 'conversationId',
  skippedKeys: 'headerKey',
  pendingHeaders: 'conversationId',
  pqDrSessionsV2: 'id',
  kvStore: 'key',
  contacts: 'userId',
  conversations: 'id',
  profileCache: 'id',
  groupCachedParticipants: 'conversationId',
};

/** Tipe frame yang boleh muncul di arsip (Tombstone dicadangkan, belum diproduksi). */
const KNOWN_FRAME_TYPES = new Set<number>([
  BackupFrameType.Account,
  BackupFrameType.Contacts,
  BackupFrameType.Conversation,
  BackupFrameType.Message,
  BackupFrameType.Story,
  BackupFrameType.Settings,
  BackupFrameType.Tombstone,
]);

/**
 * UTF-8 encoder yang mengembalikan array dari realm yang sama.
 *
 * Bukan preferensi gaya: di lingkungan jsdom/vitest `TextEncoder().encode()`
 * mengembalikan `Uint8Array` realm lain dan libsodium menolaknya
 * (`unsupported input type ...`, pengecekan pakai `instanceof`). `new
 * Uint8Array(raw)` menyalin ke realm lokal; di browser array sudah lokal
 * sehingga tidak ada salinan tambahan. Alasan yang sama didokumentasikan di
 * `backupFormat.ts` §31.5 untuk AAD/magic.
 */
function utf8Encode(text: string): Uint8Array {
  const raw = new TextEncoder().encode(text);
  return raw.constructor === Uint8Array ? raw : new Uint8Array(raw);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Encode nilai Dexie ke JSON-safe secara rekursif, mempertahankan `Uint8Array`,
 * `ArrayBuffer`, dan `Date` lewat penanda `__type` (pola ekspor JSON lama).
 * Tipe tak terdukung (function/symbol/bigint) ditolak keras — bukan dibuang
 * diam-diam, karena backup yang "berhasil" tapi kehilangan field adalah bug
 * yang baru terlihat saat restore.
 *
 * Catatan: `isPlainObject` tidak dipakai di sini; kita memetakan semua objek
 * enumerable. Nilai `undefined` mengikuti perilaku `JSON.stringify` (field
 * hilang) — sama seperti ekspor lama, jadi tidak ada regresi bentuk.
 */
export function encodeBackupValue(value: unknown, codec: BackupValueCodec, depth = 0): unknown {
  if (depth > MAX_VALUE_DEPTH) throw new BackupFormatError('Struktur payload terlalu dalam');
  if (value === null || value === undefined) return value;
  if (value instanceof ArrayBuffer) {
    return { __type: TAGGED_UINT8, data: codec.encodeBytes(new Uint8Array(value)) };
  }
  // `ArrayBuffer.isView` (BUKAN `value instanceof Uint8Array`): di lingkungan
  // jsdom/vitest typed array bisa berasal dari realm lain, dan `instanceof`
  // gagal di sana — nilai biner lalu salah dikodekan sebagai objek berkunci
  // angka `{0:..,1:..}`. Alasan yang sama dengan encoder UTF-8 di bawah.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      __type: TAGGED_UINT8,
      data: codec.encodeBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    };
  }
  if (value instanceof Date) return { __type: TAGGED_DATE, data: value.toISOString() };
  if (Array.isArray(value)) return value.map((item) => encodeBackupValue(item, codec, depth + 1));

  const type = typeof value;
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new BackupFormatError(`Tipe nilai tidak didukung backup: ${type}`);
  }
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encodeBackupValue(item, codec, depth + 1);
    }
    return out;
  }
  return value;
}

/** Kebalikan `encodeBackupValue`. Bentuk tak dikenal dilempar (bukan diteruskan apa adanya). */
export function decodeBackupValue(value: unknown, codec: BackupValueCodec, depth = 0): unknown {
  if (depth > MAX_VALUE_DEPTH) throw new BackupFormatError('Struktur payload terlalu dalam');
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => decodeBackupValue(item, codec, depth + 1));

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.__type === TAGGED_UINT8) {
      if (typeof record.data !== 'string') throw new BackupFormatError('Nilai Uint8Array tanpa data');
      return codec.decodeBytes(record.data);
    }
    if (record.__type === TAGGED_DATE) {
      if (typeof record.data !== 'string') throw new BackupFormatError('Nilai Date tanpa data');
      const date = new Date(record.data);
      if (Number.isNaN(date.getTime())) throw new BackupFormatError('Nilai Date tidak sah');
      return date;
    }
    if ('__type' in record) throw new BackupFormatError(`Penanda nilai tidak dikenal: ${String(record.__type)}`);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      out[key] = decodeBackupValue(item, codec, depth + 1);
    }
    return out;
  }
  return value;
}

/** Kunci primer catatan, untuk pengurutan deterministik. */
function recordSortKey(table: string, record: unknown): string {
  const keyPath = BACKUP_TABLE_KEY_PATH[table]!;
  const value = (record as Record<string, unknown> | null)?.[keyPath];
  if (value === undefined || value === null) {
    throw new BackupFormatError(`Catatan tanpa kunci '${keyPath}' di tabel '${table}'`);
  }
  return typeof value === 'number' ? `#${String(value).padStart(16, '0')}` : `s${String(value)}`;
}

/** Satu potongan (chunk) payload untuk sebuah tabel. */
export interface BackupChunk {
  table: string;
  records: unknown[];
}

export interface BuildBackupFramesOptions {
  /** Catatan per nama tabel Dexie (nilai mentah dari `table.toArray()`). */
  recordsByTable: Record<string, unknown[] | undefined>;
  codec: BackupValueCodec;
  /** Ambang ukuran JSON satu chunk (byte); default `BACKUP_CHUNK_BYTES`. */
  chunkBytes?: number;
  /** Kunci backup; wajib bila `scramble` aktif. */
  key?: Uint8Array;
  /** Acak deterministik urutan frame (anti-pola struktur sosial). Default `false`. */
  scramble?: boolean;
}

/**
 * Ubah catatan per tabel menjadi `BackupFrameInput[]`.
 *
 * - Tabel tak dikenal → `BackupFormatError` (bukan diam-diam dibuang).
 * - Catatan diurutkan berdasarkan kunci primer (angka & string dibedakan),
 *   sehingga urutan masukan tidak memengaruhi hasil.
 * - Bila `scramble` aktif, urutan frame dipermutasi deterministik memakai
 *   `sha256(key || tipe || isi)`; restore tidak peduli urutan (dikelompokkan
 *   per tabel), dan ekspor ulang dari state hasil restore mereproduksi urutan
 *   yang sama.
 */
export function buildBackupFrames(opts: BuildBackupFramesOptions): BackupFrameInput[] {
  const { recordsByTable, codec } = opts;
  const chunkBytes = opts.chunkBytes ?? BACKUP_CHUNK_BYTES;
  if (!Number.isFinite(chunkBytes) || chunkBytes < 128) {
    throw new BackupFormatError('Ambang chunk terlalu kecil');
  }

  for (const table of Object.keys(recordsByTable)) {
    if (recordsByTable[table] === undefined) continue;
    if (!(table in BACKUP_TABLE_FRAME_TYPE)) {
      throw new BackupFormatError(`Tabel tidak dikenal untuk backup: ${table}`);
    }
  }

  const frames: BackupFrameInput[] = [];

  for (const table of BACKUP_TABLE_ORDER) {
    const records = recordsByTable[table];
    if (!records || records.length === 0) continue;
    const type = BACKUP_TABLE_FRAME_TYPE[table]!;
    const sorted = records
      .map((record) => ({ record, sortKey: recordSortKey(table, record) }))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
      .map((entry) => entry.record);

    let chunk: unknown[] = [];
    let chunkSize = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      const payload: BackupChunk = { table, records: chunk };
      frames.push({ type, payload: utf8Encode(JSON.stringify(payload)) });
      chunk = [];
      chunkSize = 0;
    };

    for (const record of sorted) {
      // Chunk memuat bentuk TERENKODE, bukan catatan mentah — `JSON.stringify`
      // atas `Uint8Array`/`Date` mentah akan merusaknya (typed array jadi objek
      // berkunci angka, Date jadi string lalu hilang saat restore). Ukuran pun
      // dihitung dari bentuk yang benar-benar ditulis.
      const encoded = encodeBackupValue(record, codec);
      const size = JSON.stringify(encoded).length;
      if (size > BACKUP_MAX_PAYLOAD_BYTES) {
        throw new BackupFormatError(`Catatan di '${table}' terlalu besar untuk satu frame`);
      }
      if (chunk.length > 0 && chunkSize + size > chunkBytes) flush();
      chunk.push(encoded);
      chunkSize += size;
    }
    flush();
  }

  if (frames.length === 0) throw new BackupFormatError('Tidak ada catatan untuk di-backup');
  if (frames.length > BACKUP_MAX_FRAMES) {
    throw new BackupFormatError(
      `Terlalu banyak frame (${frames.length} > ${BACKUP_MAX_FRAMES}); naikkan ambang chunk`
    );
  }

  return opts.scramble ? scrambleBackupFrames(frames, opts.key) : frames;
}

/**
 * Permutasi deterministik frame memakai kunci backup. Bukan batas keamanan
 * (integritas tetap dari AEAD); tujuannya agar frame bertipe sama tidak
 * tersusun menurut struktur sosial — lihat §31.6 dan referensi scramble
 * `message-backup` Signal.
 *
 * Batasan yang jujur: `frameCount` ada di header **plaintext**, jadi jumlah
 * total frame tetap terlihat. Yang disembunyikan hanyalah pengelompokan
 * (frame bertipe sama yang berdampingan). Header yang menyembunyikan jumlah
 * frame akan mengubah tata letak format → NA `formatVersion`.
 */
export function scrambleBackupFrames(frames: BackupFrameInput[], key?: Uint8Array): BackupFrameInput[] {
  if (!key || key.length === 0) throw new BackupFormatError('Scramble butuh kunci backup');
  const out = frames.slice();
  // Seed PRNG dari kunci (FNV-1a) + jumlah frame. Fisher-Yates deterministik:
  // himpunan frame yang sama + kunci yang sama → urutan yang sama, sehingga
  // ekspor ulang dari state hasil restore byte-identik.
  let state = 0x811c9dc5;
  for (const byte of key) {
    state ^= byte;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  state ^= out.length >>> 0;
  const next = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Baca SATU frame hasil `parseBackupArchive` menjadi chunk tabel.
 *
 * Dipisah dari `readBackupChunks` supaya restore (fase 4) bisa memproses dan
 * melaporkan progres **per frame** tanpa menduplikasi validasi: keduanya
 * memakai implementasi ini. Satu frame = satu chunk (lihat `buildBackupFrames`).
 */
export function readBackupChunk(frame: BackupFrameOutput, codec: BackupValueCodec): BackupChunk {
  if (!KNOWN_FRAME_TYPES.has(frame.type)) {
    throw new BackupFormatError(`Jenis frame tidak dikenal: ${frame.type}`);
  }
  if (frame.payload.length > BACKUP_MAX_PAYLOAD_BYTES) {
    throw new BackupFormatError('Payload frame melebihi batas');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(frame.payload));
  } catch {
    throw new BackupFormatError('Payload frame bukan JSON yang sah');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupFormatError('Payload frame bukan objek chunk');
  }
  const chunk = parsed as { table?: unknown; records?: unknown };
  if (typeof chunk.table !== 'string' || !(chunk.table in BACKUP_TABLE_FRAME_TYPE)) {
    throw new BackupFormatError(`Chunk menunjuk tabel tidak dikenal: ${String(chunk.table)}`);
  }
  if (!Array.isArray(chunk.records)) throw new BackupFormatError('Chunk tanpa daftar records');
  const expectedType = BACKUP_TABLE_FRAME_TYPE[chunk.table]!;
  if (frame.type !== expectedType) {
    throw new BackupFormatError(`Tipe frame tidak cocok dengan tabel '${chunk.table}'`);
  }
  return {
    table: chunk.table,
    records: chunk.records.map((record) => decodeBackupValue(record, codec)),
  };
}

/**
 * Kebalikan `buildBackupFrames`: baca frame hasil `parseBackupArchive` menjadi
 * chunk per tabel. Urutan frame tidak dipakai untuk keperluan isi.
 */
export function readBackupChunks(frames: BackupFrameOutput[], codec: BackupValueCodec): BackupChunk[] {
  return frames.map((frame) => readBackupChunk(frame, codec));
}

/** Kelompokkan chunk menjadi catatan per tabel, siap `bulkPut` (tabel di-clear dulu oleh pemanggil). */
export function chunksToRecordsByTable(chunks: BackupChunk[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const chunk of chunks) {
    if (!out[chunk.table]) out[chunk.table] = [];
    out[chunk.table]!.push(...chunk.records);
  }
  return out;
}
