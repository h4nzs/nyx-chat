import { test, expect, Page } from '@playwright/test';

// Helper 1: Registrasi Akun dan Bypass Semua Modal Awal
async function registerUser(page: Page, displayName: string, username: string) {
  await page.goto('/register');
  
  await page.getByRole('textbox', { name: /Display Name/i }).fill(displayName);
  await page.getByRole('textbox', { name: /Username/i }).fill(username);
  await page.getByRole('textbox', { name: /Password/i }).fill('StrongPass123!');
  await page.getByRole('button', { name: /Initialize Identity/i }).click();

  // 1. Bypass Biometric
  const skipBiometricBtn = page.locator('button:has-text("Skip"), button:has-text("Continue")').first();
  await expect(skipBiometricBtn).toBeVisible({ timeout: 30000 });
  await skipBiometricBtn.click();

  // 2. Bypass Recovery Modal
  await page.getByRole('button', { name: /Acknowledge/i }).click();
  const closeRecoveryBtn = page.locator('button[aria-label="Close"], button:has-text("×")').first();
  await expect(closeRecoveryBtn).toBeVisible({ timeout: 5000 });
  await closeRecoveryBtn.click();

  // 3. Bypass System Init Modal
  const skipSystemInitBtn = page.getByRole('button', { name: /Skip for now/i });
  try {
    await skipSystemInitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await skipSystemInitBtn.click();
    await skipSystemInitBtn.waitFor({ state: 'hidden', timeout: 5000 });
  } catch (e) {
    console.log('System Init modal skipped or not found');
  }

  // 4. Bypass Quick Tour Modal (If it appears)
  const closeTourBtn = page.getByRole('button', { name: /Close modal/i });
  try {
    await closeTourBtn.waitFor({ state: 'visible', timeout: 5000 });
    await closeTourBtn.click();
  } catch (e) {
    console.log('Quick Tour modal skipped or not found');
  }

  // Verifikasi mendarat di Dashboard
  await expect(page.getByRole('heading', { name: /System Ready/i })).toBeVisible({ timeout: 15000 });
}

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

    // 3. Handle confirmation modal if it appears (Emergency Eject triggers showConfirm)
    const confirmBtn = page.getByRole('button', { name: /confirm|proceed|yes|eject/i }).filter({ hasText: /confirm|eject/i }).first();
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    // 4. Verify redirected to login/onboarding
    await expect(page).toHaveURL(/(\/login|\/register|\/)$/, { timeout: 15000 });

    // 5. Verify IndexedDB is functionally cleared by attempting to go back to a protected route
    await page.goto('/chat');
    // Should be redirected back to login because session is gone
    await expect(page).toHaveURL(/(\/login|\/register|\/)$/, { timeout: 10000 });
  });
});
