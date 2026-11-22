/**
 * [docs/43 §43.11.6 B3] Tabel aplikasi non-pesan di `KvStore` SQLite.
 *
 * Nilai disimpan sebagai JSON baris utuh di bawah prefix per tabel, sehingga
 * backup/restore dan pembaca tidak perlu tahu detail kolom. Tidak ada backend
 * kedua: kegagalan membuka SQLite diteruskan ke pemanggil.
 */
import { openSqliteKvStore } from './sqliteMessages';
import type { KvStore } from './types';

export type AppTable = 'conversations' | 'profileCache' | 'storyKeys' | 'offlineQueue';

const PREFIX: Record<AppTable, string> = {
  conversations: 'conversation:',
  profileCache: 'profile:',
  storyKeys: 'story:',
  offlineQueue: 'offline:',
};

async function openKv(): Promise<KvStore> {
  return openSqliteKvStore();
}

export async function getAppRow<T>(table: AppTable, id: string | number): Promise<T | undefined> {
  const kv = await openKv();
  return kv.get<T>(`${PREFIX[table]}${id}`);
}

export async function putAppRow<T>(table: AppTable, id: string | number, row: T): Promise<void> {
  const kv = await openKv();
  await kv.put({ key: `${PREFIX[table]}${id}`, value: row });
}

export async function deleteAppRow(table: AppTable, id: string | number): Promise<void> {
  const kv = await openKv();
  await kv.delete(`${PREFIX[table]}${id}`);
}

export async function listAppRows<T>(table: AppTable): Promise<T[]> {
  const kv = await openKv();
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
  await kv.deleteByPrefix(PREFIX[table]);
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
