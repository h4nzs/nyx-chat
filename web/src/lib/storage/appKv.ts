/**
 * [docs/43 §43.11.6 B3] Satu pintu untuk tabel `kvStore` (pasangan kunci/nilai
 * aplikasi: panic hash, token admin, identitas KT, state SPQR, dll.).
 *
 * Selalu SQLite, di database yang sama dengan pesan. Kegagalan membuka store
 * dibiarkan naik ke pemanggil — kecuali di Vitest, tempat `db` palsu masih
 * menjadi backend tes sampai seam injeksi store menggantikannya.
 */
import { db } from '../db';
import { createDexieKvStore } from './dexieStores';
import { openSqliteKvStore } from './sqliteMessages';
import { useDexieTestFallback } from './testFallback';
import type { KvStore } from './types';

let fallback: KvStore | null = null;

/** `get`/`put`/`delete`/`clear`/`keys`/`deleteByPrefix` di backend SQLite. */
export async function getKvStore(): Promise<KvStore> {
  try {
    return await openSqliteKvStore();
  } catch (error) {
    if (!useDexieTestFallback()) throw error;
    fallback ??= createDexieKvStore(db);
    return fallback;
  }
}
