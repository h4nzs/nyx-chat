/**
 * [docs/43 §43.11.6 B3] Tabel aplikasi non-pesan di `KvStore` SQLite.
 *
 * Nilai disimpan sebagai JSON baris utuh di bawah prefix per tabel, sehingga
 * backup/restore dan pembaca tidak perlu tahu detail kolom. Dexie sudah tidak
 * dipakai: tidak ada jalur cadangan per-tabel lagi.
 */
import { getKvStore } from './appKv';
import type { KvStore } from './types';

export type AppTable = 'conversations' | 'profileCache' | 'storyKeys' | 'offlineQueue';

const PREFIX: Record<AppTable, string> = {
  conversations: 'conversation:',
  profileCache: 'profile:',
  storyKeys: 'story:',
  offlineQueue: 'offline:',
};

export async function getAppRow<T>(table: AppTable, id: string | number): Promise<T | undefined> {
  return (await getKvStore()).get<T>(`${PREFIX[table]}${id}`);
}

export async function putAppRow<T>(table: AppTable, id: string | number, row: T): Promise<void> {
  await (await getKvStore()).put({ key: `${PREFIX[table]}${id}`, value: row });
}

export async function deleteAppRow(table: AppTable, id: string | number): Promise<void> {
  await (await getKvStore()).delete(`${PREFIX[table]}${id}`);
}

export async function listAppRows<T>(table: AppTable): Promise<T[]> {
  const kv = await getKvStore();
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
  const kv = await getKvStore();
  for (const row of rows) {
    const id = (row as { id?: string; storyId?: string; tempId?: number }).id
      ?? (row as { storyId?: string }).storyId
      ?? (row as { tempId?: number }).tempId;
    if (id === undefined) throw new TypeError(`Baris ${table} tanpa id`);
    await kv.put({ key: `${PREFIX[table]}${id}`, value: row });
  }
}

export async function clearAppTable(table: AppTable): Promise<void> {
  await (await getKvStore()).deleteByPrefix(PREFIX[table]);
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
