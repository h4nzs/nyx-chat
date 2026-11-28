import { test, expect, Page } from '@playwright/test';
import { registerUser } from './helpers/registration';


test.describe('Security & Sessions', () => {
  test('View active sessions and verify current device', async ({ page }) => {
    test.setTimeout(150000);
    const username = `secuser_${Date.now()}`;
    await registerUser(page, 'Sec User', username);

    // 1. Navigate to Session Management
    const settingsLink = page.locator('a[href="/settings"]').first();
    await settingsLink.click();
    await page.waitForTimeout(1000);
    const sessionsBtn = page.locator('button', { hasText: /sessions/i }).first();
    await sessionsBtn.click();

    // 2. Wait for scanning to finish (if any spinner is shown).
    // `text=Scanning` adalah pencocokan substring case-insensitive, jadi locator
    // pertama justru menangkap caption QR "Add another device by scanning its
    // QR" yang selalu terlihat → asersi "hidden" mustahil lulus (CI run
    // 46099671873). Pakai teks spinner yang sebenarnya
    // (`settings:sessions_page.scanning` = "Scanning Network...").
    const scanningSpinner = page.getByText(/scanning network/i).first();
    if (await scanningSpinner.isVisible()) {
      await expect(scanningSpinner).toBeHidden({ timeout: 15000 });
    }

    // 3. Verify current device is listed
    // The page should show at least one active device (the current one) marked as "Current"
    const currentDeviceIndicator = page.getByText(/CURRENT|ACTIVE|THIS DEVICE/i).first();
    await expect(currentDeviceIndicator).toBeVisible({ timeout: 15000 });
  });
});
