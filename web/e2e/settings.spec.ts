import { test, expect, Page } from '@playwright/test';
import { registerUserViaBiometric as registerUser } from './helpers/registration';


test.describe('Settings & Emergency Eject', () => {
  test('Emergency eject clears session data', async ({ page }) => {
    // Anggaran waktu HARUS soal registrasi, bukan soal alur eject: rantai modal
    // onboarding (Proof of Trust → Recovery → Verify Sequence → Tour) + Argon2
    // memakan 40–70 detik dengan sendirinya. Sebelum ini 60 detik, jadi spec
    // selalu mati di tengah (`Target page, context or browser has been closed`)
    // dan TIDAK pernah benar-benar memverifikasi eject — hanya tampak seperti
    // kegagalan produk saat `page.goto('/chat')` belum sempat dialihkan ulang.
    test.setTimeout(180000);
    const username = `logout_${Date.now()}`;
    await registerUser(page, 'Logout User', username);

    // 1. Navigate to Settings
    const settingsLink = page.locator('a[href="/settings"]').first();
    await settingsLink.click();
    await page.waitForTimeout(1000);

    // 2. Click Logout / Eject button
    const logoutBtn = page.locator('button', { hasText: /eject|logout|sign out|disconnect/i }).first();
    await expect(logoutBtn).toBeVisible({ timeout: 10000 });
    await logoutBtn.click();

    // 3. Handle confirmation modal if it appears (Emergency Eject triggers showConfirm).
    // Scoped ke dialog teratas + `force`: modal bisa ter-animasi (framer-motion)
    // dan tombolnya berada di footer yang, saat modal tinggi, sempat ter-anggap
    // "intercepted" oleh content well-nya sendiri.
    const dialog = page.locator('[role="dialog"]').last();
    const confirmBtn = dialog.getByRole('button', { name: /confirm/i }).first();
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click({ force: true });

    // 4. Verify redirected to login/onboarding
    await expect(page).toHaveURL(/(\/login|\/register|\/)$/, { timeout: 15000 });

    // 5. Verify IndexedDB is functionally cleared by attempting to go back to a protected route.
    //    Redirect `/chat` → login hanya terjadi SETELAH bootstrap selesai (GET
    //    /api/users/me → 401) dan itu memakan waktu di mesin ini; `expect.poll`
    //    memberi anggaran itu tanpa menunggu satu navigasi penuh lagi.
    await page.goto('/chat');
    await expect
      .poll(async () => new URL(page.url()).pathname, { timeout: 30000 })
      .toMatch(/^\/(login|register)?$/);
  });
});
