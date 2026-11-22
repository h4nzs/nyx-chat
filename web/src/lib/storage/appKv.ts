/**
 * [docs/43 §43.11.6 B3] Satu pintu untuk tabel `kvStore` (pasangan kunci/nilai
 * aplikasi: panic hash, token admin, identitas KT, state SPQR, dll.).
 *
 * Selalu SQLite, di database yang sama dengan pesan. Kegagalan membuka store
 * dibiarkan naik ke pemanggil — tidak ada backend kedua.
 */
import { openSqliteKvStore } from './sqliteMessages';
import type { KvStore } from './types';

/** `get`/`put`/`delete`/`clear`/`keys`/`deleteByPrefix` di backend SQLite. */
export async function getKvStore(): Promise<KvStore> {
  return openSqliteKvStore();
}
