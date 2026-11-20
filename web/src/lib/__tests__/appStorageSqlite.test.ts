// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B2] Conversations, profile cache, story keys, dan offline
 * queue di `KvStore` SQLite. Dexie dibuat melempar agar jalur aktif tidak
 * menulis ke dua tempat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

const kv = {
  get: async <T,>(key: string) => rows.get(key) as T | undefined,
  put: async (item: { key: string; value: unknown }) => {
    rows.set(item.key, item.value);
  },
  delete: async (key: string) => {
    rows.delete(key);
  },
  clear: async () => {
    rows.clear();
  },
  keys: async () => [...rows.keys()],
};

const dexieTouch = (table: string) => () => {
  throw new Error(`Dexie tidak boleh disentuh di jalur ${table} SQLite`);
};

vi.mock('../storage/sqliteMessages', () => ({
  openSqliteKvStore: async () => kv,
}));

vi.mock('../db', () => ({
  db: {
    get conversations() { return dexieTouch('conversations')(); },
    get profileCache() { return dexieTouch('profileCache')(); },
    get storyKeys() { return dexieTouch('storyKeys')(); },
    get offlineQueue() { return dexieTouch('offlineQueue')(); },
  },
}));

vi.stubEnv('VITE_SQLITE_MESSAGES', '1');

const {
  clearAppTable,
  getAppRow,
  listAppRows,
  putAppRow,
  putAppRows,
  replaceAppTableRows,
} = await import('../storage/appStorage');

describe('tabel aplikasi sisa di KvStore SQLite', () => {
  beforeEach(() => {
    rows.clear();
  });

  it('conversations dan profile cache memakai prefix sendiri', async () => {
    await putAppRow('conversations', 'conv-1', { id: 'conv-1', isGroup: 'ENC1:x' });
    await putAppRow('profileCache', 'peer-1', { id: 'peer-1', name: 'Peer' });

    expect(rows.has('conversation:conv-1')).toBe(true);
    expect(rows.has('profile:peer-1')).toBe(true);
    expect((await getAppRow<{ id: string }>('conversations', 'conv-1'))?.id).toBe('conv-1');
    expect(await listAppRows('profileCache')).toEqual([{ id: 'peer-1', name: 'Peer' }]);
  });

  it('story key dan offline queue round-trip tanpa Dexie', async () => {
    await putAppRow('storyKeys', 'story-1', { storyId: 'story-1', key: 'ENC1:k' });
    await putAppRows('offlineQueue', [
      { tempId: 2, data: { content: 'b' }, timestamp: 2 },
      { tempId: 1, data: { content: 'a' }, timestamp: 1 },
    ]);

    expect((await getAppRow<{ key: string }>('storyKeys', 'story-1'))?.key).toBe('ENC1:k');
    expect((await listAppRows<{ tempId: number }>('offlineQueue')).map((r) => r.tempId).sort()).toEqual([1, 2]);
  });

  it('replace menghapus hanya baris tabel yang dimaksud', async () => {
    await putAppRow('conversations', 'old', { id: 'old' });
    await putAppRow('storyKeys', 'keep', { storyId: 'keep', key: 'ENC1:k' });

    await replaceAppTableRows('conversations', [{ id: 'new' }]);

    expect(await getAppRow('conversations', 'old')).toBeUndefined();
    expect((await getAppRow<{ id: string }>('conversations', 'new'))?.id).toBe('new');
    expect(await getAppRow('storyKeys', 'keep')).toBeDefined();

    await clearAppTable('storyKeys');
    expect(rows.has('story:keep')).toBe(false);
  });
});
