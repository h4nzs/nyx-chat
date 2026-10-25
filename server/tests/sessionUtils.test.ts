// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BURNER GUEST / /drop] Refresh token guest ephemeral tidak pernah dipersist
 * (lihat `issueTokens`), jadi `POST /api/auth/refresh` untuk guest selalu
 * berakhir "token tidak ditemukan". Yang dikunci di sini:
 *
 *   1. Predikat subjek guest hanya mengenali prefix `guest_` (bukan user biasa).
 *   2. Guardrail wiring: route refresh memeriksa predikat itu SEBELUM
 *      `clearAuthCookies` — kalau urutannya dibalik, setiap bootstrap halaman
 *      `/drop` menghapus cookie `at` yang masih sah dan uplink burner tidak
 *      pernah naik (ESTABLISHING_UPLINK selamanya).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { authCookieOptions, isEphemeralGuestSubject } from '../src/utils/sessionUtils.js';
import { env } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('isEphemeralGuestSubject: hanya subjek `guest_*` yang ephemeral', () => {
  assert.equal(isEphemeralGuestSubject('guest_ab12cd34'), true);
  assert.equal(isEphemeralGuestSubject('usr_ab12cd34'), false);
  assert.equal(isEphemeralGuestSubject('guest'), false, 'tanpa underscore bukan id guest yang valid');
  assert.equal(isEphemeralGuestSubject('GUEST_ab12'), false);
  assert.equal(isEphemeralGuestSubject(undefined), false);
  assert.equal(isEphemeralGuestSubject(null), false);
  assert.equal(isEphemeralGuestSubject(42), false);
});

// [OPS 2026-10-25] Insiden realtime: cookie sesi host-only tidak dikirim ke
// `api.nyx-app.my.id` (host socket.io) sehingga handshake ditolak `unauthorized`.
// Test ini mengunci dua hal: COOKIE_DOMAIN benar-benar masuk ke opsi cookie, dan
// set/clear memakai SATU sumber opsi (kalau `domain` hanya ada saat set, logout
// meninggalkan cookie yang tak pernah terhapus).
test('authCookieOptions: COOKIE_DOMAIN ikut ke cookie sesi; kosong = host-only', () => {
  const original = env.cookieDomain;
  try {
    env.cookieDomain = undefined;
    assert.equal(
      authCookieOptions().domain,
      undefined,
      'tanpa COOKIE_DOMAIN cookie tetap host-only (benar untuk self-host satu domain)'
    );

    env.cookieDomain = '.nyx-app.my.id';
    const options = authCookieOptions();
    assert.equal(options.domain, '.nyx-app.my.id');
    assert.equal(options.path, '/');
    assert.equal(options.httpOnly, true);
  } finally {
    env.cookieDomain = original;
  }
});

test('guardrail: set dan clear cookie sesi memakai authCookieOptions() yang sama', () => {
  const sessionSrc = readFileSync(path.join(here, '../src/utils/sessionUtils.ts'), 'utf8');
  assert.match(
    sessionSrc,
    /export function clearAuthCookies[\s\S]{0,300}authCookieOptions\(\)/,
    'clearAuthCookies harus memakai authCookieOptions()'
  );

  const authSrc = readFileSync(path.join(here, '../src/routes/auth.ts'), 'utf8');
  assert.match(
    authSrc,
    /function setAuthCookies[\s\S]{0,600}authCookieOptions\(\)/,
    'setAuthCookies harus memakai authCookieOptions()'
  );
});

test('guardrail: /api/auth/refresh menolak guest TANPA clearAuthCookies', () => {
  const src = readFileSync(path.join(here, '../src/routes/auth.ts'), 'utf8');

  const guestBranch = src.indexOf('isEphemeralGuestSubject(payload.sub)');
  assert.ok(guestBranch > 0, 'route refresh harus memakai isEphemeralGuestSubject');

  // Satu-satunya clearAuthCookies di blok "token tidak ditemukan" harus berada
  // SETELAH cabang guest (cookie `at` guest tetap hidup).
  const afterGuestBranch = src.slice(guestBranch);
  const nextClear = afterGuestBranch.indexOf('clearAuthCookies(res)');
  const guestThrow = afterGuestBranch.indexOf("Guest sessions are ephemeral");
  assert.ok(nextClear > guestThrow, 'clearAuthCookies harus setelah cabang guest');
});
