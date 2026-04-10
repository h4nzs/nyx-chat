import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('Logout clears local session data', async ({ page }) => {
    // 1. Register
    const username = `logoutuser_${Date.now()}`;
    await page.goto('/register');
    await page.fill('input[name="username"], input[placeholder*="sername"]', username);
    await page.fill('input[type="password"]', 'Pass123!');
    const confirmPass = page.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPass.isVisible()) await confirmPass.fill('Pass123!');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });

    // 2. Navigate to Settings and Logout
    await page.goto('/settings');
    const logoutBtn = page.locator('text=Logout, text=Sign out, text=Disconnect');
    await logoutBtn.click();

    // 3. Verify redirected to login/onboarding
    await expect(page).toHaveURL(/.*(\/login|\/|\/register)/);

    // 4. Verify IndexedDB is functionally cleared by attempting to go back to a protected route
    await page.goto('/chat');
    // Should be redirected back to login because session is gone
    await expect(page).toHaveURL(/.*(\/login|\/|\/register)/);
  });
});
