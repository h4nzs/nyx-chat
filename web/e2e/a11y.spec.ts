// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §8] Aksesibilitas otomatis dengan axe.
//
// Yang dipindai hanya halaman **tanpa sesi** (login/registrasi/landing): halaman
// itu bisa dibuka tanpa akun, sehingga spec ini tidak menambah waktu registrasi
// Argon2 dan tidak bergantung pada state perangkat. Pelanggaran level
// `serious`/`critical` menggagalkan tes; `minor`/`moderate` sengaja hanya
// dilaporkan karena aturan seperti color-contrast pada tema gelap butuh
// keputusan desain, bukan perbaikan mekanis.
//
// Jalankan:
//   pnpm run test:a11y
// Di CI, job nightly memakainya; jangan mengklaim halaman ber-sesi bersih hanya
// karena spec ini hijau.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function scan(page: import('@playwright/test').Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical'
  );

  // Cetak ringkas supaya kegagalan bisa ditindaklanjuti tanpa membuka report.
  for (const violation of blocking) {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(' | ');
    console.error(
      `[a11y] ${label}: ${violation.id} (${violation.impact}) — ${violation.help} ` +
        `(${violation.nodes.length} node: ${targets})`
    );
  }

  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
    })),
    `${label} tidak boleh punya pelanggaran a11y serious/critical`
  ).toEqual([]);
}

test.describe('Aksesibilitas (axe)', () => {
  test('halaman login tidak punya pelanggaran serious/critical', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 30000 });
    // Form terlihat ≠ animasi transisi selesai: `color-contrast` pada elemen
    // yang masih fade-in sempat terbaca gagal (flaky sekali di run lokal).
    await page.waitForTimeout(500);
    await scan(page, 'login');
  });

  test('halaman landing/registrasi tidak punya pelanggaran serious/critical', async ({ page }) => {
    await page.goto('/register');
    // Jangan menunggu `networkidle`: aplikasi memegang koneksi realtime, jadi
    // network tidak pernah idle dan tes mati di timeout sebelum memindai apa pun.
    // Tunggu kerangka yang benar-benar dirender, lalu pindai halaman yang tampil
    // (registrasi bisa dialihkan ke landing).
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(500);
    await scan(page, page.url().includes('/register') ? 'register' : 'landing');
  });
});
