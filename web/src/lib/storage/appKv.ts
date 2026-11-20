/**
 * [docs/43 §43.11.6 B3] Satu pintu untuk tabel `kvStore` (pasangan kunci/nilai
 * aplikasi: panic hash, token admin, identitas KT, state SPQR, dll.).
 *
 * Selalu SQLite, di database yang sama dengan pesan. Dexie sudah dihapus, jadi
 * tidak ada hidrasi/fallback lagi; kegagalan membuka store dibiarkan naik ke
 * pemanggil (aplikasi tidak boleh diam-diam menulis ke backend lain).
 */
import { openSqliteKvStore } from './sqliteMessages';
import type { KvStore } from './types';

/** `get`/`put`/`delete`/`clear`/`keys`/`deleteByPrefix` di backend SQLite. */
export async function getKvStore(): Promise<KvStore> {
  return openSqliteKvStore();
}
