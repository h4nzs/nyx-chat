import { defineConfig, devices } from '@playwright/test';

// [docs/43 §43.10.2] PWA hanya ada di build produksi (`import.meta.env.PROD`),
// jadi spec ini memakai `vite build` + `vite preview`, bukan dev server.
const WEB_PORT = 5276;

export default defineConfig({
  testDir: './e2e',
  testMatch: /pwa\.spec\.ts/,
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
      // `vite build` langsung, bukan `pnpm build`: postbuild memanggil layanan
      // IndexNow dan tidak ada hubungannya dengan perilaku service worker.
      command: `pnpm --filter nyx-web exec vite build && pnpm --filter nyx-web exec vite preview --port ${WEB_PORT} --strictPort`,
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
