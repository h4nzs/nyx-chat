// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 4 / docs/31 §31.6c] Orkestrasi restore `.nyxbak` di
 * perangkat pengganti.
 *
 * Modul ini adalah "lem" antara tiga lapisan yang sudah ada:
 *   - `backupFormat`  → bentuk byte arsip (header, padding, AEAD, AAD),
 *   - `backupPayload` → pemetaan tabel Keychain ↔ frame,
 *   - `db` (Dexie)    → penyimpanan nyata.
 *
 * Yang dilakukan di sini: membaca tabel dari penyimpanan, membangun arsip, dan
 * (arah sebaliknya) mem-parse arsip lalu menulisnya kembali ke penyimpanan —
 * dengan **progres per frame** dan **laporan ukuran** yang bisa ditampilkan UI.
 *
 * Kenapa `BackupStore` disuntikkan (bukan langsung `db`): test tidak boleh
 * butuh IndexedDB (aturan repo — unit test tanpa Postgres/Redis/IDB). Logika
 * di sini diuji dengan store palsu; adapter Dexie nyata hanya disentuh lewat
 * `liveBackupStore()` yang memuat `./db` secara **dinamis**, sehingga mengimpor
 * modul ini tidak pernah meng-instansiasi Dexie di lingkungan test.
 *
 * Catatan kunci: arsip ber-frame **tidak** menentukan asal kunci. Dua jalur
 * sah (lihat `docs/31` §31.6c):
 *   - **Transfer langsung (`migration:*`)** — kunci acak 32 byte yang di-seal
 *     ke kunci publik penerima (QR); tidak perlu recovery phrase di perangkat
 *     lama.
 *   - **Berkas manual** — kunci dari recovery phrase lewat `openFramedBackupWithPhrase`.
 * Di kedua jalur bentuk byte arsip identik.
 */

import {
  BACKUP_KDF_PARAMS,
  BackupFormatError,
  buildBackupArchive,
  deriveBackupKey,
  parseBackupArchive,
  readBackupHeader,
  type BackupCryptoBackend,
  type BackupKdfParams,
} from './backupFormat';
import {
  BACKUP_TABLE_ORDER,
  buildBackupFrames,
  readBackupChunk,
  type BackupValueCodec,
} from './backupPayload';

/** Callback progres: `done` dari `total` unit (frame atau tabel). */
export type BackupProgress = (done: number, total: number) => void;

/**
 * Normalisasi recovery phrase sebelum dipakai sebagai KDF input: `trim` +
 * `lowercase`. Satu implementasi supaya **export dan restore tidak bisa
 * menyimpang** — arsip yang dibuat dari phrase "Legal Winner Thank  " dan
 * direstore dengan "legal winner thank" harus membuka kunci yang sama.
 * (`deriveBackupKey` menambahkan normalisasi NFKD di atas ini.)
 */
export function normalizeBackupPhrase(phrase: string): string {
  return phrase.trim().toLowerCase();
}

/**
 * Kontrak penyimpanan yang dibutuhkan restore/build. Implementasi nyata ada di
 * `readTablesFromDexie`/`writeTablesToDexie`; test memakai objek sederhana.
 */
export interface BackupStore {
  readTables(
    tables?: readonly string[],
    onProgress?: BackupProgress
  ): Promise<Record<string, unknown[]>>;
  writeTables(
    recordsByTable: Record<string, unknown[]>,
    onProgress?: BackupProgress
  ): Promise<void>;
}

/** Laporan setelah arsip dibangun — cukup untuk UI menampilkan ukuran + isi. */
export interface CreateBackupReport {
  bytes: Uint8Array;
  salt: Uint8Array;
  /** Ukuran arsip final (byte) — angka yang diunggah/disimpan. */
  size: number;
  frameCount: number;
  /** Jumlah catatan yang ikut backup (semua tabel). */
  records: number;
  /** Jumlah catatan per tabel (hanya tabel yang tidak kosong). */
  tables: Record<string, number>;
}

/** Laporan setelah restore — untuk "database dipulihkan: N pesan, M kontak, …". */
export interface RestoreBackupReport {
  formatVersion: number;
  frameCount: number;
  size: number;
  records: number;
  tables: Record<string, number>;
}

export interface CreateBackupOptions {
  store: BackupStore;
  /** Kunci backup 32 byte (acak untuk transfer, atau `deriveBackupKey` untuk berkas). */
  key: Uint8Array;
  crypto: BackupCryptoBackend;
  codec: BackupValueCodec;
  salt?: Uint8Array;
  /** Acak deterministik urutan frame (anti-pola struktur sosial). Default `true`. */
  scramble?: boolean;
  chunkBytes?: number;
  tables?: readonly string[];
  onProgress?: BackupProgress;
}

