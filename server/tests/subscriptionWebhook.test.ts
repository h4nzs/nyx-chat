// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Logika uang webhook NOWPayments (`utils/subscriptionWebhook.ts`).
 *
 * Yang dikunci:
 *   1. Kunci idempotensi selalu menunjuk SATU pembayaran (`payment_id` dulu,
 *      `order_id` sebagai cadangan) — dua kiriman IPN yang sama tidak boleh
 *      menaikkan tier dua kali.
 *   2. Periode baru dihitung dari sisa langganan (`max(now, expiry)`), jadi
 *      pembayaran kedua menumpuk, bukan menghapus hari yang tersisa.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextSubscriptionExpiry,
  resolveWebhookPaymentKey,
  SUBSCRIPTION_PERIOD_DAYS,
} from '../src/utils/subscriptionWebhook.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-24T00:00:00.000Z');

test('kunci idempotensi memakai payment_id bila ada', () => {
  assert.equal(
    resolveWebhookPaymentKey({ payment_id: 'pay-1', order_id: 'NYX-PRO-u1-1' }, 'NYX-PRO-u1-1'),
    'pay-1'
  );
});

test('payment_id numerik dinormalkan ke string', () => {
  assert.equal(resolveWebhookPaymentKey({ payment_id: 12345 }, 'order'), '12345');
});

test('tanpa payment_id: jatuh ke order_id (kunci tetap stabil)', () => {
  assert.equal(resolveWebhookPaymentKey({ order_id: 'NYX-PRO-u1-1' }, 'fallback'), 'NYX-PRO-u1-1');
});

test('payment_id kosong/spasi tidak dipakai sebagai kunci', () => {
  assert.equal(resolveWebhookPaymentKey({ payment_id: '   ', order_id: 'ord-1' }, 'fallback'), 'ord-1');
});

test('tanpa keduanya: memakai order_id yang sudah divalidasi pemanggil', () => {
  assert.equal(resolveWebhookPaymentKey({}, 'ord-fallback'), 'ord-fallback');
});

test('langganan baru: 30 hari dari sekarang', () => {
  assert.equal(
    nextSubscriptionExpiry(null, NOW).toISOString(),
    new Date(NOW.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY).toISOString()
  );
});

test('langganan yang masih aktif: periode ditambahkan ke sisa hari', () => {
  const remaining = new Date(NOW.getTime() + 10 * DAY);
  assert.equal(
    nextSubscriptionExpiry(remaining, NOW).toISOString(),
    new Date(remaining.getTime() + 30 * DAY).toISOString()
  );
});

test('langganan yang sudah lewat: mulai dari sekarang, bukan dari masa lalu', () => {
  const expired = new Date(NOW.getTime() - 5 * DAY);
  assert.equal(
    nextSubscriptionExpiry(expired, NOW).toISOString(),
    new Date(NOW.getTime() + 30 * DAY).toISOString()
  );
});

test('jumlah hari bisa diatur (satu sumber kebenaran periode)', () => {
  assert.equal(
    nextSubscriptionExpiry(null, NOW, 1).toISOString(),
    new Date(NOW.getTime() + DAY).toISOString()
  );
});
