// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(2)] Alamat relay panggilan — diuji sebagai perilaku dengan
 * Redis palsu (tanpa Redis/Postgres).
 *
 * Properti yang dikunci:
 *   1. Token berbentuk acak-ketat; **userId ditolak** sebagai token (tidak ada
 *      jalur kompatibilitas yang diam-diam menganggap userId = token).
 *   2. Peta Redis tidak memuat userId mentah — key memakai tag, nilai ter-seal.
 *   3. Relay fail-closed: token tak dikenal → tidak ada paket keluar dan tidak
 *      ada token pengirim yang diterbitkan (tidak ada efek samping).
 *   4. Envelope yang sampai ke peer hanya memuat token pengirim, bukan userId
 *      siapa pun (inilah properti "percobaan call tidak ter-link ke akun").
 *   5. Token pengirim idempoten per sesi (relay kedua tidak menerbitkan ulang).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALL_RELAY_TOKEN_TTL_SECONDS,
  buildCallRelayEnvelope,
  callRelayTokenKey,
  callRelayUserKey,
  currentCallRelayToken,
  ensureCallRelayToken,
  isCallRelayToken,
  newCallRelayToken,
  relayCallSignal,
  resolveCallRelayToken,
} from '../src/utils/callRelayTokens.js';

class FakeRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  writes = 0;

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setEx(key: string, seconds: number, value: string): Promise<'OK'> {
    this.writes++;
    this.store.set(key, value);
    this.ttls.set(key, seconds);
    return 'OK';
  }
}

const USER = 'user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PEER = 'user-11111111-2222-3333-4444-555555555555';

test('bentuk token: 32 karakter base64url, dan userId BUKAN token', () => {
  const token = newCallRelayToken();
  assert.equal(token.length, 32);
  assert.ok(isCallRelayToken(token));

  // Nilai dari dunia nyata tidak boleh lolos.
  assert.equal(isCallRelayToken(USER), false);
  assert.equal(isCallRelayToken(token.slice(0, 31)), false);
  assert.equal(isCallRelayToken(`${token}a`), false);
  // Karakter di luar alfabet base64url & padding '=' (deterministik, bukan
  // bergantung apakah token acak kebetulan memuat '-' atau '_').
  assert.equal(isCallRelayToken('+'.repeat(32)), false);
  assert.equal(isCallRelayToken(`${token.slice(0, 31)}=`), false);
  assert.equal(isCallRelayToken(undefined), false);
  assert.equal(isCallRelayToken(123), false);

  // Dua token berturut-turut tidak sama (bukan turunan userId).
  assert.notEqual(newCallRelayToken(), newCallRelayToken());
});

test('peta Redis: key memakai tag, nilai ter-seal (tanpa userId mentah)', async () => {
  const redis = new FakeRedis();
  const token = await ensureCallRelayToken(redis, { userId: USER, deviceId: 'dev-1' });

  assert.ok(!callRelayUserKey(USER).includes(USER), 'key peta balik tidak boleh memuat userId');
  assert.equal(callRelayUserKey(USER), callRelayUserKey(USER));

  const record = redis.store.get(callRelayTokenKey(token));
  assert.ok(record, 'record token harus ada');
  assert.ok(!record!.includes(USER), 'record tidak boleh memuat userId mentah');
  assert.ok(record!.includes('dev-1'), 'deviceId tetap dipakai untuk routing perangkat');
});

test('issue → resolve: userId + deviceId pulih, TTL dipasang di kedua key', async () => {
  const redis = new FakeRedis();
  const token = await ensureCallRelayToken(redis, { userId: USER, deviceId: 'dev-7' });

  assert.deepEqual(await resolveCallRelayToken(redis, token), { userId: USER, deviceId: 'dev-7' });
  assert.equal(redis.ttls.get(callRelayTokenKey(token)), CALL_RELAY_TOKEN_TTL_SECONDS);
  assert.equal(redis.ttls.get(callRelayUserKey(USER)), CALL_RELAY_TOKEN_TTL_SECONDS);
  assert.equal(await currentCallRelayToken(redis, USER), token);
});

test('deviceId kosong → null (relay ke semua perangkat user)', async () => {
  const redis = new FakeRedis();
  const token = await ensureCallRelayToken(redis, { userId: USER, deviceId: null });
  assert.deepEqual(await resolveCallRelayToken(redis, token), { userId: USER, deviceId: null });
});

