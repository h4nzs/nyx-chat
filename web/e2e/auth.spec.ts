import { test, expect } from '@playwright/test';

test.describe('Authentication & Onboarding', () => {
  test('Register with Proof of Work', async ({ page }) => {
    // Navigate to register page
    await page.goto('/register');

    // Fill registration form (adjust names based on actual UI)
    await page.fill('input[name="username"], input[placeholder*="sername"]', 'testuser_pow');
    await page.fill('input[type="password"]', 'StrongPass123!');
    // If there's a confirm password field
    const confirmPass = page.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPass.isVisible()) {
      await confirmPass.fill('StrongPass123!');
    }
    
    await page.click('button[type="submit"]');

    // Wait for PoW calculation and loading (adjust wait condition based on UI)
    // NYX uses client-side PoW and WASM crypto which may take a few seconds
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });
  });

  test('Login with correct password', async ({ page }) => {
    // 1. Create user first (as DB is empty at the start of suite)
    const username = `loginuser_${Date.now()}`;
    await page.goto('/register');
    await page.fill('input[name="username"], input[placeholder*="sername"]', username);
    await page.fill('input[type="password"]', 'StrongPass123!');
    const confirmPass = page.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPass.isVisible()) {
      await confirmPass.fill('StrongPass123!');
    }
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });
    
    // 2. Clear IndexedDB or simulate logout by navigating and clearing state
    // Alternatively, just logout from UI
    await page.goto('/settings');
    const logoutBtn = page.locator('text=Logout, button[aria-label="Logout"], text=Sign out');
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click();
    } else {
      // Fallback: forcefully clear storage
      await page.evaluate(async () => {
        localStorage.clear();
        const dbs = await indexedDB.databases();
        for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
      });
    }

    // 3. Login
    await page.goto('/login');
    await page.fill('input[name="username"], input[placeholder*="sername"]', username);
    await page.fill('input[type="password"]', 'StrongPass123!');
    await page.click('button[type="submit"]');

    // Verify successful login
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 15000 });
  });

  test('Fail login with incorrect password', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="username"], input[placeholder*="sername"]', 'nonexistent_user');
    await page.fill('input[type="password"]', 'WrongPassword123!');
    await page.click('button[type="submit"]');

    // Wait for error message (adjust based on actual UI)
    await expect(page.locator('text=Invalid, text=incorrect, text=Error, text=failed').first()).toBeVisible();
  });
});
