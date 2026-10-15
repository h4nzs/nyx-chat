// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/27 §27.7 + docs/30 WS-G] Load test jalur relay (REST fallback).
 *
 * Target acceptance (docs/30 §30.15, milestone M1):
 *   - 500 user konkuren, ~20 pesan/s agregat
 *   - p95 < 200 ms untuk operasi relay (kirim + ambil pesan)
 *   - error rate < 1%
 *
 * Cara pakai (butuh server + Postgres + Redis hidup; JANGAN ke arah produksi
 * tanpa izin — skrip ini MENULIS pesan ke DB):
 *
 *   BASE_URL=http://127.0.0.1:4000 \
 *   NYX_USER=han NYX_PASS='CorrectHorseBatteryStaple123!' \
 *   NYX_CONVERSATION_ID=<uuid> \
 *   k6 run scripts/load/relay.k6.js
 *
 * Catatan penting:
 *   - Jalur WebTransport/WSS (opcode biner) TIDAK diuji di sini: k6 tidak
 *     punya WebTransport. Yang diukur adalah jalur REST relay (`POST /api/messages`
 *     dan `GET /api/messages/:conversationId`) — jalur fallback yang juga
 *     menanggung relay server-side (delivery, token, seq). Pengukuran WT perlu
 *     harness browser (lihat docs/11).
 *   - Login memakai `usernameHash` = Argon2id 64MB client-side. Nilainya TIDAK
 *     bisa dihitung di dalam k6; siapkan akun + nilainya dengan
 *     `pnpm --filter nyx-server exec tsx scripts/load-test-user.ts --exports`.
 *   - Sesi: login dilakukan SEKALI di `setup()` (Argon2id 64MB × 500 VU = RSS
 *     server meledak). Cookie sesi hasil login diteruskan manual sebagai header
 *     `Cookie` ke setiap VU — cookie jar k6 bersifat per-VU, jadi tanpa ini semua
 *     VU hanya mengukur 401 (dan itu tampak seperti "p95 cepat").
 *   - `NYX_ITER_SLEEP_SECONDS` (default 25): jeda antar iterasi per VU. 500 VU
 *     tanpa jeda ≈ ribuan req/s, bukan beban target (≈20 pesan/s agregat) —
 *     p95-nya lalu mengukur hal yang berbeda dari gate docs/30 §30.15.
 */

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import crypto from 'k6/crypto';

const relaySend = new Trend('nyx_relay_send_duration', true);
const relayFetch = new Trend('nyx_relay_fetch_duration', true);
const relayErrors = new Rate('nyx_relay_errors');

/**
 * Tahapan beban. `NYX_SMOKE=1` memakai profil kecil (validasi harness: sesi
 * benar-benar terbawa, 201 + 200) supaya drill penuh 500 VU hanya dijalankan
 * setelah harness-nya terbukti. `NYX_MAX_VUS` menurunkan puncak VU tanpa
 * mengubah bentuk tahapan (mis. mesin lokal 4 core).
 */
const MAX_VUS = Number(__ENV.NYX_MAX_VUS || 500);

const stages = __ENV.NYX_SMOKE === '1'
  ? [
      { duration: '5s', target: 5 },
      { duration: '15s', target: 5 },
      { duration: '5s', target: 0 },
    ]
  : [
      { duration: '30s', target: Math.round(MAX_VUS * 0.2) }, // ramp
      { duration: '2m', target: MAX_VUS },                    // beban target
      { duration: '1m', target: MAX_VUS },                    // tahan
      { duration: '30s', target: 0 },                         // turun
    ];

export const options = {
  scenarios: {
    relay: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      exec: 'relayOps',
    },
  },
  thresholds: {
    // Gate M1: latency relay dan error rate.
    nyx_relay_send_duration: ['p(95)<200'],
    nyx_relay_fetch_duration: ['p(95)<200'],
    'http_req_failed': ['rate<0.01'],
    nyx_relay_errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000';
const USER = __ENV.NYX_USER || '';
const PASS = __ENV.NYX_PASS || '';
const CONVERSATION_ID = __ENV.NYX_CONVERSATION_ID || '';
// Device milik akun load test. Tanpa ini login tetap 200 tetapi `deviceId` kosong
// (alur pemulihan), sehingga sesi tidak terikat perangkat seperti di produksi.
const DEVICE_ID = __ENV.NYX_DEVICE_ID || '';

/**
 * `usernameHash` NYX = base64url(Argon2id(username.toLowerCase(), "NYX_BLIND_IDX_V1",
 * m=64MB, t=3, p=1)). Argon2id TIDAK tersedia di runtime k6, jadi nilainya harus
 * dihitung di luar (Node/web worker) dan diteruskan lewat env.
 */
function usernameHash() {
  const provided = __ENV.NYX_USERNAME_HASH;
  if (provided) return provided;
  fail(
    'NYX_USERNAME_HASH wajib diisi (hitung di luar: op `hashUsername` di web/src/workers/crypto.worker.ts ' +
    'atau Node dengan hash-wasm). Hash tidak bisa dihitung di dalam k6.'
  );
}

/** Rangkai `Set-Cookie` hasil respons menjadi satu header `Cookie`. */
function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .map(([, jar]) => `${jar[0].name}=${jar[0].value}`)
    .join('; ');
}

