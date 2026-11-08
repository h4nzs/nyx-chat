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
    await expect(page).toHaveURL(/\/settings/, { timeout: 15000 });

    // 2. Click Logout / Eject button
    const logoutBtn = page.locator('button', { hasText: /eject|logout|sign out|disconnect/i }).first();
    await expect(logoutBtn).toBeVisible({ timeout: 30000 });
    await logoutBtn.click();

    // 3. Handle confirmation modal if it appears (Emergency Eject triggers showConfirm).
    // Scoped ke dialog teratas + `force`: modal bisa ter-animasi (framer-motion)
    // dan tombolnya berada di footer yang, saat modal tinggi, sempat ter-anggap
    // "intercepted" oleh content well-nya sendiri.
    const dialog = page.locator('[role="dialog"]').last();
    const confirmBtn = dialog.getByRole('button', { name: /confirm/i }).first();
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click({ force: true });

    // 4. Verify redirected to login/onboarding. `?reason=revoked` tetap sah:
    //    emergency logout mematikan semua sesi, dan listener force_logout
    //    menambahkan query itu. Playwright `toHaveURL(regex)` mencocokkan URL
    //    PENUH, sedangkan regex pathname dimulai `/` — jadi periksa pathname
    //    lewat `poll`, bukan URL penuh.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15000 })
      .toMatch(/^\/(login|register)?$/);

    // 5. Verify IndexedDB is functionally cleared by attempting to go back to a protected route.
    //    Halaman BARU di context yang sama, bukan `page` yang baru di-eject: eject
    //    berakhir dengan navigasi keras `window.location.replace('/')`
    //    (nukeProtocol.ts) dan `force_logout` bisa menyusul dengan
    //    `window.location.href = '/login?reason=revoked'` (socketListeners.ts).
    //    Bila navigasi susulan itu jatuh saat `goto('/chat')` berjalan, Chromium
    //    membatalkannya (`net::ERR_ABORTED`) — bukan bug produk, tapi juga bukan
    //    bukti lulus (itu yang membuat spec ini merah di job Chrome).
    //    Context browser berbagi IndexedDB/localStorage, jadi tab baru tetap
    //    membuktikan state lokal sudah kosong.
    //    Redirect `/chat` → login baru terjadi SETELAH bootstrap selesai
    //    (GET /api/users/me → 401); `expect.poll` memberi anggaran itu.
    const afterEject = await page.context().newPage();
    await afterEject.goto('/chat');
    await expect
      .poll(async () => new URL(afterEject.url()).pathname, { timeout: 30000 })
      .toMatch(/^\/(login|register)?$/);
    await afterEject.close();
  });
});
