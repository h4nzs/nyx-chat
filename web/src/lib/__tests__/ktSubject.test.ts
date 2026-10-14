// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/34 §34.6 poin 1] Penurunan username peer untuk search key log KT.
 *
 * Semua sumber disuntik: yang diuji adalah urutan/prioritas dan sifat
 * fail-open-nya (tanpa username → `undefined`, bukan lempar).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KT_SUBJECT_MISS_RETRY_MS, clearKtSubjectCache, resolvePeerUsername } from '../ktSubject';

const PEER = 'peer-1';

beforeEach(() => {
  clearKtSubjectCache();
  vi.restoreAllMocks();
});

describe('resolvePeerUsername', () => {
  it('memakai profil RAM lebih dulu (tanpa dekripsi)', async () => {
    const decryptProfile = vi.fn(async () => ({ username: 'dari-dekripsi' }));
    const contactProfile = vi.fn(async () => 'ciphertext');

    const username = await resolvePeerUsername(PEER, {
      cachedProfiles: () => ({ [PEER]: { username: '  alice  ' } }),
      decryptProfile,
      contactProfile,
    });

    expect(username).toBe('alice');
    expect(decryptProfile).not.toHaveBeenCalled();
    expect(contactProfile).not.toHaveBeenCalled();
  });

  it('jatuh ke alias plain-id + dekripsi profil percakapan', async () => {
    const decryptProfile = vi.fn(async () => ({ username: 'bob' }));

    const username = await resolvePeerUsername(PEER, {
      cachedProfiles: () => ({ [`${PEER}_${'a'.repeat(32)}`]: { username: 'bob' } }),
      participant: () => ({ encryptedProfile: 'cipher-participant' }),
      decryptProfile,
    });

    expect(username).toBe('bob');
    // Profil RAM (alias komposit) sudah cukup — dekripsi tidak perlu.
    expect(decryptProfile).not.toHaveBeenCalled();
  });

  it('mendekripsi encryptedProfile percakapan bila username belum ada', async () => {
    const decryptProfile = vi.fn(async () => ({ username: 'carol' }));

    const username = await resolvePeerUsername(PEER, {
      cachedProfiles: () => ({}),
      participant: () => ({ encryptedProfile: 'cipher-participant' }),
      contactProfile: async () => 'cipher-contact',
      decryptProfile,
    });

    expect(username).toBe('carol');
    expect(decryptProfile).toHaveBeenCalledTimes(1);
    expect(decryptProfile).toHaveBeenCalledWith(PEER, 'cipher-participant');
  });

  it('memakai kontak tersimpan bila percakapan tidak membawa profil', async () => {
    const decryptProfile = vi.fn(async (_userId: string, ciphertext: string) =>
      ciphertext === 'cipher-contact' ? { username: 'dave' } : null
    );

    const username = await resolvePeerUsername(PEER, {
      cachedProfiles: () => ({}),
      participant: () => ({}),
      contactProfile: async () => 'cipher-contact',
      decryptProfile,
    });

    expect(username).toBe('dave');
  });

  it('username tak ditemukan / kosong = undefined (fail-open, bukan lempar)', async () => {
    const username = await resolvePeerUsername(PEER, {
      cachedProfiles: () => ({ [PEER]: { username: '   ' } }),
      participant: () => ({}),
      contactProfile: async () => null,
      decryptProfile: async () => ({ name: 'Encrypted User' } as { username?: string }),
    });

    expect(username).toBeUndefined();
  });

  it('kegagalan dekripsi tidak melempar, ditahan sebentar, lalu berhasil di-cache', async () => {
    let calls = 0;
    const decryptProfile = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('vault terkunci');
      return { username: 'erin' };
    });
    const deps = {
      cachedProfiles: () => ({}),
      participant: () => ({ encryptedProfile: 'cipher' }),
      contactProfile: async () => null,
      decryptProfile,
    };

    expect(await resolvePeerUsername(PEER, deps, 1_000)).toBeUndefined();

    // Dalam jendela tahan: TIDAK ada percobaan ulang (jalur pesan tidak boleh
    // membayar dekripsi setiap pesan).
    expect(await resolvePeerUsername(PEER, deps, 2_000)).toBeUndefined();
    expect(decryptProfile).toHaveBeenCalledTimes(1);

    // Setelah jendela lewat: dicoba lagi dan berhasil.
    expect(await resolvePeerUsername(PEER, deps, 1_000 + KT_SUBJECT_MISS_RETRY_MS + 1)).toBe('erin');

    // Hasil positif kini di-cache → tidak ada dekripsi tambahan.
    expect(await resolvePeerUsername(PEER, deps, 10_000_000)).toBe('erin');
    expect(decryptProfile).toHaveBeenCalledTimes(2);
  });

  it('clearKtSubjectCache juga melepas jendela tahan kegagalan', async () => {
    const deps = {
      cachedProfiles: () => ({}),
      participant: () => ({}),
      contactProfile: async () => null,
      decryptProfile: async () => null,
    };

    expect(await resolvePeerUsername(PEER, deps, 1_000)).toBeUndefined();
    expect(await resolvePeerUsername(PEER, deps, 1_001)).toBeUndefined();

    clearKtSubjectCache();

    const decryptProfile = vi.fn(async () => ({ username: 'grace' }));
    expect(
      await resolvePeerUsername(PEER, { ...deps, participant: () => ({ encryptedProfile: 'c' }), decryptProfile }, 1_002)
    ).toBe('grace');
  });

  it('cache dibuang oleh clearKtSubjectCache (wipe / vault baru)', async () => {
    const decryptProfile = vi.fn(async () => ({ username: 'frank' }));
    const deps = {
      cachedProfiles: () => ({}),
      participant: () => ({ encryptedProfile: 'cipher' }),
      contactProfile: async () => null,
      decryptProfile,
    };

    expect(await resolvePeerUsername(PEER, deps)).toBe('frank');
    clearKtSubjectCache();
    expect(await resolvePeerUsername(PEER, deps)).toBe('frank');
    expect(decryptProfile).toHaveBeenCalledTimes(2);
  });
});
