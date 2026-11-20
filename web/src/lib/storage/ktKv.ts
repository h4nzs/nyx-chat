import type { KvStore } from './types';

/**
 * [docs/43 §43.11.6 B3] State KT memakai `KvStore` SQLite yang sama dengan
 * pesan/keychain. Prefix memisahkan tiga tabel; marker lama dipertahankan
 * sebagai nama kunci biasa (tidak ada migrasi Dexie lagi).
 */
export const KT_MONITORING_PREFIX = 'kt:mon:';
export const KT_MONITORING_MARKER = 'meta:kt:monitoring:hydrated:v1';
export const KT_GOSSIP_PREFIX = 'kt:gossip:';
export const KT_GOSSIP_MARKER = 'meta:kt:gossip:hydrated:v1';
export const KT_CONFIG_PREFIX = 'kt:config:';
export const KT_CONFIG_MARKER = 'meta:kt:config:hydrated:v1';

/** State KT selalu memakai `KvStore` SQLite; kegagalan dibiarkan naik. */
export async function openKtSqliteKv(): Promise<KvStore> {
  const { getKvStore } = await import('./appKv');
  return getKvStore();
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
