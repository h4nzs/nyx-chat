// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Batas GUEST (`utils/guestPolicy.ts`).
 *
 * Identitas guest dibuat tanpa syarat oleh `POST /api/auth/burner`, jadi
 * pembatasan harus menempel pada DATA yang boleh dikirim, bukan hanya pada
 * bucket rate limit per-user (yang ikut dibuat ulang bersama identitasnya).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BURNER_EVENT_RATE_LIMIT,
  GUEST_CHAT_RATE_LIMIT,
  GUEST_MAX_RECIPIENTS,
  MAX_RECIPIENTS,
  maxRecipientsFor,
} from '../src/utils/guestPolicy.js';

test('guest hanya boleh menyebut sedikit penerima, akun normal tetap 500', () => {
  assert.equal(maxRecipientsFor('guest_1a2b3c4d'), GUEST_MAX_RECIPIENTS);
  assert.equal(maxRecipientsFor('9f1c2d3e-aaaa-bbbb-cccc-1234567890ab'), MAX_RECIPIENTS);
  assert.ok(GUEST_MAX_RECIPIENTS < MAX_RECIPIENTS);
});

test('jatah chat guest lebih kecil dari akun normal (120/menit)', () => {
  assert.ok(GUEST_CHAT_RATE_LIMIT.limit < 120);
  assert.equal(GUEST_CHAT_RATE_LIMIT.windowSeconds, 60);
});

test('event burner punya batas sendiri (fan-out ke seluruh anggota room)', () => {
  assert.ok(BURNER_EVENT_RATE_LIMIT.limit > 0);
  assert.ok(BURNER_EVENT_RATE_LIMIT.limit < 120);
});
