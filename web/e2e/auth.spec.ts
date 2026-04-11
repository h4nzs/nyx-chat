import { test, expect, Page } from '@playwright/test';

test.describe('Authentication & Onboarding', () => {
  test.setTimeout(60000); 

  // Helper: Registrasi Akun dan Bypass Semua Modal Awal
  async function registerAndBypass(page: Page, displayName: string, username: string) {
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

  test('Register with Proof of Work', async ({ page }) => {
    await page.route('**/api/auth/pow/challenge', async route => {
      await route.fulfill({ status: 200, json: { challenge: 'mock_challenge', difficulty: 1 } });
    });
    await page.route('**/api/auth/pow/verify', async route => {
      await route.fulfill({
        status: 201,
        json: { message: 'Registered successfully', user: { id: 'mock_id', username: 'testuser_pow' }, tokens: { access: 'token', refresh: 'token' } }
      });
    });
    await registerAndBypass(page, 'Test User', 'testuser_pow');
  });

  test('Login with correct password', async ({ page }) => {
    const username = `loginuser_${Date.now()}`;
    
    // 1. Register User
    await registerAndBypass(page, 'Test Login User', username);
    
    // 2. Clear Session
    await page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      const dbs = await indexedDB.databases();
      for (const db of dbs) { 
        if (db.name) indexedDB.deleteDatabase(db.name); 
      }
    });

    // 3. FORCE PAGE RELOAD
    // Wipes out Zustand/React state in memory so SPA knows the user is truly logged out
    await page.reload();

    // 4. Login
    await page.goto('/login');
    await page.getByRole('textbox', { name: /Username/i }).fill(username);
    await page.getByRole('textbox', { name: /Password/i }).fill('StrongPass123!');
    await page.getByRole('button', { name: /Login/i }).click();

    // 5. Bypass Modals after Login (System Init / Quick Tour)
    const skipSystemInitBtn = page.getByRole('button', { name: /Skip for now/i });
    try {
      await skipSystemInitBtn.waitFor({ state: 'visible', timeout: 5000 });
      await skipSystemInitBtn.click();
    } catch (e) {}

    const closeTourBtn = page.getByRole('button', { name: /Close modal/i });
    try {
      await closeTourBtn.waitFor({ state: 'visible', timeout: 5000 });
      await closeTourBtn.click();
    } catch (e) {}

    // ✅ Asersi Login berhasil
    await expect(page.getByRole('heading', { name: /System Ready/i })).toBeVisible({ timeout: 15000 });
  });

  test('Fail login with incorrect password', async ({ page }) => {
    await page.goto('/login');
    
    await page.getByRole('textbox', { name: /Username/i }).fill('nonexistent_user');
    await page.getByRole('textbox', { name: /Password/i }).fill('WrongPassword123!');
    await page.getByRole('button', { name: /Login/i }).click();

    await expect(page.getByText('Invalid credentials')).toBeVisible({ timeout: 15000 });
  });
});
