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

/**
 * Exporter metrik stack OHTTP (`playwright.ohttp.config.ts`). Harus sama dengan
 * `E2E_METRICS_PORT` di sana; sengaja tidak diimpor karena mengimpor config
 * Playwright akan menjalankan `defineConfig` (dan membuat kunci P-256) lagi.
 */
const OHTTP_METRICS_URL = 'http://127.0.0.1:19464/metrics';

/** Ambil `nyx_ohttp_client_tag_total{status="…"}` dari teks `/metrics`. */
function parseClientTagCounters(text: string): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('nyx_ohttp_client_tag_total{')) continue;
    const status = /status="([^"]+)"/.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (status && Number.isFinite(value)) counters[status] = value;
  }
  return counters;
}

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

    // Diagnostik: dari sisi UI, relay yang menolak (403/429/502) tampak persis
    // sama dengan "pencarian kosong". Status + potongan body disimpan supaya
    // kegagalan menyebut penyebabnya, bukan hanya "teks tidak muncul".
    const relayResponses: { status: number; body: string }[] = [];
    const consoleErrors: string[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname !== '/api/ohttp/relay') return;
      // Body sukses adalah amplop terenkripsi; yang berguna di sini hanya error
      // JSON yang dikirim relay sendiri (bukan isi amplop).
      void response
        .text()
        .then((text) => relayResponses.push({ status: response.status(), body: text.slice(0, 160) }))
        .catch(() => relayResponses.push({ status: response.status(), body: '<body tidak terbaca>' }));
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
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

    // Pesan gagal dirakit SETELAH menunggu: `expect(locator, "pesan")`
    // mengevaluasi string-nya saat dipanggil, jadi daftar relay yang kosong di
    // awal akan tetap kosong di dalam pesan.
    try {
      await expect(page.locator(`text=${peerUsername}`).first()).toBeVisible({ timeout: 40000 });
    } catch (error) {
      throw new Error(
        `pencarian tidak menampilkan ${peerUsername} setelah 40 s. ` +
          `relay=${JSON.stringify(relayResponses)} console=${JSON.stringify(consoleErrors)}\n${String(error)}`
      );
    }

    await expect.poll(() => relayTypes.length, { timeout: 20000 }).toBeGreaterThan(0);
    const relayFailures = relayResponses.filter((entry) => entry.status !== 200);
    expect(
      relayFailures,
      `relay tidak menjawab 200: ${JSON.stringify(relayFailures.length > 0 ? relayFailures : relayResponses)}`
    ).toHaveLength(0);
    expect(relayTypes[0]).toContain('message/ohttp-req');

    // Jalur tag klien relay (audit N9-01) harus benar-benar aktif di stack uji:
    // relay menandatangani tag, gateway memercayainya. `no-token`/`untagged` di
    // sini berarti konfigurasi stack yang salah, bukan sekadar test gagal.
    const metricsText = await (await page.request.get(OHTTP_METRICS_URL)).text();
    const tagCounters = parseClientTagCounters(metricsText);
    expect(
      tagCounters.tagged ?? 0,
      `nyx_ohttp_client_tag_total tidak bertambah (status=${JSON.stringify(tagCounters)})`
    ).toBeGreaterThan(0);
    expect(
      directSearches,
      `pencarian keluar dari jalur OHTTP: ${directSearches.join(', ')}`
    ).toHaveLength(0);

    const pin = await page.evaluate(() => localStorage.getItem('nyx_ohttp_config_pin_v2'));
    expect(pin, 'key config gateway harus dipin setelah pemakaian pertama').toBeTruthy();
  });
});
