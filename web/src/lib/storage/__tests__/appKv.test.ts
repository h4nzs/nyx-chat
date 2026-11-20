// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B3] `kvStore` lewat satu pintu.
 *
 * Tes mengunci dua hal yang mudah rusak tanpa terlihat: hidrasi Dexie → SQLite
 * hanya sekali (kalau terulang, nilai yang sudah dihapus pengguna muncul lagi),
 * dan backend Dexie tetap dipakai saat flag SQLite mati.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KvItem, KvStore } from '../types';

const dexieRows = new Map<string, unknown>();
const sqliteRows = new Map<string, unknown>();
let sqliteAvailable = true;

vi.mock('../../db', () => ({
  db: {
    kvStore: {
      toArray: async () => Array.from(dexieRows, ([key, value]) => ({ key, value })),
      get: async (key: string) => (dexieRows.has(key) ? { key, value: dexieRows.get(key) } : undefined),
      put: async (item: KvItem) => { dexieRows.set(item.key, item.value); },
      delete: async (key: string) => { dexieRows.delete(key); },
      clear: async () => { dexieRows.clear(); },
      toCollection: () => ({ primaryKeys: async () => [...dexieRows.keys()] }),
      where: () => ({ startsWith: () => ({ delete: async () => {} }) }),
    },
  },
}));

vi.mock('../sqliteMessages', () => ({
  openSqliteKvStore: async (): Promise<KvStore | null> => {
    if (!sqliteAvailable) return null;
    return {
      get: async <T,>(key: string) => sqliteRows.get(key) as T | undefined,
      put: async (item) => { sqliteRows.set(item.key, item.value); },
      delete: async (key) => { sqliteRows.delete(key); },
      deleteByPrefix: async (prefix) => {
        for (const key of sqliteRows.keys()) if (key.startsWith(prefix)) sqliteRows.delete(key);
      },
      clear: async () => { sqliteRows.clear(); },
      keys: async () => Array.from(sqliteRows.keys()),
    };
  },
}));

const { getKvStore } = await import('../appKv');

describe('appKv', () => {
  beforeEach(() => {
    dexieRows.clear();
    sqliteRows.clear();
    sqliteAvailable = true;
  });

  it('menyalin nilai Dexie sekali saat SQLite mulai dipakai', async () => {
    dexieRows.set('nyx_panic_hash', 'sealed');
    dexieRows.set('installation_id', 'nyx_inst_1');

    const store = await getKvStore();
    expect(await store.get('nyx_panic_hash')).toBe('sealed');
    expect(dexieRows.size).toBe(2);

    // Setelah hidrasi, hapus di SQLite tidak boleh "dihidupkan lagi" oleh
    // salinan Dexie pada pemanggilan berikutnya.
    await store.delete('nyx_panic_hash');
    dexieRows.set('nyx_panic_hash', 'stale');
    expect(await (await getKvStore()).get('nyx_panic_hash')).toBeUndefined();
  });

  it('tetap memakai adapter Dexie saat SQLite tidak tersedia', async () => {
    sqliteAvailable = false;
    dexieRows.set('nyx_device_auto_unlock_ready', true);

    const store = await getKvStore();
    expect(await store.get('nyx_device_auto_unlock_ready')).toBe(true);
    await store.put({ key: 'a', value: 1 });
    expect(dexieRows.get('a')).toBe(1);
  });
});
