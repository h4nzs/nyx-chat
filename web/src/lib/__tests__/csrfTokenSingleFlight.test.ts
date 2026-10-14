// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [CSRF RACE] `generateCsrfToken` server MENERBITKAN cookie baru setiap
 * `GET /api/csrf-token`. Beberapa mutasi yang berjalan paralel saat cache masih
 * dingin (StrictMode double-invoke, boot + aksi user bersamaan) dulu memanggil
 * endpoint itu berkali-kali: cookie yang terakhir ditulis menang, sementara cache
 * klien menyimpan token dari respons yang selesai lebih dulu → POST acak ditolak
 * `403 Invalid CSRF token` (terlihat nyata di /drop: `POST /api/auth/burner`
 * 403 berdampingan dengan 200 pada ms yang sama).
 *
 * Yang dikunci: satu request in-flight dibagi ke semua pemanggil (single-flight),
 * cache dipakai ulang setelah terisi, dan kegagalan TIDAK menyimpan promise mati.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@utils/fingerprint', () => ({
  getPersistentInstallationId: vi.fn(async () => 'iid-test'),
}));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const fetchMock = vi.fn();

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function loadApi() {
  vi.resetModules(); // cache CSRF hidup di scope modul → mulai bersih tiap test
  return await import('../api');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getCsrfToken single-flight', () => {
  it('pemanggil paralel berbagi SATU request (cookie tidak ter-rotate berkali-kali)', async () => {
    const { getCsrfToken } = await loadApi();

    let resolveFetch: ((res: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; })
    );

    const first = getCsrfToken();
    const second = getCsrfToken();
    const third = getCsrfToken();

    // installation-id di-resolve lewat dynamic import (async) sebelum fetch
    // pertama dijalankan — tunggu sampai request itu benar-benar mulai, lalu
    // pastikan dua panggilan lain TIDAK ikut memulai request kedua.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch!(okResponse({ csrfToken: 'token-A' }));

    expect(await Promise.all([first, second, third])).toEqual(['token-A', 'token-A', 'token-A']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cache dipakai ulang setelah token terisi (tidak ada request baru)', async () => {
    const { getCsrfToken } = await loadApi();
    fetchMock.mockResolvedValue(okResponse({ csrfToken: 'token-B' }));

    await getCsrfToken();
    await getCsrfToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('kegagalan tidak menyimpan promise mati — panggilan berikutnya mencoba lagi', async () => {
    const { getCsrfToken } = await loadApi();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    expect(await getCsrfToken()).toBe('');

    fetchMock.mockResolvedValue(okResponse({ csrfToken: 'token-C' }));
    expect(await getCsrfToken()).toBe('token-C');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
