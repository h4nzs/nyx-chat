// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 3 — N3-01] Gerbang tulis `SessionKey`.
 *
 * Yang dikunci: baris `SessionKey` adalah bukti keanggotaan di jalur lain, jadi
 * hanya peserta TERBUKTI (baris keanggotaan / receipt bertag, BUKAN SessionKey
 * itu sendiri) yang boleh menulisnya, dan hanya untuk perangkat nyata miliknya
 * atau milik peserta lain yang juga terbukti. Tanpa ini, siapa pun yang punya
 * akun bisa mencetak keanggotaan lalu memakai gate pass 2 (view-once, typing,
 * presence) terhadap percakapan orang lain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAtRestSecretCacheForTests,
  conversationScopedTag,
  sealAtRest,
} from '../src/utils/atRestSecrets.js';
import {
  authorizeSessionKeyRelay,
  MAX_RELAY_KEYS,
  type SessionKeyRelayGuardDb,
} from '../src/utils/sessionKeyRelayGuard.js';

process.env.NYX_AT_REST_PEPPER = 'session-key-guard-pepper-'.padEnd(64, 'k');
clearAtRestSecretCacheForTests();

const CONV = 'conv-1';
const KEY = 'a'.repeat(44);

interface FakeOpts {
  /** Anggota menurut baris keanggotaan server (nilai ter-seal). */
  members?: string[];
  /** User yang sudah punya receipt di percakapan ini. */
  receipts?: string[];
  /** deviceId → userId pemilik. */
  devices?: Record<string, string>;
  /** deviceId yang punya baris `SessionKey` bertanda `issuedByServer` (dari pembuatan percakapan). */
  issuedByServerDeviceIds?: string[];
  /** deviceId yang sudah terdaftar di percakapan (baris `SessionKey` apa pun). */
  enrolledDeviceIds?: string[];
}

async function makeDb (opts: FakeOpts = {}) {
  const sealed = new Map<string, string>();
  for (const member of opts.members ?? []) sealed.set(await sealAtRest(member), member);
  const receiptTags = new Set((opts.receipts ?? []).map((u) => conversationScopedTag(CONV, u)));
  const devices = opts.devices ?? {};
  const calls = { receipts: 0, devices: 0, members: 0 };

  const db = {
    userHiddenConversation: {
      async findMany (args: { where: { conversationId?: string; userId?: { in?: string[] } } }) {
        calls.members += 1;
        const { where } = args;
        if (where.conversationId !== CONV) return [];
        return (where.userId?.in ?? [])
          .filter((candidate) => sealed.has(candidate))
          .map((userId) => ({ userId }));
      },
      async findFirst () { return null; },
    },
    messageStatus: {
      async findMany (args: { where: { userId?: { in?: string[] }; message?: { conversationId?: string } } }) {
        calls.receipts += 1;
        const { where } = args;
        if (where.message?.conversationId !== CONV) return [];
        const wanted = new Set(where.userId?.in ?? []);
        const found: Array<{ userId: string }> = [];
        for (const userId of opts.receipts ?? []) {
          const tag = conversationScopedTag(CONV, userId);
          if (wanted.has(tag) && receiptTags.has(tag)) found.push({ userId: tag });
        }
        return found;
      },
      async findFirst () { return null; },
    },
    device: {
      async findMany (args: { where: { id?: { in?: string[] } } }) {
        calls.devices += 1;
        return (args.where.id?.in ?? [])
          .filter((id) => typeof devices[id] === 'string')
          .map((id) => ({ id, userId: devices[id]! }));
      },
    },
    sessionKey: {
      async findMany (args: {
        where: { conversationId?: string; issuedByServer?: boolean; deviceId?: { in?: string[] } }
      }) {
        const { where } = args;
        if (where.conversationId !== CONV) return [];
        if (where.issuedByServer === true) {
          // Baris pembuatan percakapan: bukti peserta bootstrap.
          return (opts.issuedByServerDeviceIds ?? [])
            .filter((id) => typeof devices[id] === 'string')
            .map((id) => ({ device: { userId: devices[id]! } }));
        }
        const wanted = new Set(where.deviceId?.in ?? []);
        return (opts.enrolledDeviceIds ?? [])
          .filter((id) => wanted.has(id))
          .map((deviceId) => ({ deviceId }));
      },
    },
  };

  return { db: db as unknown as SessionKeyRelayGuardDb, calls };
}

const keysFor = (...deviceIds: string[]) =>
  deviceIds.map((deviceId) => ({ deviceId, encryptedKey: KEY }));

