// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/43 §43.10.2 P0] Panic password: klaim keamanan yang sebelumnya hanya
// diuji unit. Spec ini memakai UI nyata:
//   1. set panic password di Settings;
//   2. logout normal (data terenkripsi sengaja dipertahankan untuk login);
//   3. login dengan panic password → wipe lokal, bukan login.
//
// Barrier akhir TIDAK memakai "database `nyx-key-vault` sudah tidak ada":
// wipe berakhir dengan `location.replace('/')`, lalu boot halaman login memanggil
// `getPersistentInstallationId()` yang membuat vault itu lagi (dengan id baru).
// Di mesin lokal jendela "vault belum ada" sempat tertangkap; di CI pembuatan
// ulangnya instan sehingga asersi itu selalu gagal walau wipe berjalan benar.
// Yang diasersikan sekarang adalah efek yang stabil:
//   - `installation_id` di vault BERUBAH (vault lama terhapus, bukan dibiarkan),
//   - panic hash tidak lagi terverifikasi (`checkPanicPassword` false),
//   - tidak ada sesi yang terbuka (tetap di /login, tab baru juga).
import { test, expect } from '@playwright/test';
import { registerUser } from './helpers/registration';

const PANIC_PASSWORD = 'PanicPass123!';

test.describe('Panic password', () => {
  test.setTimeout(600_000);

  test('panic password menghapus state lokal, bukan membuka sesi', async ({ page }) => {
    const username = `panic_${Date.now()}`;
    await registerUser(page, 'Panic User', username);

    // Pembacaan lewat modul sumber (semua job E2E memakai dev server). `null`
    // berarti "belum bisa dibaca" (halaman sedang navigasi), bukan nilai.
    const installationId = () =>
      page
        .evaluate(async () => {
          // @ts-ignore — path absolut Vite dev server (runtime-only)
          const mod = await import('/src/utils/fingerprint');
          return (await mod.getPersistentInstallationId()) as string;
        })
        .catch(() => null);
    const panicStillSet = () =>
      page
        .evaluate(async (password) => {
          // @ts-ignore — path absolut Vite dev server (runtime-only)
          const mod = await import('/src/lib/keyStorage');
          return (await mod.checkPanicPassword(password)) as boolean;
        }, PANIC_PASSWORD)
        .catch(() => null);

    await page.locator('a[href="/settings"]').first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 30000 });

    const panicSection = page
      .locator('div.space-y-3')
      .filter({ hasText: /Panic Password/i })
      .first();
    await expect(panicSection).toBeVisible({ timeout: 30000 });
    const panicInput = panicSection.locator('input[type="password"]').first();
    await expect(panicInput).toBeVisible();
    await panicInput.fill(PANIC_PASSWORD);
    await panicSection.getByRole('button', { name: /^Save$/i }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible({ timeout: 30000 });
    // Hash panic benar-benar tersimpan dan terbaca sebelum vault terbuka —
    // inilah yang dulu tidak pernah terjadi (bug P0), jadi diperiksa di sini.
    await expect
      .poll(panicStillSet, { timeout: 30000, message: 'panic hash tidak tersimpan di vault' })
      .toBe(true);
    const idBefore = await installationId();
    expect(idBefore, 'installation id harus terbaca sebelum wipe').toBeTruthy();

    // Logout NORMAL — bukan Emergency Eject. Data lokal (termasuk panic hash)
    // harus bertahan supaya percobaan login berikutnya memicu panic.
    await page.locator('a[href="/chat"]').first().click();
    await expect(page).toHaveURL(/\/chat/, { timeout: 30000 });
    await page.getByRole('button', { name: /log ?out/i }).first().click();
    const dialog = page.locator('[role="dialog"]').last();
    const confirm = dialog.getByRole('button', { name: /confirm/i }).first();
    await expect(confirm).toBeVisible({ timeout: 15000 });
    await confirm.click({ force: true });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30000 }).toMatch(
      /^\/(login|register)?$/,
    );

    // Login dengan panic password. handleLogin menjalankan checkPanicPassword
    // sebelum request auth, lalu wipe setelah jeda penyamaran 2 detik.
    await page.getByRole('textbox', { name: /username/i }).fill(username);
    await page.locator('input[type="password"]').first().fill(PANIC_PASSWORD);
    await page.getByRole('button', { name: /^login$/i }).click();

    // Jangan menyentuh IndexedDB selama wipe berjalan: `deleteDatabase` bisa
    // terblokir oleh koneksi probe, dan wipe yang terblokir hanya memicu reload
    // (vault lama selamat). Jeda ini melewati penyamaran 2 detik + delete.
    await page.waitForTimeout(3000);

    // Bukti wipe: vault lama hilang, bukan sekadar "DB-nya tidak terlihat".
    // Wipe menghapus semua IDB + localStorage, lalu boot halaman login membuat
    // `installation_id` baru — jadi id harus BERUBAH (bukan menghilang).
    await expect
      .poll(
        async () => {
          const current = await installationId();
          return current !== null && current !== idBefore;
        },
        { timeout: 60000, message: 'installation id tidak berubah — panic wipe tidak berjalan' },
      )
      .toBe(true);
    // Record panic ikut terhapus: password yang sama tidak lagi memicu wipe.
    await expect
      .poll(panicStillSet, { timeout: 30000, message: 'panic hash masih terbaca setelah wipe' })
      .toBe(false);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30000 }).toMatch(
      /^\/(login|register)?$/,
    );

    // Halaman baru di context yang sama tidak boleh menemukan sesi lama.

    const afterWipe = await page.context().newPage();
    await afterWipe.goto('/chat');
    await expect
      .poll(() => new URL(afterWipe.url()).pathname, { timeout: 30000 })
      .toMatch(/^\/(login|register)?$/);
    await afterWipe.close();
  });
});
