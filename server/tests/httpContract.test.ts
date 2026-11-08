// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §7.2] Contract test HTTP.
//
// Kenapa opt-in (`NYX_HTTP_CONTRACT=1`), bukan jalan di suite unit default:
// app nyata memasang limiter berbasis Redis dan route yang menyentuh Postgres.
// Aturan repo (`AGENTS.md`) melarang suite unit butuh Redis/Postgres, jadi tes
// ini dijalankan di job yang memang menyediakan service tersebut (nightly
// `http-contract`) dan di lokal dengan `NYX_HTTP_CONTRACT=1` saat stack hidup.
//
// Yang dikunci adalah kontrak yang mudah rusak tanpa terlihat di tes util:
//   1. header keamanan (helmet) tetap ada di respons mana pun;
//   2. JSON rusak → 400 `Invalid JSON`, bukan 500;
//   3. POST tanpa CSRF → 403, bukan 401/500 (urutan gate: CSRF sebelum route);
//   4. body di atas 1 MB → 413 (batas nyata, bukan asumsi klien);
//   5. `GET /api/csrf-token` menerbitkan token + cookie yang namanya dipakai
//      klien (`x-csrf-token`) dan menghormati `x-nyx-installation-id`;
//   6. origin asing tidak mendapat `Access-Control-Allow-Origin`.
//
// Tidak ada tes "login berhasil" di sini: itu butuh akun, Argon2, dan DB —
// sudah dicakup E2E auth. Tes ini sengaja cepat dan tidak menulis data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.NYX_HTTP_CONTRACT === '1';

test(
  'contract HTTP (opt-in: NYX_HTTP_CONTRACT=1, butuh Redis + Postgres)',
  { skip: enabled ? false : 'opt-in: jalankan dengan NYX_HTTP_CONTRACT=1 dan Redis/Postgres hidup' },
  async (t) => {
    // Env harus diset SEBELUM `app` diimpor: config/prisma membaca env saat
    // modul dimuat, dan mengubahnya setelahnya tidak berpengaruh.
    process.env.NODE_ENV ??= 'test';
    process.env.PORT ??= '0';
    process.env.DATABASE_URL ??= 'postgresql://nyx:nyx@127.0.0.1:5432/nyx_contract';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.JWT_SECRET ??= 'contract-jwt-secret';
    process.env.CSRF_SECRET ??= 'contract-csrf-secret';
    process.env.CORS_ORIGIN ??= 'https://app.example.test';

    // Redis HARUS tersambung SEBELUM `app` diimpor: limiter membuat store dan
    // mencoba inisialisasi saat modul dimuat. Kalau urutannya dibalik, setiap
    // request 500 dengan `ClientClosedError` dan tes kontrak justru menguji
    // kesalahan setup-nya sendiri.
    const { connectRedis, redisClient } = await import('../src/lib/redis.js');
    await connectRedis();

    const { default: app } = await import('../src/app.js');
    const { prisma } = await import('../src/lib/prisma.js');

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'server harus punya port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      await t.test('header keamanan hadir di respons 404', async () => {
        const response = await fetch(`${base}/api/__contract_missing`);
        assert.equal(response.status, 404);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      });

      await t.test('JSON rusak → 400 Invalid JSON', async () => {
        const response = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-nyx-installation-id': 'contract-installation',
          },
          body: '{"email":',
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'Invalid JSON' });
      });

      await t.test('POST tanpa CSRF → 403 (CSRF sebelum route)', async () => {
        const response = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-nyx-installation-id': 'contract-installation',
          },
          body: JSON.stringify({ email: 'contract@example.test', password: 'x' }),
        });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'Invalid CSRF token' });
      });

      await t.test('body > 1 MB → 413', async () => {
        const response = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-nyx-installation-id': 'contract-installation',
          },
          body: JSON.stringify({ email: 'contract@example.test', password: 'x'.repeat(2 * 1024 * 1024) }),
        });
        assert.equal(response.status, 413);
      });

      await t.test('/api/csrf-token menerbitkan token + cookie x-csrf-token', async () => {
        const response = await fetch(`${base}/api/csrf-token`, {
          headers: { 'x-nyx-installation-id': 'contract-installation' },
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { csrfToken?: string };
        assert.equal(typeof body.csrfToken, 'string');
        assert.ok(body.csrfToken && body.csrfToken.length > 10, 'token tidak boleh kosong');
        const cookies = response.headers.get('set-cookie') ?? '';
        assert.match(cookies, /x-csrf-token=/);
      });

      await t.test('origin asing tidak mendapat Access-Control-Allow-Origin', async () => {
        const response = await fetch(`${base}/api/__contract_missing`, {
          headers: { origin: 'https://evil.example' },
        });
        const allowOrigin = response.headers.get('access-control-allow-origin');
        assert.ok(
          allowOrigin === null || allowOrigin !== 'https://evil.example',
          `origin asing tidak boleh diizinkan, dapat: ${allowOrigin}`
        );
      });

      // [docs/41 §7.2] 429 adalah kontrak, bukan detail implementasi: klien
      // (dan k6) harus bisa membedakan "dibatasi" dari "rusak". Dijalankan
      // TERAKHIR karena bucket-nya sengaja dipenuhi. `CF-Connecting-IP` dipakai
      // sebagai kunci bucket unik (header ini yang dibaca `clientRateLimitTag`),
      // sehingga limiter 127.0.0.1 milik tes/E2E lain tidak ikut termakan.
      await t.test('rate limit umum → 429 (bucket terpisah per IP)', async () => {
        let status = 0;
        for (let i = 0; i < 320; i++) {
          const response = await fetch(`${base}/api/__contract_missing`, {
            headers: { 'cf-connecting-ip': '203.0.113.77' },
          });
          status = response.status;
          if (status === 429) break;
        }
        assert.equal(status, 429, 'melewati batas umum harus dijawab 429');
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.$disconnect();
      if (redisClient.isOpen) await redisClient.quit();
    }
  }
);
