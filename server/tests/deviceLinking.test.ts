// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Kontrak state machine QR device-linking (utils/deviceLinking.ts).
 *
 * Yang dikunci di sini adalah aturan yang, kalau salah, langsung menjadi celah
 * keamanan atau UX rusak:
 *   1. Token QR hanya sah bila berbentuk hex 64 karakter dan hanya bisa dipakai
 *      SEKALI (`consumeLinkToken` membakarnya).
 *   2. Tidak ada nilai identitas yang tersimpan mentah di Redis — semuanya
 *      lewat sealer (di test: prefix `sealed:`).
 *   3. Persetujuan hanya boleh dari user pemilik pending, dan approve kedua
 *      tidak boleh membuat device kedua.
 *   4. Perangkat baru tidak mungkin "complete" sebelum perangkat lama approve.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LINK_PENDING_TTL_SECONDS,
  approvePendingLink,
  consumeLinkToken,
  createPendingLink,
  denyPendingLink,
  getLinkState,
  linkStateKey,
  linkTokenKey,
  pendingLinkKey,
  readLinkToken,
  readPendingLink,
  takeApprovedLink,
  type LinkingSealer,
  type LinkingStore,
  type PendingDeviceLink,
} from '../src/utils/deviceLinking.js';

const TOKEN = 'a'.repeat(64);

function makeStore(seed: Record<string, string> = {}): LinkingStore & { data: Map<string, string>; ttl: Map<string, number> } {
  const data = new Map(Object.entries(seed));
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

const pending: PendingDeviceLink = {
  userId: 'user-1',
  requestDeviceId: 'device-old',
  deviceName: 'Pixel 9',
  publicKey: 'pub-new',
  pqPublicKey: 'pq-new',
  signingKey: 'sign-new',
  encryptedPrivateKey: 'enc-new',
  // Binding hardware perangkat BARU (dikumpulkan saat claim, bukan saat approve).
  fingerprint: 'fp-new-device',
  installationTag: 'tag-new-device',
};

function seededTokenStore(): ReturnType<typeof makeStore> {
  return makeStore({
    [linkTokenKey(TOKEN)]: `sealed:${Buffer.from(JSON.stringify({ userId: 'user-1', deviceId: 'device-old' })).toString('base64')}`,
  });
}

test('token QR: bentuk salah atau tidak dikenal ditolak tanpa menyentuh store', async () => {
  const store = seededTokenStore();
  assert.equal(await readLinkToken(store, sealer, 'bukan-hex'), null);
  assert.equal(await readLinkToken(store, sealer, 'A'.repeat(64)), null, 'heks huruf besar bukan format token');
  assert.equal(await readLinkToken(store, sealer, 'b'.repeat(64)), null, 'token tak dikenal');
  assert.equal(await consumeLinkToken(store, sealer, 'b'.repeat(64)), null);
  assert.equal(store.data.has(linkTokenKey('b'.repeat(64))), false);
});

test('token QR: read tidak membakar, consume membakar (sekali pakai)', async () => {
  const store = seededTokenStore();
  const first = await readLinkToken(store, sealer, TOKEN);
  assert.deepEqual(first, { userId: 'user-1', deviceId: 'device-old' });
  assert.equal(store.data.has(linkTokenKey(TOKEN)), true, 'read tidak boleh membakar token');

  const consumed = await consumeLinkToken(store, sealer, TOKEN);
  assert.deepEqual(consumed, { userId: 'user-1', deviceId: 'device-old' });
  assert.equal(store.data.has(linkTokenKey(TOKEN)), false, 'consume wajib membakar token');
  assert.equal(await consumeLinkToken(store, sealer, TOKEN), null, 'token yang sudah dipakai tidak sah');
});

test('token QR: dua claim berbarengan — hanya satu yang mendapat token (GETDEL)', async () => {
  const store = seededTokenStore();

  // Tanpa GETDEL, GET+DEL berbarengan bisa sama-sama lolos. Sekarang hanya satu
  // pemanggil yang menerima nilai; sisanya null.
  const results = await Promise.all([
    consumeLinkToken(store, sealer, TOKEN),
    consumeLinkToken(store, sealer, TOKEN),
  ]);
  const accepted = results.filter((owner) => owner !== null);
  assert.equal(accepted.length, 1, 'satu token QR = satu claim');
  assert.equal(store.data.has(linkTokenKey(TOKEN)), false);
});

test('nilai di Redis ter-seal: userId & nama perangkat tidak terbaca dari store', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);

  const rawPending = store.data.get(pendingLinkKey(pendingId)) ?? '';
  assert.match(rawPending, /^sealed:/);
  assert.equal(rawPending.includes('user-1'), false);
  assert.equal(rawPending.includes('Pixel 9'), false);

  const rawState = store.data.get(linkStateKey(pendingId)) ?? '';
  assert.equal(rawState, 'pending', 'state bukan identitas — boleh plaintext');
  assert.equal(store.ttl.get(pendingLinkKey(pendingId)), LINK_PENDING_TTL_SECONDS);
});

