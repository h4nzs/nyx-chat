/**
 * [docs/43 §43.11.6 B3] Tabel aplikasi non-pesan di `KvStore` SQLite.
 *
 * Nilai disimpan sebagai JSON baris utuh di bawah prefix per tabel, sehingga
 * backup/restore dan pembaca tidak perlu tahu detail kolom. Jalur Dexie hanya
 * dipakai tes jsdom setelah SQLite gagal dibuka.
 */
import { openSqliteKvStore } from './sqliteMessages';
import { useDexieTestFallback } from './testFallback';
import type { KvStore } from './types';

export type AppTable = 'conversations' | 'profileCache' | 'storyKeys' | 'offlineQueue';

const PREFIX: Record<AppTable, string> = {
  conversations: 'conversation:',
  profileCache: 'profile:',
  storyKeys: 'story:',
  offlineQueue: 'offline:',
};

interface DexieTableLike {
  get(id: string | number): Promise<unknown>;
  put(row: unknown): Promise<unknown>;
  delete(id: string | number): Promise<unknown>;
  toArray(): Promise<unknown[]>;
  bulkPut(rows: unknown[]): Promise<unknown>;
  clear(): Promise<unknown>;
}

async function dexieTable(table: AppTable): Promise<DexieTableLike> {
  const { db } = await import('../db');
  return db[table] as unknown as DexieTableLike;
}

/** `null` hanya di Vitest; produksi meneruskan kegagalan SQLite. */
async function openKv(): Promise<KvStore | null> {
  try {
    return await openSqliteKvStore();
  } catch (error) {
    if (!useDexieTestFallback()) throw error;
    return null;
  }
}

export async function getAppRow<T>(table: AppTable, id: string | number): Promise<T | undefined> {
  const kv = await openKv();
  if (kv) return kv.get<T>(`${PREFIX[table]}${id}`);
  return (await (await dexieTable(table)).get(id)) as T | undefined;
}

export async function putAppRow<T>(table: AppTable, id: string | number, row: T): Promise<void> {
  const kv = await openKv();
  if (kv) {
    await kv.put({ key: `${PREFIX[table]}${id}`, value: row });
    return;
  }
  await (await dexieTable(table)).put(row);
}

export async function deleteAppRow(table: AppTable, id: string | number): Promise<void> {
  const kv = await openKv();
  if (kv) {
    await kv.delete(`${PREFIX[table]}${id}`);
    return;
  }
  await (await dexieTable(table)).delete(id);
}

export async function listAppRows<T>(table: AppTable): Promise<T[]> {
  const kv = await openKv();
  if (!kv) return (await (await dexieTable(table)).toArray()) as T[];
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
  const kv = await openKv();
  if (!kv) {
    await (await dexieTable(table)).bulkPut(rows);
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
  const kv = await openKv();
  if (kv) {
    await kv.deleteByPrefix(PREFIX[table]);
    return;
  }
  await (await dexieTable(table)).clear();
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