test('ensure idempoten: token aktif dipakai ulang, tidak menerbitkan yang baru', async () => {
  const redis = new FakeRedis();
  const first = await ensureCallRelayToken(redis, { userId: USER, deviceId: 'dev-1' });
  const writesAfterFirst = redis.writes;
  const second = await ensureCallRelayToken(redis, { userId: USER, deviceId: 'dev-2' });

  assert.equal(second, first);
  assert.equal(redis.writes, writesAfterFirst, 'ensure tidak boleh menulis Redis lagi');
  // Sesi pertama tetap pemilik deviceId-nya (rotasi device lewat AUTH, bukan relay).
  assert.deepEqual(await resolveCallRelayToken(redis, first), { userId: USER, deviceId: 'dev-1' });
});

test('resolve menolak: token tak dikenal, bentuk salah, record rusak', async () => {
  const redis = new FakeRedis();

  assert.equal(await resolveCallRelayToken(redis, 'a'.repeat(32)), null);
  assert.equal(await resolveCallRelayToken(redis, USER), null);
  assert.equal(await resolveCallRelayToken(redis, null), null);

  const token = newCallRelayToken();
  await redis.setEx(callRelayTokenKey(token), 60, 'bukan-json');
  assert.equal(await resolveCallRelayToken(redis, token), null);

  const token2 = newCallRelayToken();
  await redis.setEx(callRelayTokenKey(token2), 60, JSON.stringify({ identity: 'bukan-ciphertext', deviceId: null }));
  assert.equal(await resolveCallRelayToken(redis, token2), null);
});

test('relay fail-closed: token tak dikenal tidak mengirim apa pun dan tidak menerbitkan token', async () => {
  const redis = new FakeRedis();
  const decision = await relayCallSignal(redis, {
    fromUserId: USER,
    fromDeviceId: 'dev-1',
    payload: { to: 'x'.repeat(32), type: 'offer', payload: 'enc' },
  });

  assert.equal(decision, null);
  assert.equal(redis.writes, 0, 'tidak ada token pengirim yang diterbitkan saat token tujuan salah');

  // Bentuk lama (to: userId) juga ditolak — bukan perlakuan khusus.
  const legacy = await relayCallSignal(redis, {
    fromUserId: USER,
    fromDeviceId: 'dev-1',
    payload: { to: PEER, type: 'offer', payload: 'enc' },
  });
  assert.equal(legacy, null);
  assert.equal(redis.writes, 0);
});

test('relay sukses: peer hanya melihat token, tidak pernah userId siapa pun', async () => {
  const redis = new FakeRedis();
  const peerToken = await ensureCallRelayToken(redis, { userId: PEER, deviceId: 'peer-dev' });

  const decision = await relayCallSignal(redis, {
    fromUserId: USER,
    fromDeviceId: 'dev-1',
    payload: { to: peerToken, type: 'offer', payload: 'ciphertext-blob' },
  });

  assert.ok(decision);
  assert.deepEqual(decision!.target, { userId: PEER, deviceId: 'peer-dev' });
  assert.equal(decision!.envelope.type, 'offer');
  assert.equal(decision!.envelope.payload, 'ciphertext-blob');

  // Envelope: `from` = token pengirim (bukan userId), dan tokennya berbeda dari token tujuan.
  assert.ok(isCallRelayToken(decision!.envelope.from));
  assert.notEqual(decision!.envelope.from, peerToken);
  const serialized = JSON.stringify(decision!.envelope);
  assert.ok(!serialized.includes(USER));
  assert.ok(!serialized.includes(PEER));

  // Pengirim kini punya token aktif → relay kedua memakainya lagi (tanpa tulis baru).
  const writesAfterFirst = redis.writes;
  const second = await relayCallSignal(redis, {
    fromUserId: USER,
    fromDeviceId: 'dev-1',
    payload: { to: peerToken, type: 'ice-candidate', payload: 'candidate' },
  });
  assert.equal(second?.envelope.from, decision!.envelope.from);
  assert.equal(redis.writes, writesAfterFirst);
  assert.equal(await currentCallRelayToken(redis, USER), decision!.envelope.from);
});

test('buildCallRelayEnvelope: bentuk keluaran terkunci (from/type/payload saja)', () => {
  const token = newCallRelayToken();
  const envelope = buildCallRelayEnvelope(token, { type: 'answer', payload: 'enc' });
  assert.deepEqual(Object.keys(envelope).sort(), ['from', 'payload', 'type']);
  assert.equal(envelope.from, token);
});
