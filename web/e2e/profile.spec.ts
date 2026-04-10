import { test, expect } from '@playwright/test';

test.describe('Profile & Ghost Profile', () => {
  test('Update profile display name', async ({ page }) => {
    // 1. Register User
    const username = `profileuser_${Date.now()}`;
    await page.goto('/register');
    await page.fill('input[name="username"], input[placeholder*="sername"]', username);
    await page.fill('input[type="password"]', 'Pass123!');
    const confirmPass = page.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPass.isVisible()) await confirmPass.fill('Pass123!');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });

    // 2. Navigate to Profile
    // We try looking for a link to '/profile' or text 'Profile'
    await page.goto('/profile');
    
    // 3. Update display name
    // Find input for display name (heuristic selector)
    const nameInput = page.locator('input[name="displayName"], input[placeholder*="name"], input[placeholder*="Name"]');
    await nameInput.fill('Updated Ghost Identity');
    
    // Save changes
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Update")');
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
    }

    // Verify UI reflects the change or success message appears
    await expect(page.locator('text=Updated Ghost Identity, text=Success, text=saved').first()).toBeVisible();
  });
});