/**
 * Token CSRF + cookie-nya. Server memakai double-submit: header `csrf-token`
 * HARUS cocok dengan cookie `x-csrf-token`, dan cookie itu hidup di cookie jar
 * KONTEKS yang memanggil endpoint ini (`setup`). VU punya jar sendiri, jadi
 * cookie CSRF ikut dirangkai manual ke header `Cookie` — tanpa itu setiap
 * mutasi dijawab 403 `Invalid CSRF token` (bukan 401), yang mudah disalah-
 * artikan sebagai masalah autentikasi/p95.
 */
function csrfToken(installationId) {
  const res = http.get(`${BASE_URL}/api/csrf-token`, {
    headers: { 'x-nyx-installation-id': installationId },
    tags: { kind: 'setup' },
  });
  if (res.status !== 200) fail(`csrf-token gagal: ${res.status}`);
  return { token: res.json('csrfToken'), cookie: cookieHeader(res.cookies) };
}

export function setup() {
  if (!USER || !PASS || !CONVERSATION_ID) {
    fail('Set NYX_USER, NYX_PASS, dan NYX_CONVERSATION_ID (lihat header skrip).');
  }
  if (!DEVICE_ID) {
    fail('Set NYX_DEVICE_ID (jalankan: pnpm --filter nyx-server exec tsx scripts/load-test-user.ts --exports).');
  }
  // Anchor instalasi per-VU-batch: server memakai ini untuk binding perangkat.
  const installationId = `k6-${crypto.md5(String(Date.now()), 'hex').slice(0, 16)}`;
  const csrf = csrfToken(installationId);

  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      usernameHash: usernameHash(),
      password: PASS,
      deviceId: DEVICE_ID,
      deviceName: 'k6 load test',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'CSRF-Token': csrf.token,
        'x-nyx-installation-id': installationId,
        'x-nyx-fingerprint': installationId,
      },
      tags: { kind: 'setup' },
    }
  );
  if (loginRes.status !== 200) {
    fail(`login gagal: ${loginRes.status} ${String(loginRes.body).slice(0, 200)}`);
  }

  const sessionCookie = cookieHeader(loginRes.cookies);
  if (!sessionCookie) fail('login 200 tapi tidak ada cookie sesi (Set-Cookie kosong).');
  // Sesi dulu, lalu cookie CSRF (nama berbeda, jadi tidak ada bentrok).
  const cookie = [sessionCookie, csrf.cookie].filter(Boolean).join('; ');

  return {
    csrfToken: csrf.token,
    installationId,
    cookie,
    conversationId: CONVERSATION_ID,
  };
}

const ITER_SLEEP_SECONDS = Number(__ENV.NYX_ITER_SLEEP_SECONDS || 25);

export function relayOps(data) {
  const headers = {
    'Content-Type': 'application/json',
    'CSRF-Token': data.csrfToken,
    'x-nyx-installation-id': data.installationId,
    Cookie: data.cookie,
  };

  // 1. Relay kirim (payload adalah ciphertext; server tidak bisa membacanya).
  const sendRes = http.post(
    `${BASE_URL}/api/messages`,
    JSON.stringify({
      conversationId: data.conversationId,
      content: `k6-${__VU}-${__ITER}`, // placeholder ciphertext (server opaque)
      tempId: `k6-${__VU}-${__ITER}`,
    }),
    { headers, tags: { kind: 'relay' } }
  );
  relaySend.add(sendRes.timings.duration);
  // 4xx ikut dihitung error: 401/403 berarti sesi tidak terbawa, dan itu bukan
  // hasil pengukuran relay yang sah.
  relayErrors.add(sendRes.status >= 400);
  check(sendRes, { 'send 201': (r) => r.status === 201 });

  // 2. Relay ambil halaman pesan (kursor seq).
  const fetchRes = http.get(`${BASE_URL}/api/messages/${data.conversationId}?limit=50`, {
    headers,
    tags: { kind: 'relay' },
  });
  relayFetch.add(fetchRes.timings.duration);
  relayErrors.add(fetchRes.status >= 400);
  check(fetchRes, { 'fetch 200': (r) => r.status === 200 });

  if (ITER_SLEEP_SECONDS > 0) sleep(ITER_SLEEP_SECONDS);
}
