import { base64UrlToBytes, bytesToBase64Url } from '../base64url';
import type { KeyStore, KvStore } from './types';

interface StoredKey {
  v: string;
}

function isStoredKey(value: unknown): value is StoredKey {
  return !!value
    && typeof value === 'object'
    && typeof (value as { v?: unknown }).v === 'string';
}

/**
 * [docs/43 §43.11.6 B1/B2] Material kunci biner di atas `KvStore`.
 *
 * Nilai di-encode base64url karena `KvStore` hanya menjamin JSON; kontrak ini
 * tidak melakukan enkripsi. Pemanggil wajib menyegel byte dengan masterSeed
 * sebelum menulis (lihat `storage/dbKey.ts`).
 */
export function createKeyStore(kv: KvStore): KeyStore {
  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      const stored = await kv.get(key);
      if (stored === undefined) return undefined;
      if (!isStoredKey(stored)) {
        throw new Error(`KeyStore: nilai '${key}' rusak (bukan material kunci)`);
      }
      return base64UrlToBytes(stored.v);
    },

    async put(key: string, value: Uint8Array): Promise<void> {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('KeyStore: nilai harus Uint8Array');
      }
      await kv.put({ key, value: { v: bytesToBase64Url(value) } });
    },

    async delete(key: string): Promise<void> {
      await kv.delete(key);
    },

    async keys(prefix = ''): Promise<string[]> {
      const keys = await kv.keys();
      return keys.filter((key) => key.startsWith(prefix));
    },

    async clear(): Promise<void> {
      await kv.clear();
    },
  };
}
