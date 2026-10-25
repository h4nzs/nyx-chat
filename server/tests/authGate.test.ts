// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Gerbang token (`utils/authGate.ts`) — "apakah sesi ini
 * masih boleh dipakai?".
 *
 * Uji ini mengunci dua hal yang dulu hanya berlaku di REST:
 *   1. jti yang sudah di-revoke → 401, tanpa menyentuh DB.
 *   2. akun yang di-ban → 403 dari cache MAUPUN dari DB.
 *   3. Saat Redis mati, blacklist dilewati tetapi ban tetap diperiksa lewat DB.
 *   4. Saat Redis DAN DB mati, permintaan lolos (fail-open) — gangguan infra
 *      tidak boleh menjadi pemadaman total.
 *
 * Klien Redis/Prisma palsu; tidak butuh Redis/Postgres nyata.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateTokenGate,
  SUSPENDED_ERROR,
  type TokenGateDb,
  type TokenGateRedis,
} from '../src/utils/authGate.js';

type FakeRedis = TokenGateRedis & { store: Map<string, string>; getThrows?: boolean };

function fakeRedis(opts: { store?: Record<string, string>; getThrows?: boolean } = {}): FakeRedis {
  const store = new Map<string, string>(Object.entries(opts.store ?? {}));
  return {
    store,
    getThrows: opts.getThrows,
    async get(key: string): Promise<string | null> {
      if (opts.getThrows) throw new Error('redis down');
      return store.get(key) ?? null;
    },
    async setEx(key: string, _seconds: number, value: string): Promise<unknown> {
      store.set(key, value);
      return 'OK';
    },
  };
}

function fakeDb(
  user: { bannedAt: Date | null; banReason: string | null } | null,
  opts: { throws?: boolean } = {}
): TokenGateDb & { calls: number } {
  const db = {
    calls: 0,
    user: {
      async findUnique(): Promise<{ bannedAt: Date | null; banReason: string | null } | null> {
        db.calls += 1;
        if (opts.throws) throw new Error('db down');
        return user;
      },
    },
  };
  return db;
}

test('jti yang sudah di-revoke ditolak 401 tanpa menyentuh DB', async () => {
  const redis = fakeRedis({ store: { 'revoked_jti:j1': '1' } });
  const db = fakeDb(null);

  const gate = await evaluateTokenGate({ id: 'u1', jti: 'j1' }, { redis, db });

  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false && gate.status, 401);
  assert.equal(db.calls, 0, 'blacklist saja sudah cukup');
});

test('status ban dari cache ditolak 403 tanpa query DB', async () => {
  const redis = fakeRedis({ store: { 'ban_status:u1': 'BANNED' } });
  const db = fakeDb(null);

  const gate = await evaluateTokenGate({ id: 'u1' }, { redis, db });

  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false && gate.status, 403);
  assert.equal(gate.ok === false && gate.error, SUSPENDED_ERROR);
  assert.equal(db.calls, 0);
});

test('cache miss: ban dari DB ditolak 403 beserta alasannya, lalu di-cache', async () => {
  const redis = fakeRedis();
  const db = fakeDb({ bannedAt: new Date(), banReason: 'spam' });

  const gate = await evaluateTokenGate({ id: 'u1' }, { redis, db });

  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false && gate.reason, 'spam');
  assert.equal(redis.store.get('ban_status:u1'), 'BANNED');
});

test('user bersih: lolos dan status OK di-cache', async () => {
  const redis = fakeRedis();
  const db = fakeDb({ bannedAt: null, banReason: null });

  const gate = await evaluateTokenGate({ id: 'u1' }, { redis, db });

  assert.equal(gate.ok, true);
  assert.equal(db.calls, 1);
  assert.equal(redis.store.get('ban_status:u1'), 'OK');
});

test('Redis mati: blacklist dilewati, ban tetap diperiksa lewat DB', async () => {
  const redis = fakeRedis({ getThrows: true });
  const db = fakeDb({ bannedAt: new Date(), banReason: null });

  const gate = await evaluateTokenGate({ id: 'u1', jti: 'j1' }, { redis, db });

  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false && gate.status, 403);
  assert.equal(gate.ok === false && gate.reason, undefined);
});

test('Redis DAN DB mati: lolos (fail-open), bukan pemadaman total', async () => {
  const redis = fakeRedis({ getThrows: true });
  const db = fakeDb(null, { throws: true });

  const gate = await evaluateTokenGate({ id: 'u1', jti: 'j1' }, { redis, db });

  assert.equal(gate.ok, true);
});
