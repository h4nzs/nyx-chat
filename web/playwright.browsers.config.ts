import { defineConfig, devices } from '@playwright/test';

// [nightly COEP WebKit] Smoke engine non-Chromium memakai build produksi, bukan
// dev server. Di dev, Worker ESM Vite mengimpor `env.mjs`/`@nyx/shared` dan
// WebKit 26.6 menolak import itu di bawah COEP (WebKit bug 261734: CORP pada
// import di dalam Worker). Build produksi membundel worker menjadi satu file,
// jadi tidak ada import runtime yang harus lolos COEP — dan yang diuji adalah
// artefak yang benar-benar dikirim, bukan perilaku khusus dev server.
const WEB_PORT = 5173;

const serverEnv: Record<string, string> = {
  PIR_ENABLED: '0',
  ...(process.env.NYX_E2E_DATABASE_URL
    ? { DATABASE_URL: process.env.NYX_E2E_DATABASE_URL }
    : {}),
};

export default defineConfig({
  testDir: './e2e',
  testMatch: /(auth|settings)\.spec\.ts/,
  workers: 1,
  globalSetup: './e2e/global.setup.ts',
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter nyx-server dev',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
      env: serverEnv,
    },
    {
      command:
        `pnpm --filter nyx-web exec vite build && ` +
        `pnpm --filter nyx-web exec vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 300 * 1000,
      env: {
        VITE_API_URL: '/api',
        VITE_PIR_ENABLED: '0',
        VITE_OHTTP_ENABLED: '0',
      },
    },
  ],
});
