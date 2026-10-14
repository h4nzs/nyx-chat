import { test, expect, Page } from '@playwright/test';
import { registerUserViaBiometric as registerUser } from './helpers/registration';


test.describe('Settings & Emergency Eject', () => {
  test('Emergency eject clears session data', async ({ page }) => {
    test.setTimeout(60000);
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

    // 5. Verify IndexedDB is functionally cleared by attempting to go back to a protected route
    await page.goto('/chat');
    // Should be redirected back to login because session is gone
    await expect(page).toHaveURL(/(\/login|\/register|\/)$/, { timeout: 10000 });
  });
});
