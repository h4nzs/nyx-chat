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
 *   - Login memakai `usernameHash` = Argon2id 64MB client-side. Skrip ini
 *     menghitungnya lewat helper Node kalau `NYX_USERNAME_HASH` tidak diberikan.
 */

import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import crypto from 'k6/crypto';

const relaySend = new Trend('nyx_relay_send_duration', true);
const relayFetch = new Trend('nyx_relay_fetch_duration', true);
const relayErrors = new Rate('nyx_relay_errors');

export const options = {
  scenarios: {
    relay: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 }, // ramp
        { duration: '2m', target: 500 },  // beban target (500 user konkuren)
        { duration: '1m', target: 500 },  // tahan
        { duration: '30s', target: 0 },   // turun
      ],
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

/** Token CSRF + header yang wajib ada di setiap request ber-mutasi. */
function csrfToken(installationId) {
  const res = http.get(`${BASE_URL}/api/csrf-token`, {
    headers: { 'x-nyx-installation-id': installationId },
    tags: { kind: 'setup' },
  });
  if (res.status !== 200) fail(`csrf-token gagal: ${res.status}`);
  return res.json('csrfToken');
}

export function setup() {
  if (!USER || !PASS || !CONVERSATION_ID) {
    fail('Set NYX_USER, NYX_PASS, dan NYX_CONVERSATION_ID (lihat header skrip).');
  }
  // Anchor instalasi per-VU-batch: server memakai ini untuk binding perangkat.
  const installationId = `k6-${crypto.md5(String(Date.now()), 'hex').slice(0, 16)}`;
  const token = csrfToken(installationId);

  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      usernameHash: usernameHash(),
      password: PASS,
      deviceName: 'k6 load test',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'CSRF-Token': token,
        'x-nyx-installation-id': installationId,
        'x-nyx-fingerprint': installationId,
      },
      tags: { kind: 'setup' },
    }
  );
  if (loginRes.status !== 200) {
    fail(`login gagal: ${loginRes.status} ${String(loginRes.body).slice(0, 200)}`);
  }

  return {
    csrfToken: token,
    installationId,
    // Cookie sesi (HttpOnly) ditangani cookie jar k6 — tidak perlu dikirim manual.
    conversationId: CONVERSATION_ID,
  };
}

export function relayOps(data) {
  const headers = {
    'Content-Type': 'application/json',
    'CSRF-Token': data.csrfToken,
    'x-nyx-installation-id': data.installationId,
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
  relayErrors.add(sendRes.status >= 500);
  check(sendRes, { 'send 2xx/4xx terdefinisi': (r) => r.status > 0 && r.status < 500 });

  // 2. Relay ambil halaman pesan (kursor seq).
  const fetchRes = http.get(`${BASE_URL}/api/messages/${data.conversationId}?limit=50`, {
    headers,
    tags: { kind: 'relay' },
  });
  relayFetch.add(fetchRes.timings.duration);
  relayErrors.add(fetchRes.status >= 500);
  check(fetchRes, { 'fetch 200': (r) => r.status === 200 });
}
