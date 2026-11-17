// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.2 T3] Payload push tidak boleh memuat `conversationId` atau
 * `messageId`: provider push (dan operatornya) tidak boleh bisa mengorelasikan
 * perangkat, percakapan, dan irama pesan. Isi pesan tetap opaque di
 * `encryptedPushPayload`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPushPayload } from '../src/utils/sendPushNotification.js';

test('[T3] payload push tanpa id percakapan/pesan (jalur terenkripsi)', () => {
  const payload = buildPushPayload(
    {
      type: 'ENCRYPTED_MESSAGE',
      // Field server-only: harus TIDAK ikut terserialisasi.
      conversationId: 'conv-rahasia',
      data: { pushPayloadMap: { device1: 'opaque-cipher' } },
    },
    'opaque-cipher',
    'token-opaque'
  );
  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /conversationId|messageId|conv-rahasia/, 'tidak ada id di payload');
  assert.equal(payload.data.encryptedPushPayload, 'opaque-cipher');
  assert.equal(payload.data.pushToken, 'token-opaque', 'deep link lewat token opaque');
  assert.equal(payload.type, 'ENCRYPTED_MESSAGE');
});

test('[T3] payload push generik juga hanya sinyal "ada pesan"', () => {
  const payload = buildPushPayload({ type: 'GENERIC_MESSAGE' }, undefined);
  assert.deepEqual(payload.data, {}, 'tanpa data tambahan');
  assert.equal(payload.type, 'GENERIC_MESSAGE');
  assert.doesNotMatch(JSON.stringify(payload), /conversationId|messageId/);
});
