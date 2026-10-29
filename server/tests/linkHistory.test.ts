// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Kontrak arsip riwayat perangkat hasil link (docs/40).
 *
 * Yang dikunci di sini adalah aturan yang, kalau salah, langsung menjadi celah
 * atau kehilangan data:
 *   1. `ready` hanya sah setelah presign dengan ukuran yang SAMA (presign 4 MB
 *      lalu PUT 40 MB harus ditolak, bukan diterima).
 *   2. `digest` wajib BLAKE2b-256 heksadesimal huruf kecil; `sealedKey` base64url
 *      dengan panjang wajar — bukan blob sembarang.
 *   3. State disimpan TER-SEAL: tidak ada digest/sealedKey yang bisa dibaca
 *      langsung dari Redis.
 *   4. `burnHistory` menghapus state + presign + intent sekaligus, idempoten.
 *   5. Kunci objek R2 deterministik, tanpa deviceId di nama, dan dipisahkan
 *      domain dari kunci backup (prefix + label HMAC berbeda).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LinkingSealer, LinkingStore } from '../src/utils/deviceLinking.js';
import {
  HISTORY_DIGEST_PATTERN,
  HISTORY_SEALED_KEY_MAX_CHARS,
  LINK_HISTORY_INTENT_TTL_SECONDS,
  LINK_HISTORY_PRESIGN_TTL_SECONDS,
  LINK_HISTORY_TTL_SECONDS,
  burnHistory,
  hasHistoryIntent,
  historyIntentKey,
  historyPresignKey,
  historyStateKey,
  markHistoryIntent,
  markHistoryReady,
  readHistoryState,
  recordHistoryPresign,
  validateHistoryUpload,
} from '../src/utils/linkHistory.js';
import {
  LINK_HISTORY_FILE_EXTENSION,
  LINK_HISTORY_MIN_BYTES,
  LINK_HISTORY_OBJECT_PREFIX,
  LINK_HISTORY_SANDBOX_MAX_BYTES,
  deriveLinkHistoryObjectKey,
  historySizeLimit,
  validateHistorySize,
} from '../src/utils/linkHistoryObject.js';

const DEVICE = 'device-aaaaaaaa';
const DIGEST = 'b'.repeat(64);

function makeStore(): LinkingStore & { data: Map<string, string>; ttl: Map<string, number> } {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    data,
    ttl,
    async get(key) {
      return data.get(key) ?? null;
    },
    async setEx(key, seconds, value) {
      data.set(key, value);
      ttl.set(key, seconds);
      return 'OK';
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (data.delete(key)) removed += 1;
      }
      return removed;
    },
    async getDel(key) {
      const value = data.get(key) ?? null;
      data.delete(key);
      return value;
    },
  };
}

