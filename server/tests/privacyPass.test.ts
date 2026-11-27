// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.4.1] Privacy Pass token acak + komitmen: issuance, binding
 * percakapan, double-spend, TTL, dan bentuk rusak. Tidak ada RSA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  PP_TOKEN_TTL_SEC,
  ppCommitmentForToken,
  ppIssueCommitments,
  ppRedeemToken,
} from '../src/utils/privacyPass.js';

function newToken (): string {
  return randomBytes(32).toString('base64url');
}

function commitmentOf (token: string): string {
  return createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url');
}

/** Redis tiruan dengan `GET` + `SET { EX, NX }` — cukup untuk kedua fase. */
function fakeRedis () {
  const store = new Map<string, string>();
  const sets: Array<{ key: string; ttl: number }> = [];
  const redis = {
    async get (key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set (key: string, value: string, options: { EX: number; NX: true }): Promise<string | null> {
      assert.equal(value, '1');
      assert.ok(options && typeof options === 'object', 'SET wajib memakai objek opsi');
      assert.equal(options.NX, true, 'NX wajib: tanpa itu token bisa di-replay');
      assert.ok(options.EX > 0, 'EX wajib: tanpa itu key tumbuh tanpa batas');
      if (store.has(key)) return null;
      store.set(key, value);
      sets.push({ key, ttl: options.EX });
      return 'OK';
    },
  };
  return { redis, store, sets };
}

test('privacy pass: komitmen diterbitkan, token hanya sah di percakapan asalnya', async () => {
  const token = newToken();
  const other = newToken();
  const { redis } = fakeRedis();

  assert.equal(await ppIssueCommitments(redis, 'conv-alpha', [commitmentOf(token), commitmentOf(other)]), 2);
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', token), 'ok');
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', token), 'spent');
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', other), 'ok');

  const third = newToken();
  assert.equal(await ppIssueCommitments(redis, 'conv-alpha', [commitmentOf(third)]), 1);
  assert.equal(await ppRedeemToken(redis, 'conv-beta', third), 'invalid', 'binding percakapan harus gagal');
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', third), 'ok');
});

test('privacy pass: token/komitmen tidak pernah tersimpan mentah, TTL 24 jam', async () => {
  const token = newToken();
  const commitment = commitmentOf(token);
  const { redis, store, sets } = fakeRedis();

  await ppIssueCommitments(redis, 'conv-alpha', [commitment]);
  await ppRedeemToken(redis, 'conv-alpha', token);

  assert.deepEqual(sets.map((entry) => entry.ttl), [PP_TOKEN_TTL_SEC, PP_TOKEN_TTL_SEC]);
  for (const key of store.keys()) {
    assert.equal(key.includes(token), false, 'key tidak boleh memuat token');
    assert.equal(key.includes(commitment), false, 'key tidak boleh memuat komitmen');
    assert.match(key, /^pp:(issued|spent):[a-f0-9]{64}$/);
  }
});

test('privacy pass: token yang tidak pernah diterbitkan / rusak ditolak', async () => {
  const { redis } = fakeRedis();
  const token = newToken();
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', token), 'invalid');

  await ppIssueCommitments(redis, 'conv-alpha', [commitmentOf(token)]);
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', 'not-a-token'), 'invalid');
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', Buffer.alloc(31).toString('base64url')), 'invalid');
  assert.equal(ppCommitmentForToken('not-a-token'), null);
});

test('privacy pass: komitmen duplikat / tidak sah tidak diterbitkan setengah jadi', async () => {
  const token = newToken();
  const commitment = commitmentOf(token);
  const { redis } = fakeRedis();

  assert.equal(await ppIssueCommitments(redis, 'conv-alpha', [commitment]), 1);
  assert.equal(await ppIssueCommitments(redis, 'conv-alpha', [commitment]), 0, 'duplikat tidak diterima lagi');
  await assert.rejects(
    () => ppIssueCommitments(redis, 'conv-alpha', ['AAAA']),
    /PP_INVALID_COMMITMENT/,
  );
  await assert.rejects(
    () => ppIssueCommitments(redis, 'conv-alpha', Array.from({ length: 11 }, () => commitmentOf(newToken()))),
    /PP_INVALID_COMMITMENT_COUNT/,
  );
});
