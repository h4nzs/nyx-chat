/**
 * [docs/43 §43.11.6 B3] Satu pintu untuk tabel `kvStore` (pasangan kunci/nilai
 * aplikasi: panic hash, token admin, identitas KT, state SPQR, dll.).
 *
 * Saat `VITE_SQLITE_MESSAGES=1` nilai disimpan di tabel `kvStore` database
 * SQLite yang sama dengan pesan; saat flag mati (transisi) adapter Dexie dipakai
 * supaya pemanggil tidak perlu tahu backend mana yang aktif.
 *
 * Hidrasi Dexie → SQLite terjadi sekali. Tanpa itu, build yang baru mengaktifkan
 * SQLite akan tampak kehilangan seluruh nilai (panic lock, identitas KT, token
 * admin) sampai pengguna mengisinya ulang.
 */
import { db } from '../db';
import { createDexieKvStore } from './dexieStores';
import { openSqliteKvStore } from './sqliteMessages';
import type { KvStore } from './types';

const HYDRATED_KEY = 'sqlite:kv:hydrated:v1';

async function hydrate(sqlite: KvStore): Promise<void> {
  if ((await sqlite.get(HYDRATED_KEY)) === true) return;
  const rows = await db.kvStore.toArray();
  for (const row of rows) await sqlite.put(row);
  await sqlite.put({ key: HYDRATED_KEY, value: true });
}

/** `get`/`put`/`delete`/`clear`/`keys`/`deleteByPrefix` di backend aktif. */
export async function getKvStore(): Promise<KvStore> {
  const sqlite = await openSqliteKvStore();
  if (!sqlite) return createDexieKvStore(db);
  await hydrate(sqlite);
  return sqlite;
}
