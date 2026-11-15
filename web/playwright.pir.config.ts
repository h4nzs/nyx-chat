// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/42 WP8] Stack E2E PIR dua server.
//
// Berbeda dari `playwright.ohttp.config.ts`, stack ini menjalankan DUA sidecar
// XOR-PIR sungguhan (`pir-service`, role a dan b) plus API dengan
// `PIR_ENABLED=1`. Kunci ML-DSA-65 dan token admin dibuat saat config dimuat,
// jadi tidak ada rahasia yang di-commit.
//
// Prasyarat: binary rilis sidecar sudah dibangun
// (`cargo build --release` di `server/pir-sidecar`) dan Postgres/Redis hidup.
//
// Jalankan: `pnpm --filter nyx-web run test:e2e:pir`.
import { defineConfig, devices } from '@playwright/test';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_PORT = 4101;
const WEB_PORT = 5274;
const PIR_A_PORT = 19470;
const PIR_B_PORT = 19471;
const E2E_METRICS_PORT = 19465;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const workDir = mkdtempSync(path.join(os.tmpdir(), 'nyx-pir-e2e-'));
const keys = JSON.parse(
  execFileSync(
    'pnpm',
    ['--filter', 'nyx-server', 'exec', 'tsx', 'scripts/pir-e2e-keys.ts'],
    { cwd: ROOT, env: { ...process.env, OUT_DIR: path.join(workDir, 'keys') }, encoding: 'utf8' },
  ),
) as Record<string, { publicKey: string; file: string }>;

// Token tetap, bukan acak: config Playwright dievaluasi ulang di proses worker,
// jadi token acak berbeda antara webServer dan spec yang menjalankan snapshot
// (`403 PIR_ADMIN_FORBIDDEN`). Ini stack uji loopback, bukan rahasia.
const adminToken = 'pir-e2e-admin-token-not-a-secret';
const pirEnv = {
  PIR_ENABLED: '1',
  PIR_OPRF_ENABLED: '1',
  PIR_SERVERS: JSON.stringify([
    { id: 'a', url: `http://127.0.0.1:${PIR_A_PORT}` },
    { id: 'b', url: `http://127.0.0.1:${PIR_B_PORT}` },
  ]),
  PIR_MANIFEST_KEYS: JSON.stringify({ a: keys.a.publicKey, b: keys.b.publicKey }),
  PIR_SIGNING_KEYS: JSON.stringify({ a: keys.a.file, b: keys.b.file }),
  PIR_ADMIN_TOKEN: adminToken,
  PIR_SHARD_DIR: path.join(workDir, 'shards'),
  // 8192, bukan default 2048: body record nyata memuat `encryptedProfile`
  // dan kunci publik ML-DSA (base64url) sehingga 2048 gagal saat build
  // ("body melebihi recordBytes"). Batas wire tetap 16 KB.
  PIR_RECORD_BYTES: '8192',
};
// Spec memakai env yang sama untuk membangun shard lewat `scripts/pir-snapshot.ts`.
Object.assign(process.env, pirEnv);

const e2eDatabaseEnv: Record<string, string> = process.env.NYX_E2E_DATABASE_URL
  ? { DATABASE_URL: process.env.NYX_E2E_DATABASE_URL }
  : {};

/** Kunci HPKE P-256 untuk gateway OHTTP uji (raw 32-byte scalar + titik 65 byte). */
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

const ohttpKeys = ohttpTestKeys();

function sidecar(role: 'a' | 'b', port: number) {
  return {
    command:
      'cargo build --release --manifest-path server/pir-sidecar/Cargo.toml && ' +
      'exec server/pir-sidecar/target/release/pir-service',
    cwd: ROOT,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 300 * 1000,
    env: {
      PIR_ROLE: role,
      PIR_BIND: `127.0.0.1:${port}`,
      PIR_ADMIN_TOKEN: adminToken,
      PIR_SHARD_DIR: path.join(workDir, 'sidecar', role),
    },
  };
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /pir\.spec\.ts/,
  workers: 1,
  globalSetup: './e2e/global.setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    sidecar('a', PIR_A_PORT),
    sidecar('b', PIR_B_PORT),
    {
      command: 'pnpm --filter nyx-server dev',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 180 * 1000,
      env: {
        PORT: String(API_PORT),
        OHTTP_ENABLED: '1',
        OHTTP_TOKEN_MODE: 'off',
        OHTTP_RELAY_EXTERNAL: '0',
        // `OHTTP_TOKEN_MODE=off` mewajibkan token internal yang sama di semua
        // worker; nilai ini dulu hanya datang dari `server/.env` lokal sehingga
        // job CI gagal saat boot ("butuh OHTTP_INTERNAL_TOKEN atau JWT_SECRET",
        // run drills 42590613244). Tetapkan eksplisit supaya harness mandiri.
        // Minimal 32 karakter (ditegakkan `resolveInternalToken`); nilai lebih
        // pendek mengganti error boot "butuh token" dengan error panjang token.
        OHTTP_INTERNAL_TOKEN: 'pir-e2e-ohttp-internal-token-1234',
        // API tetap butuh rahasia sesi walau tes ini tidak menguji auth cookie.
        JWT_SECRET: 'pir-e2e-jwt-secret-not-a-real-secret',
        CSRF_SECRET: 'pir-e2e-csrf-secret-not-a-real-secret',
        // Tanpa sepasang kunci HPKE gateway tidak dipasang, `/api/ohttp/config`
        // 404, dan setiap `pirFetch` gagal sebelum menyentuh server PIR.
        OHTTP_PRIVATE_KEY: ohttpKeys.privateKey,
        OHTTP_PUBLIC_KEY: ohttpKeys.publicKey,
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        ABUSE_REGISTRATION_GUARD: 'off',
        METRICS_PORT: String(E2E_METRICS_PORT),
        ...(e2eDatabaseEnv.DATABASE_URL ? { DATABASE_URL: e2eDatabaseEnv.DATABASE_URL } : {}),
        ...pirEnv,
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
        VITE_PIR_ENABLED: '1',
        VITE_PIR_OPRF_ENABLED: '1',
        VITE_PIR_MANIFEST_KEYS: pirEnv.PIR_MANIFEST_KEYS,
        // Relay in-proses (OHTTP_RELAY_EXTERNAL=0) melayani kedua server di
        // satu route; id server tetap menentukan path `/api/pir/<id>/query`.
        VITE_PIR_RELAYS: JSON.stringify({ a: '/api/ohttp/relay', b: '/api/ohttp/relay' }),
        VITE_API_URL: `http://localhost:${WEB_PORT}`,
        NYX_E2E_API_PROXY_TARGET: `http://localhost:${API_PORT}`,
        NYX_OHTTP_RELAY_PROXY_KEEP_PATH: '1',
        // Relay hidup DI PROSES API (OHTTP_TOKEN_MODE=off), tetapi proxy Vite
        // default mengarah ke relay terpisah :4100 → `OHTTP relay: HTTP 404`.
        NYX_OHTTP_RELAY_PROXY_TARGET: `http://localhost:${API_PORT}`,
      },
    },
  ],
});
