/**
 * [docs/43 §43.11.6 B2] Tabel aplikasi non-pesan di `KvStore` SQLite.
 *
 * Nilai disimpan sebagai JSON baris utuh di bawah prefix per tabel, sehingga
 * backup/restore dan pembaca tidak perlu tahu detail kolom. Saat flag mati
 * (atau SQLite gagal dibuka), helper kembali ke tabel Dexie dengan bentuk baris
 * yang sama.
 */
import { db } from '../db';
import { openSqliteKvStore } from './sqliteMessages';
import type { KvStore } from './types';

export type AppTable = 'conversations' | 'profileCache' | 'storyKeys' | 'offlineQueue';

const PREFIX: Record<AppTable, string> = {
  conversations: 'conversation:',
  profileCache: 'profile:',
  storyKeys: 'story:',
  offlineQueue: 'offline:',
};

interface DexieLikeTable<T> {
  get(id: string | number): Promise<T | undefined>;
  put(row: T): Promise<unknown>;
  delete(id: string | number): Promise<void>;
  clear(): Promise<void>;
  toArray(): Promise<T[]>;
  bulkPut(rows: T[]): Promise<unknown>;
}

function dexieTable<T>(table: AppTable): DexieLikeTable<T> {
  return (db as unknown as Record<string, DexieLikeTable<T>>)[table]!;
}

export async function getAppRow<T>(table: AppTable, id: string | number): Promise<T | undefined> {
  const kv = await openSqliteKvStore();
  if (!kv) return dexieTable<T>(table).get(id);
  return kv.get<T>(`${PREFIX[table]}${id}`);
}

export async function putAppRow<T>(table: AppTable, id: string | number, row: T): Promise<void> {
  const kv = await openSqliteKvStore();
  if (!kv) {
    await dexieTable<T>(table).put(row);
    return;
  }
  await kv.put({ key: `${PREFIX[table]}${id}`, value: row });
}

export async function deleteAppRow(table: AppTable, id: string | number): Promise<void> {
  const kv = await openSqliteKvStore();
  if (!kv) {
    await dexieTable(table).delete(id);
    return;
  }
  await kv.delete(`${PREFIX[table]}${id}`);
}

export async function listAppRows<T>(table: AppTable): Promise<T[]> {
  const kv = await openSqliteKvStore();
  if (!kv) return dexieTable<T>(table).toArray();
  const prefix = PREFIX[table];
  const rows: T[] = [];
  for (const key of await kv.keys()) {
    if (!key.startsWith(prefix)) continue;
    const row = await kv.get<T>(key);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

export async function putAppRows<T>(table: AppTable, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  const kv = await openSqliteKvStore();
  if (!kv) {
    await dexieTable<T>(table).bulkPut(rows);
    return;
  }
  for (const row of rows) {
    const id = (row as { id?: string; storyId?: string; tempId?: number }).id
      ?? (row as { storyId?: string }).storyId
      ?? (row as { tempId?: number }).tempId;
    if (id === undefined) throw new TypeError(`Baris ${table} tanpa id`);
    await kv.put({ key: `${PREFIX[table]}${id}`, value: row });
  }
}

export async function clearAppTable(table: AppTable): Promise<void> {
  const kv = await openSqliteKvStore();
  if (!kv) {
    await dexieTable(table).clear();
    return;
  }
  const prefix = PREFIX[table];
  for (const key of await kv.keys()) {
    if (key.startsWith(prefix)) await kv.delete(key);
  }
}

/** Baris mentah untuk backup (tanpa dekripsi). */
export async function readAppTableRows(table: AppTable): Promise<unknown[]> {
  return listAppRows<unknown>(table);
}

/** Tulis baris backup ke backend aktif, mengganti isi tabel. */
export async function replaceAppTableRows(table: AppTable, rows: unknown[]): Promise<void> {
  await clearAppTable(table);
  await putAppRows(table, rows);
}

export type { KvStore };
