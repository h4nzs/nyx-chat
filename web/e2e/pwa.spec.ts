import { expect, test } from '@playwright/test';

// [docs/43 §43.10.2] Service worker tidak pernah aktif di dev (`registerServiceWorker`
// keluar saat `!import.meta.env.PROD`). Spec ini menunggu SW produksi benar-benar
// mengambil kontrol, lalu mematikan jaringan dan membuktikan shell login masih
// dilayani dari precache — bukan hanya "file sw.js ada".
test.describe('PWA produksi', () => {
  test.setTimeout(180000);

  test('service worker mengontrol halaman dan shell login tersedia offline', async ({ page, context }) => {
    await page.goto('/login');
    await expect(page.locator('form')).toBeVisible({ timeout: 30000 });

    await page.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        return Boolean(registration?.active);
      },
      null,
      { timeout: 60000 },
    );

    // Muat ulang sekali supaya dokumen ini dikontrol SW (klien pertama boleh
    // saja selesai sebelum `clientsClaim` berjalan).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('form')).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 60000,
    });

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('form')).toBeVisible({ timeout: 30000 });
    } finally {
      await context.setOffline(false);
    }
  });
});
