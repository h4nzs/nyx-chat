// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit N8-03] Pin konfigurasi KT harus **per akun**, bukan satu baris global
 * yang dihapus saat logout.
 *
 * Dua properti yang dikunci:
 *   1. Logout tidak menghapus pin → akun yang sama tetap memakai pin yang sama
 *      setelah login lagi (server tidak bisa menukar `signatureKey` di sela
 *      logout→login tanpa terdeteksi).
 *   2. Akun lain di perangkat yang sama tidak pernah membaca/mewarisi pin itu.
 *
 * IndexedDB dan sealing dipalsukan: yang diuji adalah pemilihan baris, bukan
 * crypto (seal `ENC1:` sudah diuji di `atRestFailClosed.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: new Map<string, { id: string; blob: string }>(),
  userId: undefined as string | undefined,
}));

vi.mock('../db', () => ({
  db: {
    ktConfig: {
      get: async (id: string) => state.rows.get(id),
      put: async (row: { id: string; blob: string }) => {
        state.rows.set(row.id, row);
      },
      delete: async (id: string) => {
        state.rows.delete(id);
      },
      clear: async () => {
        state.rows.clear();
      },
    },
  },
}));

vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: state.userId ? { id: state.userId } : null }),
  },
}));

vi.mock('../keychainDb', () => ({
  encryptValueAtRest: async (value: string) => `ENC1:${value}`,
  decryptValueAtRest: async (value: string) =>
    value.startsWith('ENC1:') ? value.slice('ENC1:'.length) : value,
}));

import {
  KT_CONFIG_ROW_ID,
  clearKtConfigPin,
  ktConfigPinRowId,
  loadKtConfigPin,
  saveKtConfigPin,
  type KtConfigPin,
} from '../ktConfigPin';

const pinFor = (mode: number): KtConfigPin => ({
  abiVersion: 1,
  mode,
  signatureKey: 'a'.repeat(64),
  vrfKey: 'b'.repeat(64),
  auditorKeys: [],
});

describe('pin konfigurasi KT per akun', () => {
  beforeEach(() => {
    state.rows.clear();
    state.userId = undefined;
  });

  it('PK memuat id akun, bukan baris global', () => {
    expect(ktConfigPinRowId('user-a')).toBe(`${KT_CONFIG_ROW_ID}:user-a`);
    expect(ktConfigPinRowId('user-a')).not.toBe(ktConfigPinRowId('user-b'));
  });

  it('pin bertahan setelah logout (akun yang sama memakai pin yang sama)', async () => {
    state.userId = 'user-a';
    await saveKtConfigPin(pinFor(1));
    expect(state.rows.has(ktConfigPinRowId('user-a'))).toBe(true);

    // Logout = tidak ada sesi; modul tidak menghapus baris apa pun.
    state.userId = undefined;
    expect(await loadKtConfigPin()).toBeUndefined();
    expect(state.rows.size).toBe(1);

    // Login lagi sebagai akun yang sama → pin lama terbaca.
    state.userId = 'user-a';
    const restored = await loadKtConfigPin();
    expect(restored?.mode).toBe(1);
    expect(restored?.abiVersion).toBe(1);
  });

  it('akun lain tidak membaca pin akun pertama', async () => {
    state.userId = 'user-a';
    await saveKtConfigPin(pinFor(1));

    state.userId = 'user-b';
    expect(await loadKtConfigPin()).toBeUndefined();

    await saveKtConfigPin(pinFor(2));
    expect((await loadKtConfigPin())?.mode).toBe(2);

    // Pin A tidak tertimpa oleh B.
    state.userId = 'user-a';
    expect((await loadKtConfigPin())?.mode).toBe(1);
  });

  it('tanpa id akun tidak membaca dan tidak menulis apa pun', async () => {
    state.userId = 'user-a';
    await saveKtConfigPin(pinFor(1));

    state.userId = undefined;
    expect(await loadKtConfigPin()).toBeUndefined();
    await saveKtConfigPin(pinFor(3));
    expect(state.rows.size).toBe(1);
    expect(state.rows.has(ktConfigPinRowId('user-a'))).toBe(true);
  });

  it('clearKtConfigPin menghapus SEMUA pin (rotasi yang disengaja), bukan satu akun', async () => {
    state.userId = 'user-a';
    await saveKtConfigPin(pinFor(1));
    state.userId = 'user-b';
    await saveKtConfigPin(pinFor(2));
    expect(state.rows.size).toBe(2);

    await clearKtConfigPin();
    expect(state.rows.size).toBe(0);
  });
});
