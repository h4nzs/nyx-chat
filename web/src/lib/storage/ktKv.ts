import type { KvStore } from './types';

/**
 * [docs/43 §43.11.6 B2] State KT memakai `KvStore` SQLite yang sama dengan
 * pesan/keychain. Prefix memisahkan tiga tabel; marker hidrasi sengaja tidak
 * memakai prefix supaya tidak ikut terbaca sebagai baris.
 */
export const KT_MONITORING_PREFIX = 'kt:mon:';
export const KT_MONITORING_MARKER = 'meta:kt:monitoring:hydrated:v1';
export const KT_GOSSIP_PREFIX = 'kt:gossip:';
export const KT_GOSSIP_MARKER = 'meta:kt:gossip:hydrated:v1';
export const KT_CONFIG_PREFIX = 'kt:config:';
export const KT_CONFIG_MARKER = 'meta:kt:config:hydrated:v1';

let warned = false;

/** SQLite hanya dicoba saat flag aktif; kegagalan apa pun kembali ke Dexie. */
export async function openKtSqliteKv(): Promise<KvStore | null> {
  if (import.meta.env.VITE_SQLITE_MESSAGES !== '1') return null;
  try {
    const { openSqliteKvStore } = await import('./sqliteMessages');
    return await openSqliteKvStore();
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn('[KT] SQLite tidak tersedia; memakai Dexie:', error);
    }
    return null;
  }
}

/**
 * Salin state Dexie sekali. Bila SQLite sudah berisi baris ber-prefix, marker
 * tetap dipasang tanpa menimpa data yang lebih baru.
 */
export async function hydrateKvPrefix<T>(options: {
  kv: KvStore;
  prefix: string;
  marker: string;
  loadDexie: () => Promise<Array<{ key: string; value: T }>>;
}): Promise<void> {
  if (await options.kv.get<boolean>(options.marker) === true) return;
  const existing = (await options.kv.keys()).some((key) =>
    key.startsWith(options.prefix));
  if (!existing) {
    for (const row of await options.loadDexie()) {
      await options.kv.put({ key: `${options.prefix}${row.key}`, value: row.value });
    }
  }
  await options.kv.put({ key: options.marker, value: true });
}

export async function listKvPrefix<T>(kv: KvStore, prefix: string): Promise<T[]> {
  const rows: T[] = [];
  for (const key of await kv.keys()) {
    if (!key.startsWith(prefix)) continue;
    const row = await kv.get<T>(key);
    if (row) rows.push(row);
  }
  return rows;
}

export async function clearKvPrefix(kv: KvStore, prefix: string): Promise<void> {
  for (const key of await kv.keys()) {
    if (key.startsWith(prefix)) await kv.delete(key);
  }
}
