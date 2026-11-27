// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 B3] Data yang dibutuhkan untuk membuka vault tidak boleh
 * disimpan di SQLite: kunci SQLite ter-seal masterSeed, sedangkan masterSeed
 * berasal dari encrypted keys. Kalau keduanya saling menunggu, boot menggantung.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../storage/appKv', () => ({
  getKvStore: async () => {
    throw new Error('bootstrap tidak boleh membuka SQLite');
  },
}));
vi.mock('../sodiumInitializer', () => ({
  getSodium: async () => ({ randombytes_buf: () => new Uint8Array(16) }),
}));
vi.mock('../crypto-worker-proxy', () => ({
  workerPanicHash: async (password: string) => `panic-hash:${password}`,
}));

const { getEncryptedKeys, saveEncryptedKeys, setPanicPassword, checkPanicPassword } = await import(
  '../keyStorage'
);
const { getPersistentInstallationId } = await import('../../utils/fingerprint');
const { keyVault } = await import('../storage/idbKv');

describe('bootstrap storage sebelum vault terbuka', () => {
  beforeEach(async () => {
    await keyVault.clear();
    localStorage.clear();
  });

  it('encrypted keys round-trip lewat vault IDB tanpa SQLite', async () => {
    await saveEncryptedKeys('password-encrypted-bundle');
    await expect(getEncryptedKeys()).resolves.toBe('password-encrypted-bundle');
  });

  it('installation ID stabil dan tidak membuka SQLite', async () => {
    const first = await getPersistentInstallationId();
    const second = await getPersistentInstallationId();
    expect(second).toBe(first);
    expect(first.startsWith('nyx_inst_')).toBe(true);
  });

  it('panic hash dibaca sebelum vault terbuka (login setelah logout)', async () => {
    await setPanicPassword('panic-pass-123');
    await expect(checkPanicPassword('panic-pass-123')).resolves.toBe(true);
    await expect(checkPanicPassword('wrong-pass-123')).resolves.toBe(false);
  });
});
