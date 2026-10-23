// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/35 Fase 8 residual] E2E OHTTP di browser sungguhan.
//
// Yang dibuktikan (bukan unit test):
//   1. Klien mengambil key config gateway, mem-pin-nya, lalu mencari user LEWAT
//      `POST /api/ohttp/relay` berisi amplop biner (`message/ohttp-req`).
//   2. Tidak ada request `GET /api/users/search` langsung dari halaman —
//      kalau ada, IP/path pencarian bocor dan perlindungannya ilusi
//      (`userSearch.ts` sengaja tidak punya fallback diam-diam).
//   3. Hasil pencarian tetap benar (relay → gateway → API loopback).
//
// Stack-nya terpisah dari suite utama: `playwright.ohttp.config.ts` menyalakan
// API di 4100 dengan `OHTTP_ENABLED=1` + kunci P-256 yang dibuat saat config
// dimuat, dan Vite di 5273 yang mem-proxy ke API itu. Pada suite utama
// (server tanpa OHTTP) spec ini SKIP dengan alasan tertulis — bukan gagal —
// karena default produksi memang mati.
import { test, expect } from '@playwright/test';
import { registerUser } from './helpers/registration';

test.describe('OHTTP — pencarian lewat relay → gateway', () => {
  test.setTimeout(420_000);

  test('pencarian memakai amplop OHTTP, bukan request langsung', async ({ page, browser }) => {
    const config = await page.request.get('/api/ohttp/config');
    test.skip(
      config.status() === 404,
      'OHTTP tidak aktif di server uji (jalankan test:e2e:ohttp untuk stack dengan OHTTP_ENABLED=1)'
    );
    expect(config.ok(), `key config OHTTP harus tersedia: HTTP ${config.status()}`).toBe(true);

    const relayTypes: string[] = [];
    const directSearches: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/ohttp/relay') {
        relayTypes.push(request.headers()['content-type'] ?? '');
      }
      if (url.pathname === '/api/users/search') {
        directSearches.push(`${request.method()} ${url.pathname}${url.search}`);
      }
    });

    // Peer harus ada lebih dulu supaya pencarian punya hasil.
    const peerUsername = `ohttppeer${Date.now()}`;
    const peerContext = await browser.newContext();
    const peerPage = await peerContext.newPage();
    await registerUser(peerPage, 'OHTTP Peer', peerUsername);
    await peerContext.close();

    const username = `ohttpmain${Date.now()}`;
    await registerUser(page, 'OHTTP Main', username);

    const searchInput = page.getByRole('textbox', { name: /search/i }).first();
    await expect(searchInput).toBeVisible({ timeout: 20000 });
    await searchInput.click();
    await searchInput.fill(peerUsername);
    await searchInput.press('Enter');

    await expect(page.locator(`text=${peerUsername}`).first()).toBeVisible({ timeout: 40000 });

    await expect.poll(() => relayTypes.length, { timeout: 20000 }).toBeGreaterThan(0);
    expect(relayTypes[0]).toContain('message/ohttp-req');
    expect(
      directSearches,
      `pencarian keluar dari jalur OHTTP: ${directSearches.join(', ')}`
    ).toHaveLength(0);

    const pin = await page.evaluate(() => localStorage.getItem('nyx_ohttp_config_pin_v2'));
    expect(pin, 'key config gateway harus dipin setelah pemakaian pertama').toBeTruthy();
  });
});
