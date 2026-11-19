import { expect, test } from '@playwright/test';
import { registerUser } from './helpers/registration';

// [docs/43 §43.11.3] Spec ini hanya dikumpulkan saat `NYX_E2E_OPFS_APP=1`
// (lihat `playwright.config.ts`). Tujuannya bukan menguji worker secara
// terisolasi, melainkan memastikan header COEP tidak memblokir aset aplikasi
// nyata dan jalur baca SQLite benar-benar terbuka setelah akun di-unlock.
test.describe('Aplikasi di bawah COOP/COEP', () => {
  test.setTimeout(300_000);

  test('registrasi, aset, dan SQLite tetap berjalan', async ({ page }) => {
    const blocked: string[] = [];

    page.on('requestfailed', (request) => {
      const error = request.failure()?.errorText ?? '';
      if (/ERR_BLOCKED_BY_RESPONSE|COEP/i.test(error)) {
        blocked.push(`${request.url()} (${error})`);
      }
    });
    page.on('console', (message) => {
      const text = message.text();
      if (/Cross-Origin-Embedder-Policy|ERR_BLOCKED_BY_RESPONSE|blocked by COEP/i.test(text)) {
        blocked.push(text);
      }
    });

    await page.goto('/login');
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

    await registerUser(page, 'OPFS Smoke', `opfs_${Date.now()}`);
    await expect(page).toHaveURL(/\/chat/, { timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);

    const storage = await page.evaluate(async () => {
      // @ts-ignore — path absolut Vite dev server (runtime-only)
      const mod = await import('/src/lib/storage/sqliteMessages.ts');
      const rows = await mod.readSqliteMessages('opfs-app-smoke', 10);
      return {
        enabled: mod.isSqliteMessagesEnabled(),
        available: rows !== null,
        count: rows?.length ?? -1,
      };
    });

    expect(storage).toEqual({ enabled: true, available: true, count: 0 });
    expect(blocked, `Request/console terblokir COEP:\n${blocked.join('\n')}`).toEqual([]);
  });
});
