// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/31 §31.6b] Local wipe harus ikut menghapus **backup awan**.
 *
 * Kontrak yang diuji (perilaku, bukan teks sumber):
 *  1. `executeLocalWipe` memanggil `deleteCloudBackup()` sebelum sesi dimatikan
 *     di server (`/api/auth/logout-all`). Urutan ini wajib: `DELETE /api/backup`
 *     butuh sesi hidup (cookie HttpOnly), jadi setelah logout objeknya tidak
 *     bisa dihapus lagi dan tetap tertinggal di R2 — "wipe menyeluruh" yang
 *     meninggalkan salinan awan adalah klaim palsu.
 *  2. Kegagalan hapus (belum pernah upload / offline / sandbox) TIDAK
 *     menghentikan wipe lokal.
 *
 * `fake-indexeddb/auto` dipasang supaya langkah IndexedDB di dalam wipe berjalan
 * (jsdom tidak menyediakan indexedDB), dan navigasi di-stub seperti test lain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const calls: string[] = [];

const deleteCloudBackup = vi.fn(async (_arg?: unknown) => {
  calls.push('deleteCloudBackup');
});
vi.mock('@lib/backupTransport', () => ({
  deleteCloudBackup: (arg?: unknown) => deleteCloudBackup(arg),
}));

import { executeLocalWipe } from '../nukeProtocol';

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  deleteCloudBackup.mockImplementation(async (_arg?: unknown) => {
    calls.push('deleteCloudBackup');
  });

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('logout-all')) calls.push('logout-all');
    else if (url.includes('csrf-token')) calls.push('csrf-token');
    return {
      ok: true,
      json: async () => ({ csrfToken: 'csrf' }),
    } as unknown as Response;
  });

  vi.spyOn(window, 'location', 'get').mockReturnValue({
    replace: vi.fn(),
    reload: vi.fn(),
  } as unknown as Location);
});

describe('executeLocalWipe → hapus backup awan', () => {
  it('memanggil deleteCloudBackup SEBELUM logout-all', async () => {
    await executeLocalWipe('/login');

    expect(deleteCloudBackup).toHaveBeenCalledTimes(1);
    const deleteIndex = calls.indexOf('deleteCloudBackup');
    const logoutIndex = calls.indexOf('logout-all');
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(logoutIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeLessThan(logoutIndex);
  });

  it('kegagalan hapus backup awan tidak menghentikan wipe lokal', async () => {
    deleteCloudBackup.mockRejectedValue(new Error('No cloud backup found'));

    await executeLocalWipe('/login');

    expect(calls).toContain('logout-all');
    expect(window.location.replace).toHaveBeenCalledWith('/login');
  });
});
