// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-31 — F-09] Batas `GET /api/conversations/sync?ids=`.
 *
 * Tanpa cap, satu request bisa memaksa `IN` berisi puluhan ribu id. Bentuk id
 * juga divalidasi supaya nilai sampah tidak ikut ke query.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SYNC_CONVERSATION_IDS,
  parseSyncConversationIds,
} from '../src/routes/conversations.js';

test('ids kosong / bukan string → daftar kosong', () => {
  assert.deepEqual(parseSyncConversationIds(undefined), []);
  assert.deepEqual(parseSyncConversationIds(''), []);
  assert.deepEqual(parseSyncConversationIds(['a', 'b']), []);
});

test('id valid diparse, spasi dipangkas, duplikat dibuang', () => {
  assert.deepEqual(
    parseSyncConversationIds(' conv_1 , conv-2,conv_1,  ,'),
    ['conv_1', 'conv-2']
  );
});

test('id berbentuk aneh dibuang (bukan diteruskan ke query)', () => {
  const parsed = parseSyncConversationIds('ok_1,%00garbage,../etc/passwd,ok_1');
  assert.deepEqual(parsed, ['ok_1']);
});

test('lebih dari batas → dipotong tepat di batas', () => {
  const raw = Array.from({ length: MAX_SYNC_CONVERSATION_IDS + 250 }, (_, i) => `c${i}`).join(',');
  const parsed = parseSyncConversationIds(raw);
  assert.equal(parsed.length, MAX_SYNC_CONVERSATION_IDS);
  assert.equal(parsed[0], 'c0');
});