/**
 * Baca seluruh tabel backup dari penyimpanan, bangun frame (`backupPayload`),
 * lalu kemas menjadi arsip ber-frame terenkripsi (`backupFormat`).
 *
 * Tabel kosong tidak menghasilkan frame (lihat `buildBackupFrames`), jadi
 * `frameCount` bisa lebih kecil dari jumlah tabel. Bila tidak ada satu pun
 * catatan, `BackupFormatError` dilempar oleh `buildBackupFrames` — restore
 * arsip kosong tidak boleh "berhasil" diam-diam.
 */
export async function createFramedBackup(opts: CreateBackupOptions): Promise<CreateBackupReport> {
  const tables = opts.tables ?? BACKUP_TABLE_ORDER;
  const recordsByTable = await opts.store.readTables(tables, opts.onProgress);

  const frames = buildBackupFrames({
    recordsByTable,
    codec: opts.codec,
    chunkBytes: opts.chunkBytes,
    key: opts.key,
    scramble: opts.scramble ?? true,
  });

  const archive = buildBackupArchive({
    frames,
    key: opts.key,
    crypto: opts.crypto,
    salt: opts.salt,
  });

  const tableCounts: Record<string, number> = {};
  let records = 0;
  for (const [table, rows] of Object.entries(recordsByTable)) {
    if (!rows || rows.length === 0) continue;
    tableCounts[table] = rows.length;
    records += rows.length;
  }

  return {
    bytes: archive.bytes,
    salt: archive.salt,
    size: archive.bytes.length,
    frameCount: frames.length,
    records,
    tables: tableCounts,
  };
}

export interface RestoreBackupOptions {
  store: BackupStore;
  bytes: Uint8Array;
  key: Uint8Array;
  crypto: BackupCryptoBackend;
  codec: BackupValueCodec;
  onProgress?: BackupProgress;
}

/**
 * Verifikasi + dekripsi arsip, lalu tulis ulang isinya ke penyimpanan.
 *
 * Urutan pertahanan (gagal sebelum menulis apa pun):
 *   1. `readBackupHeader` — magic/versi/panjang (tanpa kunci),
 *   2. `parseBackupArchive` — AAD per frame: tamper/reorder/truncate/kunci salah,
 *   3. `readBackupChunk` per frame — bentuk payload (tabel dikenal, tipe cocok),
 *   4. baru `store.writeTables` menyentuh database.
 *
 * Progres dilaporkan **per frame** saat dekode (langkah 3). Penulisan database
 * mengikuti setelahnya; bila gagal di tengah, error diteruskan apa adanya
 * (UI tidak boleh menampilkan "selesai").
 */
export async function restoreFramedBackup(opts: RestoreBackupOptions): Promise<RestoreBackupReport> {
  const { frameCount, formatVersion } = readBackupHeader(opts.bytes);
  const { frames } = parseBackupArchive(opts.bytes, opts.key, opts.crypto);

  const recordsByTable: Record<string, unknown[]> = {};
  const tableCounts: Record<string, number> = {};
  let records = 0;

  for (let i = 0; i < frames.length; i++) {
    const chunk = readBackupChunk(frames[i]!, opts.codec);
    if (!recordsByTable[chunk.table]) recordsByTable[chunk.table] = [];
    recordsByTable[chunk.table]!.push(...chunk.records);
    records += chunk.records.length;
    tableCounts[chunk.table] = (tableCounts[chunk.table] ?? 0) + chunk.records.length;
    opts.onProgress?.(i + 1, frames.length);
  }

  await opts.store.writeTables(recordsByTable);

  return {
    formatVersion,
    frameCount,
    size: opts.bytes.length,
    records,
    tables: tableCounts,
  };
}

export interface OpenBackupWithPhraseOptions {
  store: BackupStore;
  bytes: Uint8Array;
  /** Recovery phrase BIP39 milik akun. */
  phrase: string;
  crypto: BackupCryptoBackend;
  codec: BackupValueCodec;
  /** Hanya untuk test (KDF kecil); produksi memakai default `BACKUP_KDF_PARAMS`. */
  params?: BackupKdfParams;
  onProgress?: BackupProgress;
}

/**
 * Restore berkas `.nyxbak` **tanpa perangkat lama** (jalur manual): baca salt
 * dari header, turunkan kunci dari recovery phrase, lalu restore. Salt dibaca
 * tanpa kunci sehingga KDF hanya dijalankan sekali dengan parameter header.
 */
