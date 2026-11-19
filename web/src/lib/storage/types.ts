/**
 * [docs/43 §43.11.6 B1] Kontrak penyimpanan lokal yang tidak bergantung pada
 * Dexie. Implementasi Dexie dipakai selama migrasi; implementasi SQLite
 * menggantikannya di B3.
 *
 * Nilai `kvStore` dibatasi JSON-serializable. Jalur Dexie menyimpan struktur
 * apa pun, tetapi SQLite menyimpan TEXT; membatasi sekarang membuat perbedaan
 * itu terlihat di kontrak, bukan setelah data hilang.
 */

export interface KvItem {
  key: string;
  value: unknown;
}

export interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(item: KvItem): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * Material kunci biner (bukan JSON) di atas `KvStore`.
 *
 * Nilai disimpan sebagai byte opaque; penyegelan at-rest tetap tanggung jawab
 * pemanggil (`ENC1:`/masterSeed). Kontrak ini dipakai keychain untuk kunci
 * database SQLite dan nantinya untuk material kunci lain; jangan menyimpan
 * plaintext kunci di sini.
 */
export interface KeyStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}

/** Baris vault pesan; `payload` SQLite memuat seluruh properti baris. */
export interface MessageRow {
  id: string;
  conversationId: string;
  /** Hanya bucket 15 menit yang boleh dipakai untuk urutan/range. */
  orderBucketMs?: number | null;
  [key: string]: unknown;
}

export interface MessageStore {
  get(id: string): Promise<MessageRow | undefined>;
  put(row: MessageRow): Promise<void>;
  bulkPut(rows: MessageRow[]): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  /** Baris percakapan, urut lama → baru; `limit` mengambil yang terbaru. */
  listByConversation(
    conversationId: string,
    options?: { limit?: number; beforeOrderBucketMs?: number },
  ): Promise<MessageRow[]>;
  /** Semua baris (untuk ekspor/arsip); urutan tidak dijanjikan. */
  listAll(): Promise<MessageRow[]>;
  getMany(ids: string[]): Promise<MessageRow[]>;
  deleteByConversation(conversationId: string): Promise<void>;
}

/**
 * Bucket yang tidak valid disimpan sebagai `null`, bukan dihilangkan, supaya
 * Dexie dan SQLite mengembalikan bentuk baris yang sama. Baris ber-bucket
 * `null` tetap bisa diambil lewat `get`, tetapi tidak masuk `listByConversation`
 * (indeks komposit Dexie juga tidak memuatnya).
 */
export function normalizeMessageRow(row: MessageRow): MessageRow {
  const bucket = typeof row.orderBucketMs === 'number' && Number.isFinite(row.orderBucketMs)
    ? row.orderBucketMs
    : null;
  return { ...row, orderBucketMs: bucket };
}

/** Parameter SQL yang diterima driver; BLOB belum dipakai kontrak ini. */
export type SqlValue = string | number | null | Uint8Array;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * Permukaan minimum yang dibutuhkan store SQLite. Implementasi browser
 * meneruskannya ke worker OPFS lewat RPC; tes kontrak memakai `node:sqlite`.
 * `batch` wajib atomik (satu transaksi) — `bulkPut` bergantung padanya.
 */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  batch(statements: SqlStatement[]): Promise<void>;
}
