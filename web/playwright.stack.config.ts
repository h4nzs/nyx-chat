import { defineConfig, devices } from '@playwright/test';

// [deploy/sim] Suite terhadap stack simulasi penuh: Vite dev di belakang
// nginx :8080, API + OHTTP + PIR + KT + sidecar WebTransport hidup. Tidak ada
// `webServer` — stack dinyalakan `scripts/sim/e2e.sh`.
//
// Spec yang punya stack sendiri tetap dikecualikan agar himpunan tes identik
// dengan snapshot gate `chrome` (27 tes): a11y (tanpa reset DB), PIR (stack
// dua sidecar khusus + snapshot), storage (Vite tanpa API), opfsApp (stack
// bersih tanpa reset global).
const baseURL = process.env.NYX_STACK_BASE_URL || 'http://localhost:8080';

export default defineConfig({
  testDir: './e2e',
  testIgnore: [/a11y\.spec\.ts/, /pir\.spec\.ts/, /storage\.spec\.ts/, /opfsApp\.spec\.ts/],
  fullyParallel: true,
  workers: 1,
  globalSetup: './e2e/global.setup.ts',
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
