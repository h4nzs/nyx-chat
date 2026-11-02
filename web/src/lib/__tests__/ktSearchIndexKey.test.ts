// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit N8-01] Regresi yang lolos karena KDF-nya di-mock.
 *
 * `deriveKtSearchIndexKey` dulu memanggil libsodium dengan bentuk API C
 * (`crypto_kdf_derive_from_key(subkey, len, id, ctx, key)`) sehingga SELALU
 * melempar `TypeError: subkey_len must be an unsigned integer`:
 *
 *   - `saveKtState` reject sebelum `put` → tidak ada baris KT yang tersimpan;
 *   - `checkBundleAgainstKeyTransparency` menangkapnya sebagai
 *     `{ status: 'unavailable' }` → setiap verifikasi kontak "tidak tersedia";
 *   - loop monitor tidak pernah menulis anchor → deteksi rotasi/split-view mati.
 *
 * Satu-satunya cara menangkapnya adalah menjalankan libsodium **sungguhan**
 * (tidak di-mock) dan memastikan hasilnya deterministik, 32 byte, dan berbeda
 * untuk masterSeed berbeda. IndexedDB dan auth store dipalsukan hanya supaya
 * modul bisa dimuat tanpa vault.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ seed: new Uint8Array(32).fill(1) as Uint8Array | undefined }));

vi.mock('../db', () => ({
  db: {
    isOpen: () => false,
    close: () => {},
  },
  VaultEntry: {},
}));

vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ getMasterSeedIfUnlocked: () => authState.seed }),
  },
}));

import { deriveKtSearchIndexKey } from '../keychainDb';
import { ktSearchKeyRowId } from '../ktMonitoring';

describe('deriveKtSearchIndexKey (KDF libsodium asli)', () => {
  beforeEach(() => {
    authState.seed = new Uint8Array(32).fill(1);
  });

  it('menurunkan 32 byte tanpa melempar', async () => {
    const key = await deriveKtSearchIndexKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    // Regresi lama: seluruh 32 byte pertama adalah 0 karena tidak pernah terisi.
    expect(key.some((byte) => byte !== 0)).toBe(true);
  });

  it('deterministik untuk masterSeed yang sama', async () => {
    const first = await deriveKtSearchIndexKey();
    const second = await deriveKtSearchIndexKey();
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('berbeda untuk masterSeed berbeda', async () => {
    const first = await deriveKtSearchIndexKey();
    authState.seed = new Uint8Array(32).fill(2);
    const second = await deriveKtSearchIndexKey();
    expect(Array.from(first)).not.toEqual(Array.from(second));
  });

  it('melempar (bukan menulis diam-diam) saat vault terkunci', async () => {
    authState.seed = undefined;
    await expect(deriveKtSearchIndexKey()).rejects.toThrow(/masterSeed/);
  });

  it('PK baris KT = HMAC 32 byte dari kunci turunan, bukan search key mentah', async () => {
    const searchKey = new Uint8Array(32).fill(9);
    const rowId = await ktSearchKeyRowId(searchKey);
    expect(rowId).toMatch(/^[0-9a-f]{64}$/);
    // PK tidak boleh memuat search key mentah (itu kebocoran yang ditutup N7-02).
    expect(rowId).not.toBe(Array.from(searchKey, (b) => b.toString(16).padStart(2, '0')).join(''));
  });
});
