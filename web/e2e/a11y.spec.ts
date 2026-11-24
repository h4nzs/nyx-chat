// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §8] Aksesibilitas otomatis dengan axe.
//
// Halaman tanpa sesi (login/registrasi/landing) dipindai tanpa akun. Halaman
// ber-sesi (Settings, chat, privacy status, modal story) mendaftar akun unik —
// lebih lambat karena Argon2, tetapi tanpa itu klaim "a11y selesai" hanya
// berlaku untuk layar pra-login. Tiga permukaan ber-sesi dipindai dalam SATU
// tes (satu registrasi): registrasi ketiga berturut-turut tertahan
// REGISTRATION_BURST_LIMIT (20 per IP/jam), dan isolasi tes tidak diperlukan
// untuk pemindaian statis. Pelanggaran level `serious`/`critical`
// menggagalkan tes; `minor`/`moderate` sengaja hanya dilaporkan karena aturan
// seperti color-contrast pada tema gelap butuh keputusan desain, bukan
// perbaikan mekanis.
//
// Jalankan:
//   pnpm run test:a11y
// Di CI, job nightly memakainya; jangan mengklaim halaman ber-sesi bersih hanya
// karena spec ini hijau.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { registerUser } from './helpers/registration';

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
      nodes: violation.nodes.slice(0, 3).map((node) => ({
        target: node.target.join(' '),
        // Potongan HTML mempercepat perbaikan: selector saja tidak menunjukkan
        // elemen mana yang dimaksud (mis. `.select-none` bisa avatar/teks lain).
        html: node.html.slice(0, 200),
      })),
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

  // [docs/41 §8] Halaman ber-sesi: satu pendaftaran nyata (~40-70 dtk Argon2)
  // lebih lambat, tetapi tanpa ini "a11y selesai" hanya berlaku untuk layar
  // pra-login. Dipindai setelah modal onboarding ditutup dan Settings dirender.
  //
  // Config a11y TIDAK menjalankan reset DB, jadi akun uji memakai nama unik dan
  // tidak menghapus data siapa pun. Bila stack uji tidak bisa mendaftar (mis.
  // DB produksi terlindungi), tes gagal — bukan skip diam-diam, karena itu
  // berarti klaim "halaman ber-sesi bersih" tidak punya bukti.
  test('halaman settings (ber-sesi) tidak punya pelanggaran serious/critical', async ({ page }) => {
    test.setTimeout(240000);
    await registerUser(page, 'A11y Settings User', `a11y_settings_${Date.now()}`);
    // Klik sidebar (SPA) lalu tunggu konten Settings benar-benar ter-mount;
    // `goto` langsung bisa mendarat di shell "Loading" (lihat backupRestore).
    await page.getByRole('link', { name: /settings/i }).first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 60000 });
    await expect(page.getByTestId('settings-export-backup')).toBeVisible({ timeout: 90000 });
    await page.waitForTimeout(500);
    await scan(page, 'settings');
  });

  // [docs/43 §43.15.2 #11] Tiga permukaan ber-sesi dipindai dalam SATU tes:
  // registrasi ketiga berturut-turut menabrak rate limit pendaftaran, dan
  // isolasi antar-tes tidak dibutuhkan untuk pemindaian statis. Satu akun,
  // satu alur: chat → privacy status → modal story.
  test('chat, privacy status, dan modal story (ber-sesi) bebas pelanggaran serious/critical', async ({ page }) => {
    test.setTimeout(300000);
    await registerUser(page, 'A11y Session User', `a11y_session_${Date.now()}`);

    // Chat: dua node teks "Your Story" (sr-only di tombol + label terlihat).
    await expect(page.getByText('Your Story', { exact: true }).last()).toBeVisible({ timeout: 60000 });
    await page.waitForTimeout(500);
    await scan(page, 'chat');

    // Privacy status lewat pintu masuk aslinya (Settings → ActionButton);
    // goto langsung bisa mendarat di shell "Loading" tepat setelah registrasi.
    await page.getByRole('link', { name: /settings/i }).first().click();
    await page.getByRole('button', { name: /privacy self-check/i }).click();
    await expect(page).toHaveURL(/\/settings\/privacy/, { timeout: 60000 });
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60000 });
    await page.waitForTimeout(800);
    await scan(page, 'privacy');

    // Modal story: tombol avatar sendiri (berisi sr-only "Your Story"),
    // bukan span label yang berada di luar tombol.
    await page.goto('/chat');
    await page.getByText('Your Story', { exact: true }).last().waitFor({ state: 'visible', timeout: 60000 });
    await page.locator('aside button').filter({ hasText: 'Your Story' }).first().click();
    await expect(page.locator('textarea[placeholder*="mind"]')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(500);
    await scan(page, 'story-modal');
  });
});
