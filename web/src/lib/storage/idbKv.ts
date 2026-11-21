/**
 * [docs/43 §43.11.6 B3] IndexedDB mentah untuk bootstrap vault.
 *
 * Isinya harus bisa dibaca **sebelum** SQLite terbuka: kunci DB (ter-seal
 * `ENC1:`), blob encrypted private keys (sudah terenkripsi password), dan
 * installation ID (pengenal publik). Menaruhnya di SQLite menciptakan siklus
 * karena kunci SQLite sendiri butuh masterSeed dari blob encrypted keys.
 */
import type { KvItem, KvStore } from './types';

const DB_NAME = 'nyx-key-vault';
const STORE = 'kv';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error('IndexedDB key vault tidak bisa dibuka'));
    };
  });
  return opening;
}

function request<T>(store: IDBObjectStore, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Operasi IndexedDB gagal'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const database = await open();
  const tx = database.transaction(STORE, mode);
  const result = await fn(tx.objectStore(STORE));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Transaksi IndexedDB gagal'));
    tx.onabort = () => reject(tx.error ?? new Error('Transaksi IndexedDB dibatalkan'));
  });
  return result;
}

export const keyVault: KvStore = {
  get: <T,>(key: string) => withStore('readonly', (store) => request<T | undefined>(store, (s) => s.get(key) as IDBRequest<T | undefined>)),

  put: (item: KvItem) => withStore('readwrite', async (store) => {
    await request(store, (s) => s.put(item.value, item.key));
  }),

  delete: (key: string) => withStore('readwrite', async (store) => {
    await request(store, (s) => s.delete(key));
  }),

  deleteByPrefix: (prefix: string) => withStore('readwrite', async (store) => {
    const keys = await request(store, (s) => s.getAllKeys());
    for (const key of keys) {
      if (typeof key === 'string' && key.startsWith(prefix)) await request(store, (s) => s.delete(key));
    }
  }),

  clear: () => withStore('readwrite', async (store) => {
    await request(store, (s) => s.clear());
  }),

  keys: () => withStore('readonly', async (store) => {
    const keys = await request(store, (s) => s.getAllKeys());
    return keys.filter((key): key is string => typeof key === 'string');
  }),
};
