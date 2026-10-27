// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Privacy Pass blind-RSA token: roundtrip nyata melalui
 * pustaka (bukan mock), binding percakapan, double-spend, dan bentuk rusak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import {
  clearPpKeyCacheForTests,
  decodePpToken,
  encodePpToken,
  loadPpIssuerKeys,
  newPpNonce,
  ppBlindSign,
  ppMessage,
  ppRedeemToken,
  ppVerifyToken,
} from '../src/utils/privacyPass.js';

const suite = RSABSSA.SHA384.PSS.Deterministic();

/** Simulasikan klien: blind → (server) sign → finalize. */
async function issueToken (conversationId: string): Promise<string> {
  const keys = await loadPpIssuerKeys();
  const nonce = newPpNonce();
  const msg = ppMessage(conversationId, nonce);
  const { blindedMsg, inv } = await suite.blind(keys.publicKey, msg);
  const [blindSig] = await ppBlindSign([Buffer.from(blindedMsg).toString('base64url')]);
  const signature = await suite.finalize(
    keys.publicKey,
    msg,
    new Uint8Array(Buffer.from(blindSig!, 'base64url')),
    inv
  );
  return encodePpToken(nonce, signature);
}

test('privacy pass: token yang diterbitkan terverifikasi untuk percakapan yang sama', async () => {
  clearPpKeyCacheForTests();
  const token = await issueToken('conv-alpha');
  assert.equal(await ppVerifyToken('conv-alpha', token), true);
});

test('privacy pass: token tidak bisa dipakai di percakapan lain (binding groupId)', async () => {
  clearPpKeyCacheForTests();
  const token = await issueToken('conv-alpha');
  assert.equal(await ppVerifyToken('conv-beta', token), false);
});

test('privacy pass: token yang diubah / bentuk rusak ditolak', async () => {
  clearPpKeyCacheForTests();
  const token = await issueToken('conv-alpha');
  const decoded = decodePpToken(token)!;
  assert.ok(decoded.signature.length === 256);

  const tampered = encodePpToken(decoded.nonce, decoded.signature.map((b, i) => (i === 0 ? b ^ 1 : b)));
  assert.equal(await ppVerifyToken('conv-alpha', tampered), false);
  assert.equal(await ppVerifyToken('conv-alpha', 'not-a-token'), false);
  assert.equal(await ppVerifyToken('conv-alpha', Buffer.alloc(10).toString('base64url')), false);
  assert.equal(decodePpToken(undefined), null);
});

/**
 * Fake Redis yang **hanya** mengenal `SET key value { EX, NX }`.
 *
 * [audit F-01] Bentuk posisional (`'EX', ttl, 'NX'`) harus gagal di sini:
 * itulah bentuk yang diabaikan node-redis 6 dan membuat token bisa di-replay
 * tanpa TTL. Fake menolak argumen yang bukan objek opsi.
 */
function fakeRedis () {
  const spent = new Map<string, number>();
  const redis = {
    async set (key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<'OK' | null> {
      assert.equal(value, '1');
      assert.ok(options && typeof options === 'object', 'SET wajib memakai objek opsi, bukan argumen posisional');
      assert.equal(options.NX, true, 'NX wajib: tanpa itu token bisa di-replay');
      assert.ok(typeof options.EX === 'number' && options.EX > 0, 'EX wajib: tanpa itu key pp:spent tumbuh tanpa batas');
      if (spent.has(key)) return null;
      spent.set(key, options.EX);
      return 'OK';
    },
  };
  return { redis, spent };
}

test('privacy pass: redeem sekali pakai (double-spend ditolak, TTL diset)', async () => {
  clearPpKeyCacheForTests();
  const token = await issueToken('conv-alpha');
  const { redis, spent } = fakeRedis();

  assert.equal(await ppRedeemToken(redis, 'conv-alpha', token), 'ok');
  assert.equal(await ppRedeemToken(redis, 'conv-alpha', token), 'spent');
  assert.equal(await ppRedeemToken(redis, 'conv-beta', token), 'invalid', 'binding gagal sebelum menyentuh Redis');
  assert.equal(spent.size, 1, 'hanya token yang lolos binding yang menyentuh Redis');
  assert.deepEqual([...spent.values()], [24 * 60 * 60], 'TTL = umur token');
});

test('privacy pass: blindSign menolak pesan ter-blind dengan panjang salah', async () => {
  clearPpKeyCacheForTests();
  await assert.rejects(() => ppBlindSign(['AAAA']), /PP_INVALID_BLINDED_MESSAGE/);
});
