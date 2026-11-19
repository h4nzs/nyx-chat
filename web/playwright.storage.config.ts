import { defineConfig, devices } from '@playwright/test';

// [docs/43 §43.11.3] Stack E2E khusus storage: hanya Vite + browser, tanpa
// API/Postgres/Redis dan tanpa global reset DB. Flag SQLite dan COOP/COEP
// dipasang di webServer supaya tidak mengubah suite E2E default.
const WEB_PORT = 5274;

export default defineConfig({
  testDir: './e2e',
  testMatch: /storage\.spec\.ts/,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter nyx-web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120 * 1000,
      env: {
        NYX_SQLITE_OPFS: '1',
        VITE_SQLITE_MESSAGES: '1',
        // Aplikasi boleh memanggil API; spec storage tidak bergantung padanya.
        VITE_API_URL: '/api',
        VITE_PIR_ENABLED: '0',
        VITE_OHTTP_ENABLED: '0',
      },
    },
  ],
});
