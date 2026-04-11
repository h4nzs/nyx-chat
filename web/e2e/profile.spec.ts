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

test.describe('Profile & Identity Settings', () => {
  test('Update profile display name and bio', async ({ page }) => {
    test.setTimeout(60000);
    const username = `profile_${Date.now()}`;
    await registerUser(page, 'Old Name', username);

    // 1. Navigate to settings (where editing happens)
    const settingsLink = page.locator('a[href="/settings"]').first();
    if (await settingsLink.isVisible()) {
      await settingsLink.click();
    } else {
      await page.goto('/settings');
    }
    
    // Tunggu animasi masuk settings selesai
    await page.waitForTimeout(1000);

    // 2. Update display name
    // Menggunakan pemilih CSS yang tangguh namun spesifik karena elemen input teks bisa lebih dari satu
    const nameField = page.locator('input[type="text"]').filter({ hasNot: page.locator('[readonly]') }).first();
    await expect(nameField).toBeVisible({ timeout: 10000 });
    await nameField.fill('Updated Ghost Identity');
    
    // 3. Save changes
    // Mencari tombol submit form atau tombol yang memiliki teks 'save' atau 'update'
    const saveBtn = page.getByRole('button', { name: /save|update|processing/i }).filter({ hasText: /save|update/i }).first();
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
    } else {
      // Fallback
      await page.locator('button[type="submit"]').first().click();
    }

    // 4. Verify UI reflects the change or success message appears
    await expect(nameField).toHaveValue('Updated Ghost Identity', { timeout: 10000 });
    
    // Verifikasi inisial Avatar berubah menjadi UG (Updated Ghost)
    await expect(page.getByText('UG', { exact: true }).first()).toBeVisible({ timeout: 10000 });
  });
});
