// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/35 Fase 8 residual] Stack E2E khusus OHTTP.
//
// Spec OHTTP tidak bisa memakai dev server biasa karena gateway hanya dipasang
// saat `OHTTP_ENABLED=1` + sepasang kunci P-256. Konfigurasi ini menyalakan
// stack sendiri di port terpisah (API 4100, web 5273) dengan kunci uji yang
// dibuat saat config dimuat — jadi tidak ada kunci privat yang di-commit dan
// dev server 4000 milik developer tidak perlu disentuh/restart.
//
// `NYX_E2E_API_PROXY_TARGET` (dibaca `vite.config.ts`) mengarahkan proxy Vite
// ke API 4100, termasuk `/api/ohttp/*`; relay → gateway → loopback API berjalan
// persis seperti deployment dengan OHTTP aktif.
//
// Jalankan: `pnpm --filter nyx-web run test:e2e:ohttp`.
import { defineConfig, devices } from '@playwright/test';
import crypto from 'node:crypto';

const API_PORT = 4100;
const WEB_PORT = 5273;

/** Kunci HPKE P-256 untuk gateway uji (raw 32-byte scalar + titik 65 byte). */
function ohttpTestKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const privateJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  const publicJwk = publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!privateJwk.d || !publicJwk.x || !publicJwk.y) {
    throw new Error('OHTTP E2E: gagal mengekspor kunci P-256');
  }
  const x = Buffer.from(publicJwk.x, 'base64url');
  const y = Buffer.from(publicJwk.y, 'base64url');
  return {
    privateKey: Buffer.from(privateJwk.d, 'base64url').toString('base64url'),
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
  };
}

const keys = ohttpTestKeys();
// DB uji terpisah bila disediakan (lihat playwright.config.ts).
const e2eDatabaseEnv: Record<string, string> = process.env.NYX_E2E_DATABASE_URL
  ? { DATABASE_URL: process.env.NYX_E2E_DATABASE_URL }
  : {};

export default defineConfig({
  testDir: './e2e',
  testMatch: /ohttp\.spec\.ts/,
  workers: 1,
  globalSetup: './e2e/global.setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter nyx-server dev',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 180 * 1000,
      env: {
        PORT: String(API_PORT),
        OHTTP_ENABLED: '1',
        OHTTP_TOKEN_MODE: 'off',
        OHTTP_PRIVATE_KEY: keys.privateKey,
        OHTTP_PUBLIC_KEY: keys.publicKey,
        // Browser melihat origin Vite (5273); tanpa ini middleware CORS
        // menolak header Origin yang diteruskan proxy (request tetap jalan
        // karena same-origin, tapi log-nya penuh peringatan palsu).
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        // API dev 4000 biasanya sudah memegang METRICS_PORT 9464; exporter
        // kedua akan gagal listen (EADDRINUSE) dan mengotori log. Matikan.
        METRICS_PORT: '0',
        ...e2eDatabaseEnv,
      },
    },
    {
      command: `pnpm --filter nyx-web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180 * 1000,
      env: {
        VITE_OHTTP_ENABLED: '1',
        VITE_OHTTP_TOKEN_MODE: 'off',
        // `api.ts` memakai VITE_API_URL bila ada (web/.env dev menunjuk 4000),
        // jadi arahkan ke origin Vite sendiri agar semua trafik lewat proxy ke
        // API 4100 — tanpa ini request langsung ke 4000 dan diblokir CORS.
        VITE_API_URL: `http://localhost:${WEB_PORT}`,
        NYX_E2E_API_PROXY_TARGET: `http://localhost:${API_PORT}`,
      },
    },
  ],
});
