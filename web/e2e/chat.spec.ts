import { test, expect } from '@playwright/test';

test.describe('Chat Functionality', () => {
  test('Start a new conversation and send a message', async ({ page, context }) => {
    // 1. Register User A
    const usernameA = `userA_${Date.now()}`;
    await page.goto('/register');
    await page.fill('input[name="username"], input[placeholder*="sername"]', usernameA);
    await page.fill('input[type="password"]', 'Pass123!');
    const confirmPassA = page.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPassA.isVisible()) await confirmPassA.fill('Pass123!');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });

    // 2. Register User B in a completely separate browser context
    const pageB = await context.newPage();
    const usernameB = `userB_${Date.now()}`;
    await pageB.goto('/register');
    await pageB.fill('input[name="username"], input[placeholder*="sername"]', usernameB);
    await pageB.fill('input[type="password"]', 'Pass123!');
    const confirmPassB = pageB.locator('input[name="confirmPassword"], input[placeholder*="onfirm"]');
    if (await confirmPassB.isVisible()) await confirmPassB.fill('Pass123!');
    await pageB.click('button[type="submit"]');
    await expect(pageB.locator('text=Chats, text=Profile, text=Settings').first()).toBeVisible({ timeout: 20000 });

    // 3. User A searches for User B and starts a chat
    await page.bringToFront();
    // Assuming there's a new chat or search button
    const newChatBtn = page.locator('button[aria-label="New Chat"], text=New Chat, text=Start Chat');
    if (await newChatBtn.isVisible()) {
      await newChatBtn.click();
    }

    // Search by username
    await page.fill('input[placeholder*="Search"], input[placeholder*="sername"]', usernameB);
    // Click on the search result (adjust selector)
    await page.click(`text=${usernameB}`);
    
    // 4. Send a message
    const testMessage = 'Hello, this is a secure zero-knowledge message!';
    // Try to find the message input
    await page.fill('input[placeholder*="message"], textarea[placeholder*="message"]', testMessage);
    await page.press('input[placeholder*="message"], textarea[placeholder*="message"]', 'Enter');

    // Verify message appears in User A's chat view
    await expect(page.locator(`text=${testMessage}`)).toBeVisible();

    // 5. Verify message is received by User B (Real-time Socket.io check)
    await pageB.bringToFront();
    // User B might need to click on the incoming chat from User A
    const chatFromA = pageB.locator(`text=${usernameA}`);
    if (await chatFromA.isVisible()) {
      await chatFromA.click();
    }
    await expect(pageB.locator(`text=${testMessage}`)).toBeVisible();
  });
});
