// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §5.7] TURN/STUN: tidak ada fallback ke pihak ketiga.
 *
 * Sebelum perbaikan, tiga jalur gagal di `GET /api/keys/turn` (env TURN kosong,
 * Cloudflare tidak mengembalikan `iceServers`, dan error transient) sama-sama
 * mengembalikan `stun:stun.l.google.com:19302`; klien juga punya fallback yang
 * sama ketika request-nya gagal. Efeknya: IP klien bocor ke Google tepat pada
 * momen paling sensitif (panggilan gagal) dan operator tidak pernah tahu
 * TURN-nya mati.
 *
 * Sekarang: STUN pihak ketiga tidak dipakai sama sekali. Operator boleh
 * mendeklarasikan STUN-nya sendiri (`ICE_STUN_URLS`, mis. coturn), dan tanpa itu
 * kegagalan TURN menjadi error yang TERLIHAT (503/502 + kode error).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

test('29 §5.7: server tidak punya jalur STUN pihak ketiga', () => {
  const keys = read('../src/routes/keys.ts');
  assert.doesNotMatch(keys, /google/i, 'tidak ada referensi Google (regresi bocor IP)');
  // Hanya URL STUN/STUNS hardcoded yang dilarang (identifier seperti `stunOnly`
  // atau parameter `stun: string[]` bukan pelanggaran).
  assert.doesNotMatch(keys, /['"`]stuns?:/i, 'tidak ada STUN hardcoded — hanya dari env operator');
  assert.match(keys, /ICE_STUN_URLS/, 'STUN operator dideklarasikan lewat env');
  assert.match(keys, /TURN_NOT_CONFIGURED/, 'env TURN kosong = error terlihat');
  assert.match(keys, /TURN_UNAVAILABLE/, 'kegagalan Cloudflare = error terlihat');
  assert.match(keys, /res\.status\(503\)/, 'status 503 saat TURN tidak dikonfigurasi');
  assert.match(keys, /res\.status\(502\)/, 'status 502 saat TURN gagal di sisi upstream');
  // Sukses normal tetap membawa iceServers Cloudflare apa adanya (cadangan).
  assert.match(keys, /iceServers: data\.iceServers/);
  // [docs/30 WS-E(1)] coturn self-host jadi primer: kredensial HMAC dari env,
  // bukan URL hardcoded, dan identitas memakai identityTag (bukan userId).
  assert.match(keys, /TURN_STATIC_AUTH_SECRET/, 'coturn secret dibaca dari env');
  assert.match(keys, /parseTurnUrls/, 'TURN_URLS diparsing dari env');
  assert.match(keys, /mintTurnCredential/, 'kredensial coturn di-terbitkan server');
  assert.match(keys, /identityTag\(/, 'username TURN memakai tag, bukan userId');
});

test('29 §5.7: klien tidak mengganti kegagalan dengan STUN pihak ketiga', () => {
  const webrtc = read('../../web/src/lib/webrtc.ts');
  assert.doesNotMatch(webrtc, /google/i, 'tidak ada STUN Google di klien');
  assert.doesNotMatch(webrtc, /['"`]stuns?:/i, 'tidak ada STUN hardcoded di klien');
  assert.match(webrtc, /export const isIceUnavailable/, 'status kegagalan TURN bisa dibaca UI');
  assert.match(webrtc, /iceUnavailable = true/, 'kegagalan ditandai, bukan ditutupi');
  assert.match(webrtc, /errors:call_no_turn/, 'kegagalan TURN diberitahukan ke user');
});

test('29 §5.7: kunci i18n call_no_turn ada di keempat bahasa', () => {
  for (const lang of ['en', 'es', 'id', 'pt-BR']) {
    const p = path.join(here, '..', '..', 'web', 'public', 'locales', lang, 'errors.json');
    assert.ok(existsSync(p), `locale ${lang} ada`);
    assert.match(read(`../../web/public/locales/${lang}/errors.json`), /"call_no_turn"/,
      `kunci call_no_turn wajib ada di ${lang} (aturan 4 bahasa)`);
  }
});

test('29 §5.7 + 30 §30.9: env template menyediakan ICE_STUN_URLS dan coturn', () => {
  for (const p of ['../.env.example', '../../.env.example']) {
    const content = read(p);
    assert.match(content, /ICE_STUN_URLS/, `${p} harus memuat ICE_STUN_URLS`);
    assert.match(content, /TURN_STATIC_AUTH_SECRET/, `${p} harus memuat TURN_STATIC_AUTH_SECRET (coturn)`);
    assert.match(content, /TURN_URLS/, `${p} harus memuat TURN_URLS (coturn)`);
  }
});
