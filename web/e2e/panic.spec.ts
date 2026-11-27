// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/43 §43.10.2 P0] Panic password: klaim keamanan yang sebelumnya hanya
// diuji unit. Spec ini memakai UI nyata:
//   1. set panic password di Settings;
//   2. logout normal (data terenkripsi sengaja dipertahankan untuk login);
//   3. login dengan panic password → wipe lokal, bukan login.
//
// Barrier akhir memakai database `nyx-key-vault` (berisi installation id),
// bukan `user`: logout normal sudah menghapus `user`, jadi hanya wipe yang
// menghapus vault mentah itu.
import { test, expect } from '@playwright/test';
import { registerUser } from './helpers/registration';

const PANIC_PASSWORD = 'PanicPass123!';

test.describe('Panic password', () => {
  test.setTimeout(600_000);

  test('panic password menghapus state lokal, bukan membuka sesi', async ({ page }) => {
    const username = `panic_${Date.now()}`;
    await registerUser(page, 'Panic User', username);

    // Navigasi wipe bisa menghancurkan execution context di tengah polling;
    // `null` berarti "belum bisa dibaca", bukan "vault masih ada".
    const hasVault = () =>
      page
        .evaluate(async () =>
          (await indexedDB.databases()).some((db) => db.name === 'nyx-key-vault'),
        )
        .catch(() => null);
    await expect.poll(hasVault, { timeout: 30000 }).toBe(true);

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

    await expect
      .poll(hasVault, {
        timeout: 30000,
        message: 'nyx-key-vault masih ada — panic wipe tidak berjalan',
      })
      .toBe(false);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30000 }).toMatch(
      /^\/(login|register)?$/,
    );

    // Halaman baru di context yang sama tidak boleh menemukan sesi lama.
    await expect
      .poll(
        () =>
          page
            .evaluate(async () => {
              const dbs = (await indexedDB.databases()).map((db) => db.name ?? '');
              return dbs.filter((name) => name.length > 0);
            })
            .catch(() => null),
        { timeout: 30000, message: 'database lokal masih tersisa setelah panic wipe' },
      )
      .toEqual([]);

    const afterWipe = await page.context().newPage();
    await afterWipe.goto('/chat');
    await expect
      .poll(() => new URL(afterWipe.url()).pathname, { timeout: 30000 })
      .toMatch(/^\/(login|register)?$/);
    await afterWipe.close();
  });
});
