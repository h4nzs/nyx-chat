// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4)] Revokasi sesi (`DELETE /api/sessions/:jti`) sebagai
 * **perilaku**, bukan regex source. Klien Prisma palsu + clock disuntik.
 *
 * Yang dikunci:
 *   1. jti milik user lain → 404 dan TIDAK ada mutasi/blacklist (tidak bocor).
 *   2. jti tidak ada → 404.
 *   3. Sukses → seluruh family di-revoke (`updateMany` sekali) dan hanya JTI
 *      yang belum kedaluwarsa dimasukkan blacklist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { revokeSessionFamily, type RevocableToken } from '../src/utils/sessionRevocation.js';

const NOW = 1_700_000_000_000; // ms

function fakeDb(opts: { token: RevocableToken | null; family: Array<{ jti: string; expiresAt: number }> }) {
  const updateManyCalls: Array<{ where: unknown; data: unknown }> = [];
  const db = {
    refreshToken: {
      findUnique: async () => opts.token,
      updateMany: async (args: { where: unknown; data: unknown }) => {
        updateManyCalls.push(args);
        return { count: 2 };
      },
      findMany: async () => opts.family,
    },
  };
  return { db, updateManyCalls };
}

test('menolak jti milik user lain dengan 404 dan tanpa mutasi', async () => {
  const { db, updateManyCalls } = fakeDb({
    token: { jti: 'j1', familyId: 'f1', deviceId: 'd1', expiresAt: NOW + 1000, device: { userId: 'other-user' } },
    family: [],
  });
  let blacklisted = 0;

  await assert.rejects(
    () => revokeSessionFamily(db, { jti: 'j1', userId: 'me', now: NOW }, async () => { blacklisted++; }),
    (err: unknown) => {
      const e = err as { status?: number };
      assert.equal(e.status, 404);
      return true;
    }
  );
  assert.equal(updateManyCalls.length, 0, 'tidak boleh ada updateMany');
  assert.equal(blacklisted, 0, 'tidak boleh ada blacklist');
});

test('jti tidak ditemukan → 404', async () => {
  const { db } = fakeDb({ token: null, family: [] });
  await assert.rejects(
    () => revokeSessionFamily(db, { jti: 'hilang', userId: 'me', now: NOW }, async () => {}),
    (err: unknown) => (err as { status?: number }).status === 404
  );
});

test('sukses: revoke seluruh family & blacklist hanya JTI belum kedaluwarsa', async () => {
  const { db, updateManyCalls } = fakeDb({
    token: { jti: 'j1', familyId: 'f1', deviceId: 'd1', expiresAt: NOW + 1000, device: { userId: 'me' } },
    family: [
      { jti: 'j1', expiresAt: NOW + 60_000 },
      { jti: 'j2', expiresAt: NOW - 5_000 }, // sudah kedaluwarsa
      { jti: 'j3', expiresAt: NOW + 30_000 },
    ],
  });
  const blacklisted: Array<{ jti: string; ttl: number }> = [];

  const result = await revokeSessionFamily(
    db,
    { jti: 'j1', userId: 'me', now: NOW },
    async (jti, ttl) => { blacklisted.push({ jti, ttl }); }
  );

  assert.equal(updateManyCalls.length, 1);
  assert.deepEqual(updateManyCalls[0]!.where, { familyId: 'f1', revokedAt: null });
  assert.deepEqual((updateManyCalls[0]!.data as { revokedAt: Date }).revokedAt.getTime(), NOW);

  assert.deepEqual(blacklisted.map((b) => b.jti), ['j1', 'j3']);
  assert.equal(blacklisted[0]!.ttl, 60);
  assert.equal(blacklisted[1]!.ttl, 30);
  assert.deepEqual(result, { deviceId: 'd1', familyId: 'f1', revokedJtis: ['j1', 'j3'] });
});
