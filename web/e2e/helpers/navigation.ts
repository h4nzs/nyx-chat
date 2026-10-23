// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// Helper navigasi E2E untuk halaman terproteksi.
//
// `page.goto('/settings/...')` pada SPA ini melakukan reload penuh: saat
// bootstrap `user` masih null dan `hasRestoredKeys` belum dipulihkan, sehingga
// `ProtectedRoute` sempat melempar ke /login dan akhirnya mendarat lagi di
// /chat — halaman tujuan tidak pernah tampil. Navigasi harus lewat link di
// dalam aplikasi (sidebar Settings → tombol modul), bukan URL langsung.
import { expect, Page } from '@playwright/test';

/**
 * Quick Tour bisa muncul terlambat (setelah helper registrasi selesai
 * menunggunya). Overlay `fixed inset-0`-nya akan menelan klik berikutnya, jadi
 * tutup dulu bila ada — tanpa menggagalkan test bila memang tidak muncul.
 */
export async function closeTourIfVisible(page: Page, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tour = page.getByRole('dialog').filter({ hasText: /Quick Tour/i }).first();
    if (await tour.isVisible().catch(() => false)) {
      await tour
        .getByRole('button', { name: /Close modal/i })
        .first()
        .click({ force: true });
      await expect(tour).toBeHidden({ timeout: 15000 });
      return;
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Buka salah satu modul di halaman Settings lewat UI:
 * sidebar "Settings" → tombol berlabel (mis. "Encryption Keys").
 */
export async function openSettingsSection(page: Page, sectionLabel: RegExp): Promise<void> {
  await closeTourIfVisible(page);
  await page.getByRole('link', { name: /^Settings$/i }).first().click();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 20000 });
  await page.getByRole('button', { name: sectionLabel }).first().click();
}
