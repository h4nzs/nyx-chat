import { defineConfig, devices } from '@playwright/test';

// [docs/41 §8] Konfigurasi khusus a11y.
//
// Kenapa tidak memakai `playwright.config.ts`: config itu menjalankan
// `global.setup.ts` yang MENGHAPUS database (lewat `reset-test-env.ts`). Di
// mesin yang `server/.env`-nya beraroma produksi, reset menolak dan seluruh
// suite berhenti sebelum spec pertama — dan memaksa `NODE_ENV=test` di situ
// berarti melewati guard yang justru melindungi data. Spec a11y hanya memindai
// halaman tanpa sesi, jadi tidak butuh reset: API dan Vite yang sudah hidup
// dipakai ulang (`reuseExistingServer`).
export default defineConfig({
  testDir: './e2e',
  testMatch: /a11y\.spec\.ts/,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter nyx-server dev',
      url: 'http://localhost:4000/health',
      reuseExistingServer: true,
      timeout: 120 * 1000,
    },
    {
      command: 'pnpm --filter nyx-web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120 * 1000,
      env: { VITE_API_URL: '/api' },
    },
  ],
});
