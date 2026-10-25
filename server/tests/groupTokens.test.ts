// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.1] Unit test model token grup/anggota.
 *
 * Yang dikunci di sini adalah perilaku yang tidak boleh "longgar" saat refactor:
 * token mentah tidak pernah disimpan, epoch menentukan keabsahan, dan rotasi
 * menaikkan epoch secara atomik (bukan read-then-write).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMemberToken,
  groupTokenExpiry,
  groupTokenMatches,
  hashGroupToken,
  isOpaqueToken,
  memberTokenExpiry,
  newOpaqueToken,
  refreshMemberToken,
  rotateGroupToken,
  MEMBER_TOKEN_TTL_MS,
  TOKEN_REFRESH_GRACE_MS,
  type GroupTokenDb,
} from '../src/utils/groupTokens.js';

const TOKEN = 'A'.repeat(43);

test('bentuk token: 43-char base64url, 256-bit acak', () => {
  assert.ok(isOpaqueToken(TOKEN));
  assert.ok(!isOpaqueToken('A'.repeat(22)), 'token 128-bit lama ditolak');
  assert.ok(!isOpaqueToken('A'.repeat(44)));
  assert.ok(!isOpaqueToken('A'.repeat(42) + '+'));
  assert.ok(!isOpaqueToken(undefined));

  const generated = newOpaqueToken();
  assert.ok(isOpaqueToken(generated), 'token baru berbentuk tepat');
  assert.notEqual(newOpaqueToken(), generated, 'tidak deterministik');
});

test('hash: SHA-256 hex, deterministik, beda token beda hash', () => {
  const hash = hashGroupToken(TOKEN);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hashGroupToken(TOKEN), hash);
  assert.notEqual(hashGroupToken('B'.repeat(43)), hash);
});

test('groupTokenMatches: hanya token yang hash-nya cocok (timing-safe compare)', () => {
  const stored = hashGroupToken(TOKEN);
  assert.equal(groupTokenMatches(stored, TOKEN), true);
  assert.equal(groupTokenMatches(stored, 'B'.repeat(43)), false);
  assert.equal(groupTokenMatches(null, TOKEN), false);
  assert.equal(groupTokenMatches(stored, ''), false);
});

test('evaluateMemberToken: epoch mismatch = stale, grace 24 jam, refresh di 25% terakhir', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

  assert.equal(evaluateMemberToken({ tokenEpoch: 2, expiresAt: inDays(7) }, 2, now), 'ok');
  assert.equal(evaluateMemberToken({ tokenEpoch: 1, expiresAt: inDays(7) }, 2, now), 'stale',
    'epoch lama tidak dihidupkan oleh TTL panjang');
  assert.equal(
    evaluateMemberToken({ tokenEpoch: 2, expiresAt: new Date(now.getTime() - TOKEN_REFRESH_GRACE_MS - 1000) }, 2, now),
    'stale',
    'kedaluwarsa melewati grace = mati'
  );
  assert.equal(
    evaluateMemberToken({ tokenEpoch: 2, expiresAt: new Date(now.getTime() - 1000) }, 2, now),
    'refresh',
    'baru saja kedaluwarsa masih boleh pull + refresh'
  );
  assert.equal(
    evaluateMemberToken({ tokenEpoch: 2, expiresAt: inDays(MEMBER_TOKEN_TTL_MS / 86_400_000 * 0.2) }, 2, now),
    'refresh',
    'TTL tinggal <25% → klien harus refresh'
  );
});

/** Fake konversation: `groupEpoch` di-increment seperti Prisma. */
function makeDb (initialEpoch = 0): {
  db: GroupTokenDb;
  state: { authSecret: string; epoch: number; expiresAt: Date | null };
  members: Array<{ id: string; conversationId: string; tokenEpoch: number }>;
} {
  const state = { authSecret: '', epoch: initialEpoch, expiresAt: null as Date | null };
  const members = [{ id: 'row-1', conversationId: 'conv-1', tokenEpoch: initialEpoch }];
  const db: GroupTokenDb = {
    conversation: {
      findUnique: async () => ({ id: 'conv-1', authSecret: state.authSecret, groupEpoch: state.epoch }),
      update: async ({ data }) => {
        if (typeof data.authSecret === 'string') state.authSecret = data.authSecret;
        const increment = (data.groupEpoch as { increment?: number } | undefined)?.increment ?? 0;
        state.epoch += increment;
        if (data.groupTokenExpiresAt instanceof Date) state.expiresAt = data.groupTokenExpiresAt;
        return { id: 'conv-1', groupEpoch: state.epoch };
      },
    },
    userHiddenConversation: {
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async ({ where, data }) => {
        const affected = members.filter((row) => row.conversationId === where.conversationId);
        for (const row of affected) row.tokenEpoch = data.tokenEpoch as number;
        return { count: affected.length };
      },
      delete: async () => ({}),
    },
  };
  return { db, state, members };
}

test('rotateGroupToken: epoch naik, hash token baru tersimpan, token lama mati', async () => {
  const { db, state, members } = makeDb(4);
  state.authSecret = hashGroupToken('C'.repeat(43));

  const now = new Date('2026-10-24T00:00:00Z');
  const rotated = await rotateGroupToken(db, 'conv-1', now);
  assert.equal(rotated.epoch, 5, 'epoch increment atomik');
  assert.equal(members[0]!.tokenEpoch, 5, 'baris anggota ikut epoch baru (tidak stale)');
  assert.ok(isOpaqueToken(rotated.token));
  assert.equal(state.authSecret, hashGroupToken(rotated.token), 'yang disimpan hanya hash');
  assert.equal(groupTokenMatches(state.authSecret, rotated.token), true);
  assert.equal(groupTokenMatches(state.authSecret, 'C'.repeat(43)), false, 'token era lama langsung mati');
  assert.equal(rotated.expiresAt.getTime(), groupTokenExpiry(now).getTime(), 'TTL grup 24 jam');
  assert.equal(state.expiresAt?.getTime(), rotated.expiresAt.getTime());
});

test('rotateGroupToken: dua rotasi berurutan menghasilkan epoch berbeda', async () => {
  const { db } = makeDb(0);
  const first = await rotateGroupToken(db, 'conv-1');
  const second = await rotateGroupToken(db, 'conv-1');
  assert.equal(first.epoch, 1);
  assert.equal(second.epoch, 2);
  assert.notEqual(first.token, second.token);
});

test('refreshMemberToken: sliding TTL, tidak mengubah epoch/hash', async () => {
  let updated: Record<string, unknown> | null = null;
  const db = {
    conversation: {
      findUnique: async () => null,
      update: async () => ({ id: 'conv-1' }),
    },
    userHiddenConversation: {
      findUnique: async () => null,
      update: async ({ where, data }) => {
        assert.equal(where.id, 'row-1');
        updated = data as Record<string, unknown>;
        return {};
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => ({}),
    },
  } as GroupTokenDb;

  const now = new Date('2026-10-24T00:00:00Z');
  const { expiresAt } = await refreshMemberToken(db, 'row-1', now);
  assert.equal(expiresAt.getTime(), memberTokenExpiry(now).getTime());
  assert.deepEqual(updated, { expiresAt });
});
