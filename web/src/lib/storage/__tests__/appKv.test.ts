// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B3] `kvStore` lewat satu pintu SQLite.
 *
 * Di produksi kegagalan membuka SQLite harus sampai ke pemanggil. Di Vitest,
 * seam `useDexieTestFallback()` boleh memakai tabel Dexie palsu agar tes lama
 * tetap berjalan selama migrasi.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KvStore } from '../types';

const sqliteRows = new Map<string, unknown>();
let failOpen = false;

const store: KvStore = {
  get: async <T,>(key: string) => sqliteRows.get(key) as T | undefined,
  put: async (item) => { sqliteRows.set(item.key, item.value); },
  delete: async (key) => { sqliteRows.delete(key); },
  deleteByPrefix: async (prefix) => {
    for (const key of sqliteRows.keys()) if (key.startsWith(prefix)) sqliteRows.delete(key);
  },
  clear: async () => { sqliteRows.clear(); },
  keys: async () => Array.from(sqliteRows.keys()),
};

vi.mock('../sqliteMessages', () => ({
  openSqliteKvStore: async (): Promise<KvStore> => {
    if (failOpen) throw new Error('OPFS tidak tersedia');
    return store;
  },
}));

vi.mock('../../db', () => ({ db: { kvStore: {} } }));

const { getKvStore } = await import('../appKv');

describe('appKv', () => {
  beforeEach(() => {
    sqliteRows.clear();
    failOpen = false;
  });

  it('mendelegasikan seluruh operasi ke KvStore SQLite', async () => {
    const kv = await getKvStore();
    await kv.put({ key: 'nyx_panic_hash', value: 'sealed' });
    await kv.put({ key: 'skipped:1', value: true });

    expect(await kv.get('nyx_panic_hash')).toBe('sealed');
    await kv.deleteByPrefix('skipped:');
    expect(await kv.keys()).toEqual(['nyx_panic_hash']);
  });

  it('memakai fallback Dexie hanya di lingkungan tes', async () => {
    failOpen = true;
    await expect(getKvStore()).resolves.toBeDefined();
  });
});
