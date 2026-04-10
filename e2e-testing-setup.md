# E2E Testing Setup and Legacy Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up Playwright for End-to-End (E2E) testing of the web application (focusing on Proof of Work authentication) and remove obsolete legacy backend tests.

**Architecture:** We will install `@playwright/test` in the `web` workspace. The E2E tests will run against the local development servers (Vite on port 5173 and Node.js on port 4000). The legacy backend tests that use outdated authentication schemas will be deleted to reduce technical debt.

**Tech Stack:** Playwright, TypeScript, Node.js.

---

### Task 1: Remove Obsolete Backend Tests

**Files:**
- Modify: `server/package.json` (remove test script if no tests remain)
- Delete: `server/tests/api.test.ts`
- Delete: `server/tests/auth.test.ts`

**Step 1: Delete the legacy test files**
Remove the `server/tests` directory contents, as they test an old, non-Zero-Knowledge authentication flow.

**Step 2: Verify deletion**
Run: `ls server/tests/`
Expected: Files are gone.

### Task 2: Install Playwright in Web Workspace

**Files:**
- Modify: `web/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Install dependencies**
Run: `cd web && pnpm add -D @playwright/test @types/node`

**Step 2: Install Playwright browsers**
Run: `cd web && pnpm exec playwright install --with-deps chromium`

**Step 3: Verify installation**
Check that `@playwright/test` is in `web/package.json` `devDependencies`.

### Task 3: Configure Playwright

**Files:**
- Create: `web/playwright.config.ts`

**Step 1: Create configuration file**
Create a config file that sets the `baseURL` to `http://localhost:5173` and configures the test directory to `e2e`.

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Optional: webServer configuration to start the dev server automatically
  // But we assume the servers are already running for local testing.
});
```

**Step 2: Add test scripts to package.json**
Add `"test:e2e": "playwright test"` to `web/package.json` scripts.

### Task 4: Create Basic Proof of Work Authentication Test

**Files:**
- Create: `web/e2e/auth.spec.ts`

**Step 1: Write the E2E test**
Create a test that navigates to the app, generates a random username, and attempts to register using the Proof of Work fallback (since biometrics are bypassed in testing).

```typescript
import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test('should register a new user using Proof of Work', async ({ page }) => {
    await page.goto('/');
    
    // Assuming the app redirects to /login if not authenticated
    await page.waitForURL('**/login');
    
    // Navigate to register
    await page.click('text=Create Account'); // Adjust selector based on actual UI
    await page.waitForURL('**/register');
    
    // Fill in registration details (adjust selectors as needed)
    // Note: Since it's a Zero-Knowledge app, it might just ask for a password
    await page.fill('input[type="password"]', 'StrongTestPassword123!');
    await page.click('button[type="submit"]');
    
    // Handle the Sandbox/Upgrade modal by selecting Proof of Work
    // This assumes the modal pops up after registration or is accessible
    // Adjust selectors to match your actual UI (e.g., the 'Proof of Work' option)
    
    // Example assertion: Check if we land on the chat page
    // await expect(page).toHaveURL('**/chat');
  });
});
```
*(Note: Selectors in the test above will need to be adjusted to match the actual DOM elements in NYX Chat during implementation).*

**Step 2: Verify test existence**
Run: `ls web/e2e/auth.spec.ts`
Expected: File exists.

### Task 5: Final Verification

**Step 1: Run the E2E tests (Dry run)**
Run: `cd web && pnpm test:e2e`
*(Expect the test to run. It might fail initially if selectors don't match exactly, which is fine for the setup phase, but the framework should execute correctly).*
