// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.2 T3] Token deep link push: opaque, acak, terikat ke
 * (user, subscription), dan hanya bisa ditukar oleh pemiliknya. Nilai token
 * tidak boleh memuat id percakapan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PUSH_LINK_TTL_SECONDS,
  createPushLinkToken,
  pushLinkKey,
  resolvePushLinkToken,
  type PushLinkStore,
} from '../src/utils/pushLink.js';

function makeStore() {
  const rows = new Map<string, string>();
  const sets: Array<{ key: string; value: string; options: { EX: number } }> = [];
  const store: PushLinkStore = {
    async set(key, value, options) {
      sets.push({ key, value, options });
      rows.set(key, value);
      return 'OK';
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
  };
  return { store, rows, sets };
}

const OPTS = { userId: 'user-1', subscriptionId: 'sub-1', conversationId: 'conv-1' };

test('[T3] token acak, tersimpan dengan TTL, dan bemapping ke percakapan', async () => {
  const { store, rows, sets } = makeStore();
  const token = await createPushLinkToken(store, OPTS);
  assert.ok(token, 'token dibuat');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '256-bit base64url');
  assert.equal(token.includes('conv-1'), false, 'token tidak memuat id percakapan');
  assert.equal(sets[0]!.options.EX, PUSH_LINK_TTL_SECONDS);
  assert.ok(rows.has(pushLinkKey(token!)));

  const other = await createPushLinkToken(store, OPTS);
  assert.notEqual(other, token, 'setiap pengiriman memakai token baru');

  assert.equal(await resolvePushLinkToken(store, { token: token!, userId: 'user-1' }), 'conv-1');
});

test('[T3] hanya pemilik token yang bisa menukarnya', async () => {
  const { store } = makeStore();
  const token = await createPushLinkToken(store, OPTS);
  assert.equal(await resolvePushLinkToken(store, { token: token!, userId: 'user-2' }), null);
  assert.equal(await resolvePushLinkToken(store, { token: 'x'.repeat(43), userId: 'user-1' }), null);
  assert.equal(await resolvePushLinkToken(store, { token: '', userId: 'user-1' }), null);
});

test('[T3] Redis mati: notifikasi tetap jalan tanpa token', async () => {
  const broken: PushLinkStore = {
    async set() { throw new Error('redis down'); },
    async get() { throw new Error('redis down'); },
  };
  assert.equal(await createPushLinkToken(broken, OPTS), null);
  assert.equal(await resolvePushLinkToken(broken, { token: 'x'.repeat(43), userId: 'user-1' }), null);
});

test('[T3] nilai rusak/asing tidak pernah menghasilkan percakapan', async () => {
  const { store, rows } = makeStore();
  rows.set(pushLinkKey('a'.repeat(43)), 'not-json');
  assert.equal(await resolvePushLinkToken(store, { token: 'a'.repeat(43), userId: 'user-1' }), null);
  rows.set(pushLinkKey('b'.repeat(43)), JSON.stringify({ userId: 'user-1', conversationId: 42 }));
  assert.equal(await resolvePushLinkToken(store, { token: 'b'.repeat(43), userId: 'user-1' }), null);
});
