// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B2] Tabel keychain residual di KeyStore SQLite.
 *
 * Semua tabel residual (preKeys, identityKeys, pendingHeaders, messageKeys,
 * state grup, cache partisipan, sesi PQ-DR) harus berhenti di KeyStore SQLite —
 * tidak ada backend kedua. Kunci biner harus round-trip sebagai byte, bukan
 * JSON `Uint8Array`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: new Map<string, Uint8Array>() }));

const keyStore = {
  get: async (key: string) => rows.get(key),
  put: async (key: string, value: Uint8Array) => {
    rows.set(key, value);
  },
  delete: async (key: string) => {
    rows.delete(key);
  },
  clear: async () => {
    rows.clear();
  },
  keys: async (prefix = '') => [...rows.keys()].filter((key) => key.startsWith(prefix)),
};

vi.mock('../storage/sqliteMessages', () => ({
  openSqliteKeyStore: async () => keyStore,
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

const {
  clearIdentityKeys,
  deleteGroupStates,
  deletePendingHeader,
  getCachedGroupParticipants,
  getGroupReceiverState,
  getLastOtpkId,
  getMessageKey,
  getOneTimePreKey,
  getPeerIdentityKey,
  getPendingHeader,
  putPqDrSessionRow,
  saveCachedGroupParticipants,
  saveGroupReceiverState,
  savePeerIdentityKey,
  storeMessageKey,
  storeOneTimePreKey,
  storePendingHeader,
  listPqDrSessionRows,
} = await import('../keychainDb');

describe('tabel keychain residual di KeyStore SQLite', () => {
  beforeEach(() => {
    rows.clear();
  });

  it('preKeys menyimpan byte kunci sebagai base64 dan menemukan id terbesar', async () => {
    const privateKey = Uint8Array.from([0, 1, 2, 250]);
    await storeOneTimePreKey(7, privateKey, 'pq-public');
    await storeOneTimePreKey(12, Uint8Array.from([9]));

    expect([...rows.keys()].some((key) => key.startsWith('pre:'))).toBe(true);
    expect(await getOneTimePreKey(7)).toEqual(privateKey);
    expect(await getLastOtpkId()).toBe(12);
  });

  it('messageKeys tetap byte mentah, bukan JSON', async () => {
    const key = Uint8Array.from([5, 6, 7]);
    await storeMessageKey('msg-1', key);

    expect(await getMessageKey('msg-1')).toEqual(key);
    expect(rows.get('mk:msg-1')).toEqual(key);
  });

  it('identityKeys bisa dibaca dan dibersihkan tanpa Dexie', async () => {
    await savePeerIdentityKey('peer-1', 'pub-key');
    expect(await getPeerIdentityKey('peer-1')).toBe('pub-key');

    await clearIdentityKeys();
    expect(await getPeerIdentityKey('peer-1')).toBeUndefined();
  });

  it('pendingHeaders menyimpan JSON dan bisa dihapus', async () => {
    await storePendingHeader('conv-1', { n: 4, chainId: 'abc' });
    expect(await getPendingHeader('conv-1')).toEqual({ n: 4, chainId: 'abc' });

    await deletePendingHeader('conv-1');
    expect(await getPendingHeader('conv-1')).toBeNull();
  });

  it('state grup dan cache partisipan memakai prefix SQLite', async () => {
    await saveGroupReceiverState({
      id: 'conv-1_device-a',
      conversationId: 'conv-1' as never,
      senderId: 'peer-1' as never,
      CK: 'chain-key',
      N: 2,
      skippedKeys: {},
    });
    expect((await getGroupReceiverState('conv-1', 'peer-1', 'device-a'))?.CK).toBe('chain-key');

    await saveCachedGroupParticipants('conv-1', ['peer-1', 'peer-2']);
    expect(await getCachedGroupParticipants('conv-1')).toEqual(['peer-1', 'peer-2']);

    await deleteGroupStates('conv-1');
    expect([...rows.keys()].some((key) => key.startsWith('gr:conv-1_'))).toBe(false);
    expect([...rows.keys()].some((key) => key.startsWith('gs:conv-1'))).toBe(false);
  });

  it('sesi PQ-DR disimpan per baris dan tidak mencampur percakapan', async () => {
    await putPqDrSessionRow({
      id: 'conv-1_device-a',
      conversationId: 'conv-1',
      state: { marker: 'a' } as never,
      peerClassicalPk: null,
      peerDeviceId: 'device-a',
      version: 2,
      negotiationStatus: 'ESTABLISHED',
      lastActivity: 123,
    });
    await putPqDrSessionRow({
      id: 'conv-2_device-b',
      conversationId: 'conv-2',
      state: { marker: 'b' } as never,
      peerClassicalPk: null,
      peerDeviceId: 'device-b',
      version: 2,
      negotiationStatus: 'ESTABLISHED',
      lastActivity: 456,
    });

    expect((await listPqDrSessionRows('conv-1')).map((row) => row.id)).toEqual(['conv-1_device-a']);
  });
});
