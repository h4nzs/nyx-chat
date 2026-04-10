import { test, expect } from '@playwright/test';

test.describe('Authentication & Onboarding', () => {
  test.setTimeout(60000); 

  test('Register with Proof of Work', async ({ page }) => {
    await page.goto('/register');

    await page.getByRole('textbox', { name: 'Display Name' }).fill('Test User');
    await page.getByRole('textbox', { name: 'Username (ID)' }).fill('testuser_pow');
    await page.getByRole('textbox', { name: 'Password' }).fill('StrongPass123!');

    await page.getByRole('button', { name: 'Initialize Identity' }).click();

    const skipBiometricBtn = page.locator('button:has-text("Skip"), button:has-text("Continue")').first();
    await expect(skipBiometricBtn).toBeVisible({ timeout: 30000 });
    await skipBiometricBtn.click();

    // Langkah 1 Modal Recovery
    await page.getByRole('button', { name: 'Acknowledge & Proceed' }).click();
    
    // Langkah 2 Tutup Modal Recovery
    const closeRecoveryBtn = page.locator('button[aria-label="Close"], button:has-text("×")').first();
    await expect(closeRecoveryBtn).toBeVisible({ timeout: 5000 });
    await closeRecoveryBtn.click();

    // ✅ FIX 1: Tangani Modal "System Init" dengan klik "Skip for now"
    const skipSystemInitBtn = page.getByRole('button', { name: 'Skip for now' });
    // Gunakan pengecekan kondisional karena modal ini mungkin tidak muncul saat Login
    if (await skipSystemInitBtn.isVisible({ timeout: 5000 })) {
      await skipSystemInitBtn.click();
    }

    // ✅ FIX 2: Ubah asersi akhir menggunakan elemen yang benar-benar ada di UI
    await expect(page.getByRole('heading', { name: 'System Ready' })).toBeVisible({ timeout: 15000 });
  });

  test('Login with correct password', async ({ page }) => {
    const username = `loginuser_${Date.now()}`;
    
    // 1. Register User
    await page.goto('/register');
    await page.getByRole('textbox', { name: 'Display Name' }).fill('Test Login User');
    await page.getByRole('textbox', { name: 'Username (ID)' }).fill(username);
    await page.getByRole('textbox', { name: 'Password' }).fill('StrongPass123!');
    await page.getByRole('button', { name: 'Initialize Identity' }).click();

    const skipBiometricBtn = page.locator('button:has-text("Skip"), button:has-text("Continue")').first();
    await expect(skipBiometricBtn).toBeVisible({ timeout: 30000 });
    await skipBiometricBtn.click();

    await page.getByRole('button', { name: 'Acknowledge & Proceed' }).click();
    
    const closeRecoveryBtn = page.locator('button[aria-label="Close"], button:has-text("×")').first();
    await expect(closeRecoveryBtn).toBeVisible({ timeout: 5000 });
    await closeRecoveryBtn.click();

    // ✅ FIX 1: Tangani Modal "System Init" 
    const skipSystemInitBtn = page.getByRole('button', { name: 'Skip for now' });
    if (await skipSystemInitBtn.isVisible({ timeout: 5000 })) {
      await skipSystemInitBtn.click();
    }
    
    // ✅ FIX 2: Asersi masuk halaman awal
    await expect(page.getByRole('heading', { name: 'System Ready' })).toBeVisible({ timeout: 15000 });
    
    // 2. Clear Session
    await page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      const dbs = await indexedDB.databases();
      for (const db of dbs) { 
        if (db.name) indexedDB.deleteDatabase(db.name); 
      }
    });

    // 3. Login
    await page.goto('/login');
    await page.getByRole('textbox', { name: 'Username' }).fill(username);
    await page.getByRole('textbox', { name: 'Password' }).fill('StrongPass123!');
    await page.getByRole('button', { name: 'Login' }).click();

    // ✅ FIX 2: Asersi Login berhasil
    await expect(page.getByRole('heading', { name: 'System Ready' })).toBeVisible({ timeout: 15000 });
  });

  test('Fail login with incorrect password', async ({ page }) => {
    await page.goto('/login');
    
    await page.getByRole('textbox', { name: 'Username' }).fill('nonexistent_user');
    await page.getByRole('textbox', { name: 'Password' }).fill('WrongPassword123!');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.getByText('Invalid credentials')).toBeVisible({ timeout: 15000 });
  });
});
