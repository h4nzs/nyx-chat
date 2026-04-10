import { test, expect } from '@playwright/test';

test.describe('Security & Session Management', () => {
  test('View session manager and active devices', async ({ page }) => {
    // 1. Register
    const username = `secuser_${Date.now()}`;
    await page.goto('/register');
    await page.fill('input[name="username"], input[placeholder*="sername"]', username);
    await page.fill('input[type="password"]', 'Pass123!');
    const confirmPass = page.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPass.isVisible()) await confirmPass.fill('Pass123!');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });

    // 2. Navigate to Session Management / Security settings
    await page.goto('/sessions');

    // 3. Verify current device is listed
    // The page should show at least one active device (the current one)
    await expect(page.locator('text=Current Device, text=Active, text=This Device, text=Chromium').first()).toBeVisible();
  });
});
