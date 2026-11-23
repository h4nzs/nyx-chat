// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B3] Migrasi at-rest keychain harus mengikuti backend yang
 * sama dengan penyimpanan: KeyStore SQLite di produksi. Dexie hanya boleh
 * menjadi fallback tes; menyentuhnya di jalur SQLite adalah regresi dual-write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyStore } from '../storage/keyStore';
import type { KeyStore, KvStore } from '../storage/types';

const { kvRows } = vi.hoisted(() => ({ kvRows: new Map<string, unknown>() }));

let keyStore: KeyStore | null = null;

const memoryKv: KvStore = {
  get: async <T,>(key: string) => kvRows.get(key) as T | undefined,
  put: async (item) => { kvRows.set(item.key, item.value); },
  delete: async (key) => { kvRows.delete(key); },
  deleteByPrefix: async (prefix) => {
    for (const key of kvRows.keys()) if (key.startsWith(prefix)) kvRows.delete(key);
  },
  clear: async () => { kvRows.clear(); },
  keys: async () => [...kvRows.keys()],
};

vi.mock('../storage/sqliteMessages', () => ({
  openSqliteKeyStore: async () => {
    if (!keyStore) throw new Error('KeyStore tes belum disiapkan');
    return keyStore;
  },
}));

vi.mock('../storage/appStorage', () => ({
  listAppRows: async () => [],
  putAppRows: async () => {},
}));

vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ getMasterSeedIfUnlocked: () => new Uint8Array(32).fill(3) }),
  },
}));

vi.mock('@lib/crypto-worker-proxy', () => ({
  worker_encrypt_session_key: async (bytes: Uint8Array) => bytes.slice().reverse(),
  worker_decrypt_session_key: async (bytes: Uint8Array) => bytes.slice().reverse(),
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: async () => ({
    to_base64: (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    from_base64: (value: string) =>
      new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    base64_variants: { URLSAFE_NO_PADDING: 1 },
  }),
}));

import { migrateKeychainAtRestEncryption } from '../keychainDb';

const encode = (value: unknown) => Uint8Array.from(new TextEncoder().encode(JSON.stringify(value)));
const decode = (value: Uint8Array | undefined) =>
  value ? JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown> : undefined;

beforeEach(() => {
  kvRows.clear();
  keyStore = createKeyStore(memoryKv);
});

describe('migrasi at-rest keychain di KeyStore SQLite', () => {
  it('menyegel CK/initialCK, receiver skippedKeys, dan group skipped key tanpa Dexie', async () => {
    await keyStore!.put('gs:conv-1', encode({
      conversationId: 'conv-1',
      state: { CK: 'plain-ck', initialCK: 'plain-initial', N: 2 },
    }));
    await keyStore!.put('gr:conv-1_device', encode({
      id: 'conv-1_device',
      conversationId: 'conv-1',
      state: { CK: 'plain-receiver-ck', skippedKeys: { '1': 'plain-mk' } },
    }));
    await keyStore!.put('gskip:conv-1_1', Uint8Array.from(new TextEncoder().encode('plain-skip')));

    await migrateKeychainAtRestEncryption();

    const sender = decode(await keyStore!.get('gs:conv-1')) as {
      state: { CK: string; initialCK: string };
    };
    expect(sender.state.CK.startsWith('ENC1:')).toBe(true);
    expect(sender.state.initialCK.startsWith('ENC1:')).toBe(true);

    const receiver = decode(await keyStore!.get('gr:conv-1_device')) as {
      state: { CK: string; skippedKeys: Record<string, string> };
    };
    expect(receiver.state.CK.startsWith('ENC1:')).toBe(true);
    expect(receiver.state.skippedKeys['1']!.startsWith('ENC1:')).toBe(true);

    const skippedRaw = new TextDecoder().decode(await keyStore!.get('gskip:conv-1_1'));
    expect(skippedRaw.startsWith('ENC1:')).toBe(true);
  });

  it('idempoten: baris yang sudah ter-seal tidak ditulis ulang', async () => {
    await keyStore!.put('gs:conv-2', encode({
      conversationId: 'conv-2',
      state: { CK: 'plain-ck', initialCK: 'plain-initial' },
    }));
    await migrateKeychainAtRestEncryption();
    const first = await keyStore!.get('gs:conv-2');

    await migrateKeychainAtRestEncryption();
    expect(await keyStore!.get('gs:conv-2')).toEqual(first);
  });
});