export async function openFramedBackupWithPhrase(
  opts: OpenBackupWithPhraseOptions
): Promise<RestoreBackupReport> {
  const { salt } = readBackupHeader(opts.bytes);
  const key = await deriveBackupKey(
    normalizeBackupPhrase(opts.phrase),
    salt,
    opts.params ?? BACKUP_KDF_PARAMS
  );
  return restoreFramedBackup({
    store: opts.store,
    bytes: opts.bytes,
    key,
    crypto: opts.crypto,
    codec: opts.codec,
    onProgress: opts.onProgress,
  });
}

/** Bentuk Dexie yang dibutuhkan — struktural supaya test bisa memakai objek palsu. */
export interface BackupDexieLike {
  table(name: string): {
    toArray(): Promise<unknown[]>;
    clear(): Promise<void>;
    bulkPut(items: unknown[]): Promise<unknown>;
  };
  transaction(
    mode: string,
    tables: ReadonlyArray<unknown>,
    scope: () => Promise<void>
  ): Promise<unknown>;
}

/** Baca tabel dari Dexie. Urutan mengikuti `tables` (deterministik). */
export async function readTablesFromDexie(
  database: BackupDexieLike,
  tables: readonly string[] = BACKUP_TABLE_ORDER,
  onProgress?: BackupProgress
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (let i = 0; i < tables.length; i++) {
    out[tables[i]!] = await database.table(tables[i]!).toArray();
    onProgress?.(i + 1, tables.length);
  }
  return out;
}

/**
 * Tulis hasil restore ke Dexie dalam **satu transaksi** `rw`: untuk setiap tabel
 * yang hadir di backup, `clear()` lalu `bulkPut()`. Tabel yang tidak muncul di
 * backup **tidak** disentuh — pada perangkat pengganti yang masih kosong itu
 * titik awal yang benar, dan untuk restore di atas state lama kita sengaja tidak
 * menghapus data yang tidak ada di backup (lebih aman daripada menghapus tanpa
 * sinyal).
 */
export async function writeTablesToDexie(
  database: BackupDexieLike,
  recordsByTable: Record<string, unknown[]>,
  onProgress?: BackupProgress
): Promise<void> {
  const targets = (Object.keys(recordsByTable) as string[]).filter(
    (table) => (recordsByTable[table]?.length ?? 0) > 0
  );
  if (targets.length === 0) return;

  const dexieTables = targets.map((table) => database.table(table));
  await database.transaction('rw', dexieTables, async () => {
    for (let i = 0; i < targets.length; i++) {
      const table = dexieTables[i]!;
      await table.clear();
      await table.bulkPut(recordsByTable[targets[i]!]!);
      onProgress?.(i + 1, targets.length);
    }
  });
}

/**
 * Store produksi di atas `./db`. Diimpor **dinamis** supaya modul ini tetap
 * aman di lingkungan test tanpa IndexedDB.
 */
export async function liveBackupStore(): Promise<BackupStore> {
  const { db } = await import('./db');
  const database = db as unknown as BackupDexieLike;
  return {
    readTables: (tables, onProgress) => readTablesFromDexie(database, tables, onProgress),
    writeTables: async (recordsByTable, onProgress) => {
      await writeTablesToDexie(database, recordsByTable, onProgress);
      // [docs/30 WS-F] Arsip dari klien pra-v9 membawa baris pesan **tanpa**
      // `orderBucketMs`; `bulkPut` mentah membuatnya tak muncul di indeks
      // `[conversationId+orderBucketMs]` (tersimpan, tapi tak pernah tampil di
      // query berpaginasi). Rapikan sekali setelah tulis — idempoten, jadi
      // arsip dari klien baru hanya lewat tanpa perubahan.
      if ((recordsByTable.messages?.length ?? 0) > 0) {
        const { shadowVault } = await import('./shadowVaultDb');
        const repaired = await shadowVault.normalizeOrderIndex();
        if (repaired > 0) console.log(`[Backup] order index repaired for ${repaired} messages`);
      }
    },
  };
}

/** Ukuran rata-rata frame (byte) — dipakai laporan "arsip 3.1 MB / 42 frame". */
export function averageFrameBytes(report: { size: number; frameCount: number }): number {
  if (report.frameCount <= 0) return 0;
  return Math.round(report.size / report.frameCount);
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** Format ukuran byte untuk UI (mis. `1.24 MB`). Bukan untuk parsing. */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new BackupFormatError('Ukuran backup tidak sah');
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${SIZE_UNITS[unit]}`;
}
