// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.8] KT live E2E — jalur yang benar-benar dipakai klien:
// `/api/keys/kt/*` → layanan KT v2 → (verifikasi WASM ada di klien, bukan di
// sini). Keputusan cakupan (2026-11-08): uji **ABI 2 sekarang**, interop
// `cmd/kt-client` menjadi item lanjutan terpisah — bukan alasan menunda bukti
// bahwa jalur baca yang dipakai produksi memang hidup.
//
// Yang dibuktikan di sini:
//   1. config berasal dari log v2 dan mengiklankan `abiVersion: 2` (tanpa itu
//      klien menandai KT `unavailable` — tidak ada fallback senyap ke v1);
//   2. kunci tanda tangan adalah ML-DSA-65 (3904 hex), bukan Ed25519 v1;
//   3. `/head` mengembalikan treeSize/root/timestamp yang bentuknya sah
//      (dipakai gossip split-view);
//   4. bukti `distinguished` (anchor) bisa diambil dengan sesi nyata;
//   5. jalur bukti publik `POST /search` menjawab 200 (ada) atau 404 (tidak
//      ada) — **bukan 500/502** — tanpa membutuhkan akun, sesuai audit N7-01.
//
// Batas yang jujur: verifikasi kriptografis proof terjadi di WASM klien dan
// tidak direplikasi di sini; yang diuji adalah transport + kontrak ABI yang
// membuat verifikasi itu mungkin. Jangan menulis asersi "proof palsu ditolak"
// di sini — itu milik suite `keyTransparency.test.ts`/`ktBundleProof`.
import { test, expect, Page } from '@playwright/test';
import { registerUser } from './helpers/registration';

/** Token CSRF untuk instalasi tertentu (POST tetap melewati double-submit). */
async function csrfFor(page: Page, installationId: string): Promise<string> {
  const response = await page.request.get('/api/csrf-token', {
    headers: { 'x-nyx-installation-id': installationId },
  });
  expect(response.status(), 'GET /api/csrf-token harus 200').toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

test.describe('KT live (ABI 2)', () => {
  test.setTimeout(300000);

  test('config ABI 2, head, anchor, dan bukti publik dapat diambil', async ({ page }) => {
    await registerUser(page, 'KT Live User', `ktlive_${Date.now()}`);

    const configResponse = await page.request.get('/api/keys/kt/config');
    const config = (await configResponse.json()) as {
      error?: string;
      abiVersion?: number;
      signatureKey?: string;
      mode?: number;
      searchKeyPrefix?: string;
    };

    // Stack tanpa layanan KT (mis. job E2E per-PR) harus SKIP dengan alasan
    // tertulis, bukan gagal — tetapi 502/500 tetap kegagalan nyata.
    if (configResponse.status() === 503 && config.error === 'KT_QUERY_DISABLED') {
      test.skip(true, 'KT_QUERY_URL tidak aktif di stack uji');
    }
    expect(configResponse.status(), 'GET /api/keys/kt/config harus 200').toBe(200);
    expect(config.abiVersion, 'klien hanya percaya ABI 2').toBe(2);
    expect(config.signatureKey, 'kunci tanda tangan ML-DSA-65 = 1952 byte hex').toMatch(/^[0-9a-f]{3904}$/);
    expect(typeof config.mode).toBe('number');

    const headResponse = await page.request.get('/api/keys/kt/head');
    expect(headResponse.status(), 'GET /api/keys/kt/head harus 200').toBe(200);
    const head = (await headResponse.json()) as { treeSize?: number; timestamp?: number; root?: string };
    expect(head.treeSize, 'treeSize harus bilangan positif').toBeGreaterThan(0);
    expect(Number.isInteger(head.treeSize)).toBe(true);
    expect(head.root, 'root adalah 32 byte hex').toMatch(/^[0-9a-f]{64}$/);
    expect(typeof head.timestamp).toBe('number');

    const anchorResponse = await page.request.get('/api/keys/kt/distinguished');
    expect(anchorResponse.status(), 'GET /api/keys/kt/distinguished harus 200').toBe(200);
    const anchor = (await anchorResponse.json()) as { fullTreeHead?: string; condensed?: string };
    expect(anchor.fullTreeHead, 'fullTreeHead base64url').toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(anchor.condensed, 'condensed base64url').toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // Jalur publik: `distinguished` adalah search key yang selalu ada di log,
    // jadi 200 diharapkan; 404 tetap kontrak yang sah (log belum punya subjek),
    // 500/502 berarti layanan rusak.
    const installationId = 'e2e-kt-live';
    const searchResponse = await page.request.post('/api/keys/kt/search', {
      headers: {
        'x-nyx-installation-id': installationId,
        'csrf-token': await csrfFor(page, installationId),
      },
      data: { key: Buffer.from('distinguished').toString('base64url') },
    });
    expect([200, 404], `POST /api/keys/kt/search menjawab ${searchResponse.status()}`).toContain(
      searchResponse.status()
    );
    if (searchResponse.status() === 200) {
      const proof = (await searchResponse.json()) as { fullTreeHead?: string; condensed?: string };
      expect(proof.fullTreeHead).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(proof.condensed).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    }
  });
});
