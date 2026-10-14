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

import { isEphemeralGuestSubject } from '../src/utils/sessionUtils.js';

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