test('pending yang sudah dibuat bisa dibaca utuh dan state-nya pending', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);
  assert.deepEqual(await readPendingLink(store, sealer, pendingId), pending);
  assert.equal(await getLinkState(store, pendingId), 'pending');
  assert.equal(await getLinkState(store, 'tidak-ada'), 'expired');
});

test('perangkat baru tidak bisa complete sebelum approve', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);

  const beforeApproval = await takeApprovedLink(store, sealer, pendingId);
  assert.equal(beforeApproval, null);
  assert.equal(await getLinkState(store, pendingId), 'pending', 'state tetap pending setelah percobaan gagal');
});

test('approve oleh user lain ditolak; approve benar menyimpan deviceId', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);

  assert.equal(await approvePendingLink(store, sealer, pendingId, 'user-lain', 'dev-1'), null);
  assert.equal(await getLinkState(store, pendingId), 'pending');

  const approved = await approvePendingLink(store, sealer, pendingId, 'user-1', 'dev-new');
  assert.deepEqual(approved, { pending, deviceId: 'dev-new' });
  assert.equal(await getLinkState(store, pendingId), 'approved');
});

test('signingKeyV2 perangkat baru ikut tersimpan di pending dan terbaca kembali', async () => {
  const store = makeStore();
  const withV2: PendingDeviceLink = { ...pending, signingKeyV2: 'v2-pub' };
  const pendingId = await createPendingLink(store, sealer, withV2);
  assert.deepEqual(await readPendingLink(store, sealer, pendingId), withV2);
  assert.deepEqual(await approvePendingLink(store, sealer, pendingId, 'user-1', 'dev-new'), { pending: withV2, deviceId: 'dev-new' });
});

test('approve kedua tidak boleh membuat device kedua', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);

  assert.deepEqual(await approvePendingLink(store, sealer, pendingId, 'user-1', 'dev-new'), { pending, deviceId: 'dev-new' });
  assert.equal(await approvePendingLink(store, sealer, pendingId, 'user-1', 'dev-lain'), null);
});

test('complete setelah approve mengembalikan deviceId dan membersihkan semua state', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);
  await approvePendingLink(store, sealer, pendingId, 'user-1', 'dev-new');

  const taken = await takeApprovedLink(store, sealer, pendingId);
  assert.deepEqual(taken, { pending, deviceId: 'dev-new' });
  assert.equal(store.data.has(pendingLinkKey(pendingId)), false);
  assert.equal(store.data.has(linkStateKey(pendingId)), false);
  assert.equal(await getLinkState(store, pendingId), 'expired');
  assert.equal(await takeApprovedLink(store, sealer, pendingId), null, 'complete hanya sekali');
});

test('deny menghapus pending sehingga tidak bisa di-approve/complete', async () => {
  const store = makeStore();
  const pendingId = await createPendingLink(store, sealer, pending);

  await denyPendingLink(store, pendingId);
  assert.equal(await getLinkState(store, pendingId), 'expired');
  assert.equal(await approvePendingLink(store, sealer, pendingId, 'user-1', 'dev-new'), null);
  assert.equal(await takeApprovedLink(store, sealer, pendingId), null);
});

test('pending rusak/tidak lengkap dianggap tidak ada (fail-closed)', async () => {
  const store = makeStore({
    [pendingLinkKey('rusak')]: `sealed:${Buffer.from(JSON.stringify({ userId: 'user-1' })).toString('base64')}`,
  });
  assert.equal(await readPendingLink(store, sealer, 'rusak'), null);
  assert.equal(
    await approvePendingLink(store, sealer, 'rusak', 'user-1', 'dev-new'),
    null,
    'pending tanpa kunci wajib tidak bisa disetujui',
  );
});