const sealer: LinkingSealer = {
  async seal(plaintext) {
    return `sealed:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  },
  async open(sealed) {
    if (!sealed || !sealed.startsWith('sealed:')) return null;
    return Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8');
  },
};

const validUpload = { size: 4096, digest: DIGEST, sealedKey: 'A'.repeat(1200) };

// ─── validasi isi ──────────────────────────────────────────────────────────

test('validateHistoryUpload menerima isian yang sah', () => {
  const result = validateHistoryUpload(validUpload);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.size, 4096);
    assert.equal(result.digest, DIGEST);
  }
});

test('validateHistoryUpload menolak size, digest, dan sealedKey yang tidak sah', () => {
  for (const size of [0, -1, 1.5, '4096', null, undefined]) {
    const result = validateHistoryUpload({ ...validUpload, size });
    assert.equal(result.ok, false, `size ${String(size)} harus ditolak`);
  }
  for (const digest of ['', 'B'.repeat(64), 'b'.repeat(63), 'z'.repeat(64), 123]) {
    const result = validateHistoryUpload({ ...validUpload, digest });
    assert.equal(result.ok, false, `digest ${String(digest)} harus ditolak`);
  }
  for (const sealedKey of ['', 'A'.repeat(HISTORY_SEALED_KEY_MAX_CHARS + 1), 'not base64url!', 42]) {
    const result = validateHistoryUpload({ ...validUpload, sealedKey });
    assert.equal(result.ok, false, 'sealedKey tidak sah harus ditolak');
  }
});

test('pola digest yang dipakai route = 64 hex huruf kecil', () => {
  assert.equal(HISTORY_DIGEST_PATTERN.test('a1'.repeat(32)), true);
  assert.equal(HISTORY_DIGEST_PATTERN.test('A1'.repeat(32)), false);
});

// ─── state machine ─────────────────────────────────────────────────────────

test('ready tanpa presign ditolak', async () => {
  const store = makeStore();
  const result = await markHistoryReady(store, sealer, DEVICE, validUpload);
  assert.deepEqual(result, { ok: false, reason: 'no_presign' });
  assert.equal(store.data.has(historyStateKey(DEVICE)), false);
});

test('ready dengan ukuran berbeda dari presign ditolak', async () => {
  const store = makeStore();
  await recordHistoryPresign(store, sealer, DEVICE, 1024);
  const result = await markHistoryReady(store, sealer, DEVICE, validUpload);
  assert.deepEqual(result, { ok: false, reason: 'size_mismatch' });
  assert.equal(store.data.has(historyStateKey(DEVICE)), false);
});

test('ready yang sah menyimpan state ter-seal + TTL 30 menit', async () => {
  const store = makeStore();
  await recordHistoryPresign(store, sealer, DEVICE, validUpload.size);

  const result = await markHistoryReady(store, sealer, DEVICE, validUpload);
  assert.equal(result.ok, true);
  assert.equal(store.ttl.get(historyStateKey(DEVICE)), LINK_HISTORY_TTL_SECONDS);
  assert.equal(store.ttl.get(historyPresignKey(DEVICE)), LINK_HISTORY_PRESIGN_TTL_SECONDS);

  // Tidak ada nilai identitas yang tersimpan mentah.
  const raw = store.data.get(historyStateKey(DEVICE))!;
  assert.equal(raw.startsWith('sealed:'), true);
  assert.equal(raw.includes(DIGEST), false);

  const state = await readHistoryState(store, sealer, DEVICE);
  assert.ok(state);
  assert.equal(state.size, validUpload.size);
  assert.equal(state.digest, DIGEST);
  assert.equal(state.sealedKey, validUpload.sealedKey);
});

test('readHistoryState mengembalikan null untuk state rusak / tidak ada', async () => {
  const store = makeStore();
  assert.equal(await readHistoryState(store, sealer, DEVICE), null);

  store.data.set(historyStateKey(DEVICE), 'bukan-sealed');
  assert.equal(await readHistoryState(store, sealer, DEVICE), null);

  // Bentuk sah tapi isinya tidak lolos validasi (digest rusak).
  store.data.set(
    historyStateKey(DEVICE),
    await sealer.seal(JSON.stringify({ size: 100, digest: 'x', sealedKey: 'A', at: 1 }))
  );
  assert.equal(await readHistoryState(store, sealer, DEVICE), null);
});

test('burnHistory menghapus state + presign + intent, idempoten', async () => {
  const store = makeStore();
  await markHistoryIntent(store, DEVICE);
  await recordHistoryPresign(store, sealer, DEVICE, validUpload.size);
  await markHistoryReady(store, sealer, DEVICE, validUpload);

  const burned = await burnHistory(store, sealer, DEVICE);
  assert.equal(burned?.digest, DIGEST);
  assert.equal(store.data.has(historyStateKey(DEVICE)), false);
  assert.equal(store.data.has(historyPresignKey(DEVICE)), false);
  assert.equal(store.data.has(historyIntentKey(DEVICE)), false);

  assert.equal(await burnHistory(store, sealer, DEVICE), null);
});

test('intent memakai TTL sendiri dan hilang saat dibakar', async () => {
  const store = makeStore();
  assert.equal(await hasHistoryIntent(store, DEVICE), false);

  await markHistoryIntent(store, DEVICE);
  assert.equal(await hasHistoryIntent(store, DEVICE), true);
  assert.equal(store.ttl.get(historyIntentKey(DEVICE)), LINK_HISTORY_INTENT_TTL_SECONDS);

  await burnHistory(store, sealer, DEVICE);
  assert.equal(await hasHistoryIntent(store, DEVICE), false);
});

// ─── kunci objek & kuota ───────────────────────────────────────────────────

test('kunci objek deterministik, tanpa deviceId, domain terpisah dari backup', () => {
  const secret = 'test-secret';
  const key = deriveLinkHistoryObjectKey(secret, DEVICE);

  assert.equal(key, deriveLinkHistoryObjectKey(secret, DEVICE));
  assert.notEqual(key, deriveLinkHistoryObjectKey(secret, 'device-bbbbbbbb'));
  assert.notEqual(key, deriveLinkHistoryObjectKey('other-secret', DEVICE));
  assert.equal(key.startsWith(LINK_HISTORY_OBJECT_PREFIX), true);
  assert.equal(key.endsWith(`.${LINK_HISTORY_FILE_EXTENSION}`), true);
  assert.equal(key.includes(DEVICE), false);
  assert.match(key, /^link-history\/[0-9a-f]{64}\.nyxhist$/);
});

test('kunci objek menolak deviceId/rahasia kosong', () => {
  assert.throws(() => deriveLinkHistoryObjectKey('secret', ''));
  assert.throws(() => deriveLinkHistoryObjectKey('', DEVICE));
});

test('validateHistorySize menegakkan minimum, kuota tier, dan menjepit TTL', () => {
  const verified = { tier: 'FREE', verified: true };
  assert.equal(validateHistorySize(LINK_HISTORY_MIN_BYTES - 1, undefined, verified).ok, false);

  const free = validateHistorySize(50 * 1024 * 1024, 999_999, verified);
  assert.equal(free.ok, true);
  if (free.ok) assert.equal(free.urlTtl, 900); // dijepit ke batas atas

  // 200 MB: boleh untuk SUBSCRIBER, tidak untuk FREE.
  assert.equal(
    validateHistorySize(200 * 1024 * 1024, undefined, { tier: 'SUBSCRIBER', verified: true }).ok,
    true
  );
  assert.equal(validateHistorySize(200 * 1024 * 1024, undefined, verified).ok, false);
  assert.equal(
    validateHistorySize(200 * 1024 * 1024, undefined, { tier: null, verified: true }).ok,
    false
  );
});

test('historySizeLimit satu sumber dengan penegakan presign', () => {
  // Angka yang dikirim `GET /history/limits` harus sama dengan yang dipakai
  // `validateHistorySize`; kalau tidak, klien memeriksa kuota yang salah.
  assert.equal(historySizeLimit({ tier: 'FREE', verified: true }), 100 * 1024 * 1024);
  assert.equal(historySizeLimit({ tier: 'SUBSCRIBER', verified: true }), 500 * 1024 * 1024);
  assert.equal(historySizeLimit({ tier: null, verified: true }), 100 * 1024 * 1024);
  assert.equal(historySizeLimit({ tier: 'SUBSCRIBER', verified: false }), LINK_HISTORY_SANDBOX_MAX_BYTES);

  const limit = historySizeLimit({ tier: 'FREE', verified: true });
  assert.equal(validateHistorySize(limit, undefined, { tier: 'FREE', verified: true }).ok, true);
  assert.equal(validateHistorySize(limit + 1, undefined, { tier: 'FREE', verified: true }).ok, false);
});

test('akun belum terverifikasi boleh, tetapi dibatasi 25 MB', () => {
  const sandbox = { tier: 'FREE', verified: false };
  assert.equal(validateHistorySize(20 * 1024 * 1024, undefined, sandbox).ok, true);
  assert.equal(validateHistorySize(30 * 1024 * 1024, undefined, sandbox).ok, false);
  // Subscriber yang belum terverifikasi tetap tidak mendapat 500 MB.
  assert.equal(
    validateHistorySize(30 * 1024 * 1024, undefined, { tier: 'SUBSCRIBER', verified: false }).ok,
    false
  );
});
