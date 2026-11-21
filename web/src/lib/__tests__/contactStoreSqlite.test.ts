// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B2] Contact store di KvStore SQLite.
 *
 * Dexie sengaja dibuat melempar: seluruh CRUD kontak harus berhenti di KvStore,
 * bukan diam-diam menulis ke dua tempat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kvRows } = vi.hoisted(() => ({
  kvRows: new Map<string, unknown>(),
}));

const kv = {
  get: async <T,>(key: string) => kvRows.get(key) as T | undefined,
  put: async (item: { key: string; value: unknown }) => {
    kvRows.set(item.key, item.value);
  },
  delete: async (key: string) => {
    kvRows.delete(key);
  },
  clear: async () => {
    kvRows.clear();
  },
  keys: async () => [...kvRows.keys()],
};

vi.mock('../storage/sqliteMessages', () => ({
  openSqliteKvStore: async () => kv,
}));

vi.mock('../db', () => ({
  db: {
    get contacts() {
      throw new Error('Dexie contacts tidak boleh disentuh di jalur SQLite');
    },
  },
}));

vi.mock('../shadowVaultDb', () => ({
  encryptVaultText: vi.fn(async (text: string) => 'ENC1:' + Buffer.from(text, 'utf8').toString('base64')),
  decryptVaultText: vi.fn(async (enc: string) =>
    enc.startsWith('ENC1:') ? Buffer.from(enc.slice(5), 'base64').toString('utf8') : null
  ),
}));

vi.mock('@lib/keychainDb', () => ({
  AT_REST_PREFIX: 'ENC1:',
  encryptValueAtRest: vi.fn(async (value: string) => 'ENC1:' + Buffer.from(value, 'utf8').toString('base64')),
  decryptValueAtRest: vi.fn(async (stored: string) =>
    stored.startsWith('ENC1:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : null
  ),
}));

vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'me-user-id' } }),
  },
}));

vi.mock('@lib/api', () => ({
  authFetch: vi.fn(async () => ({ success: true })),
}));

const {
  deleteContact,
  getAllContacts,
  getContact,
  upsertContact,
} = await import('../contactStore');

describe('contactStore di KvStore SQLite', () => {
  beforeEach(() => {
    kvRows.clear();
  });

  it('upsert, baca, daftar, dan hapus tanpa menyentuh Dexie', async () => {
    await upsertContact({ userId: 'peer-sqlite', conversationId: 'conv-1', encryptedProfile: 'ep' });

    expect(kvRows.has('contacts:peer-sqlite')).toBe(true);
    const stored = kvRows.get('contacts:peer-sqlite') as { data: string; updatedAt: unknown };
    expect(stored.data.startsWith('ENC1:')).toBe(true);
    expect(String(stored.updatedAt).startsWith('ENC1:')).toBe(true);

    expect(await getContact('peer-sqlite')).toMatchObject({
      userId: 'peer-sqlite',
      conversationId: 'conv-1',
      encryptedProfile: 'ep',
    });
    expect((await getAllContacts()).map((row) => row.userId)).toEqual(['peer-sqlite']);

    await deleteContact('peer-sqlite');
    expect(kvRows.has('contacts:peer-sqlite')).toBe(false);
    expect(await getContact('peer-sqlite')).toBeNull();
  });
});