test('N3-01: user di luar percakapan tidak boleh menulis SessionKey (403, tanpa tulis)', async () => {
  const { db, calls } = await makeDb({
    members: ['u-a', 'u-b'],
    devices: { 'dev-attacker': 'u-attacker' },
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-attacker',
    sessionId: 'sess-1',
    keys: keysFor('dev-attacker'),
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.status, 403);
  assert.match(decision.error, /SESSION_KEY_NOT_PARTICIPANT/);
  assert.equal(calls.devices, 0, 'berhenti sebelum menyentuh tabel perangkat');
});

test('N3-01: peserta lewat baris keanggotaan boleh menulis untuk perangkatnya sendiri', async () => {
  const { db } = await makeDb({
    members: ['u-a', 'u-b'],
    devices: { 'dev-a1': 'u-a', 'dev-a2': 'u-a' },
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1', 'dev-a2'),
  });

  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.deepEqual(decision.keys.map((k) => k.deviceId), ['dev-a1', 'dev-a2']);
});

test('N3-01: 1:1 boleh memakai bukti receipt (tanpa baris keanggotaan)', async () => {
  const { db } = await makeDb({
    receipts: ['u-a', 'u-b'],
    devices: { 'dev-a1': 'u-a', 'dev-b1': 'u-b' },
    // Perangkat peer sudah terdaftar oleh pembuatan percakapan → ini rotasi.
    enrolledDeviceIds: ['dev-b1'],
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1', 'dev-b1'),
  });

  assert.equal(decision.ok, true);
});

test('N3-01: perangkat orang lain yang belum pernah ada di percakapan ditolak', async () => {
  const { db } = await makeDb({
    members: ['u-a', 'u-b'],
    devices: { 'dev-a1': 'u-a', 'dev-victim': 'u-victim' },
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1', 'dev-victim'),
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.status, 403);
  assert.match(decision.error, /SESSION_KEY_NOT_ENROLLED/);
});

test('N3-01: perangkat terdaftar milik non-peserta tetap ditolak (baris warisan)', async () => {
  const { db } = await makeDb({
    members: ['u-a', 'u-b'],
    devices: { 'dev-a1': 'u-a', 'dev-victim': 'u-victim' },
    // Baris lama bisa saja ada untuk orang yang bukan peserta; itu bukan izin.
    enrolledDeviceIds: ['dev-victim'],
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1', 'dev-victim'),
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /SESSION_KEY_UNKNOWN_PEER/);
});

test('N3-01: bukti bootstrap = baris SessionKey yang ditulis server saat pembuatan', async () => {
  // 1:1 baru: belum ada receipt, belum ada baris keanggotaan — hanya baris
  // pembuatan (`issuedByServer`) untuk perangkat pemanggil.
  const { db } = await makeDb({
    devices: { 'dev-a1': 'u-a' },
    issuedByServerDeviceIds: ['dev-a1'],
    enrolledDeviceIds: ['dev-a1'],
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1'),
  });

  assert.equal(decision.ok, true);
});

test('N3-01: perangkat pemanggil sendiri tidak butuh baris terdaftar, tapi pemanggil tetap harus terbukti', async () => {
  const { db } = await makeDb({ devices: { 'dev-a1': 'u-a' } });

  // Tanpa bukti peserta apa pun: perangkat sendiri pun tidak cukup.
  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1'),
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /SESSION_KEY_NOT_PARTICIPANT/);
});

test('N3-01: deviceId yang tidak terdaftar ditolak', async () => {
  const { db } = await makeDb({
    members: ['u-a'],
    devices: { 'dev-a1': 'u-a' },
  });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1', 'dev-ghost'),
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.error, /SESSION_KEY_UNKNOWN_DEVICE/);
});

test('N3-01: payload dibatasi dan divalidasi (cap, base64url, sessionId)', async () => {
  const { db } = await makeDb({ members: ['u-a'], devices: { 'dev-a1': 'u-a' } });
  const base = { conversationId: CONV, callerId: 'u-a', sessionId: 'sess-1' };

  const tooMany = await authorizeSessionKeyRelay(db, {
    ...base,
    keys: Array.from({ length: MAX_RELAY_KEYS + 1 }, (_, i) => ({ deviceId: `d${i}`, encryptedKey: KEY })),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.status, 400);

  const badShape = await authorizeSessionKeyRelay(db, {
    ...base,
    keys: [{ deviceId: 'dev-a1', encryptedKey: 'bukan/base64url!' }],
  });
  assert.equal(badShape.ok, false);

  const badSession = await authorizeSessionKeyRelay(db, { ...base, sessionId: '', keys: keysFor('dev-a1') });
  assert.equal(badSession.ok, false);

  const notArray = await authorizeSessionKeyRelay(db, { ...base, keys: 'nope' });
  assert.equal(notArray.ok, false);
});

test('N3-01: deviceId duplikat dalam satu request digabung (tidak menulis dua kali)', async () => {
  const { db } = await makeDb({ members: ['u-a'], devices: { 'dev-a1': 'u-a' } });

  const decision = await authorizeSessionKeyRelay(db, {
    conversationId: CONV,
    callerId: 'u-a',
    sessionId: 'sess-1',
    keys: keysFor('dev-a1', 'dev-a1', 'dev-a1'),
  });

  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.keys.length, 1);
});
