// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 2 — REG-2/N-02] Bukti peserta per percakapan.
 *
 * Yang dikunci di sini adalah bentuk DATA produksi, bukan fake yang
 * "seharusnya": percakapan 1:1 tidak punya baris `UserHiddenConversation`
 * (klien tidak mengirim `targetDeliveryTokens` untuk 1:1), jadi bukti harus
 * datang dari receipt (`MessageStatus` bertag opaque) atau session key
 * perangkat. Tanpa itu, typing dan pemulihan session key 1:1 mati.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterConversationParticipants,
  isConversationParticipant,
  MAX_PARTICIPANT_FALLBACK_CHECKS,
  type ConversationParticipantDb,
} from '../src/utils/conversationParticipants.js';
import {
  clearAtRestSecretCacheForTests,
  conversationScopedTag,
  sealAtRest,
} from '../src/utils/atRestSecrets.js';

async function withPepper<T>(pepper: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.NYX_AT_REST_PEPPER;
  process.env.NYX_AT_REST_PEPPER = pepper;
  clearAtRestSecretCacheForTests();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NYX_AT_REST_PEPPER;
    else process.env.NYX_AT_REST_PEPPER = prev;
    clearAtRestSecretCacheForTests();
  }
}

interface FakeOptions {
  conversationId?: string;
  members?: string[];
  /** User yang punya receipt di percakapan itu (tag opaque). */
  receipts?: string[];
  /** User yang punya session key perangkat di percakapan itu. */
  sessionKeys?: string[];
}

async function makeDb (opts: FakeOptions = {}) {
  const conversationId = opts.conversationId ?? 'c1';
  const sealed = new Map<string, string>();
  for (const member of opts.members ?? []) sealed.set(await sealAtRest(member), member);
  const receiptTags = new Map<string, string>();
  for (const userId of opts.receipts ?? []) {
    receiptTags.set(conversationScopedTag(conversationId, userId), userId);
  }
  const sessionUsers = new Set(opts.sessionKeys ?? []);
  const calls = { membership: 0, receipt: 0, sessionKey: 0 };

  const db: ConversationParticipantDb = {
    userHiddenConversation: {
      async findMany (args) {
        calls.membership += 1;
        const where = args.where as { conversationId?: string; userId?: { in?: string[] } };
        if (where.conversationId !== conversationId) return [];
        const candidates = where.userId?.in ?? [];
        return candidates.filter((candidate) => sealed.has(candidate)).map((userId) => ({ userId }));
      },
    },
    messageStatus: {
      async findFirst (args) {
        calls.receipt += 1;
        const where = args.where as { userId?: string; message?: { conversationId?: string } };
        // Receipt WAJIB ter-scope ke pesan di percakapan yang dimaksud.
        if (where.message?.conversationId !== conversationId) return null;
        return typeof where.userId === 'string' && receiptTags.has(where.userId) ? { id: 'receipt' } : null;
      },
    },
    sessionKey: {
      async findFirst (args) {
        calls.sessionKey += 1;
        const where = args.where as { conversationId?: string; device?: { userId?: string } };
        if (where.conversationId !== conversationId) return null;
        const userId = where.device?.userId;
        return typeof userId === 'string' && sessionUsers.has(userId) ? { id: 'sk' } : null;
      },
    },
  };

  return { db, calls };
}

test('bukti 1: baris keanggotaan (userId ter-seal) → peserta', async () => {
  await withPepper('p-participants', async () => {
    const { db, calls } = await makeDb({ members: ['u-a'] });
    assert.equal(await isConversationParticipant(db, 'c1', 'u-a'), true);
    assert.equal(calls.receipt, 0, 'query receipt tidak perlu dijalankan bila keanggotaan cukup');
  });
});

test('bukti 2: receipt ber-tag opaque di percakapan itu → peserta (kasus 1:1)', async () => {
  await withPepper('p-participants', async () => {
    const { db, calls } = await makeDb({ receipts: ['u-b'] });
    assert.equal(await isConversationParticipant(db, 'c1', 'u-b'), true);
    assert.equal(calls.membership, 1, 'keanggotaan tetap dicoba lebih dulu (satu query)');
  });
});

test('bukti 3: session key perangkat pada percakapan itu → peserta', async () => {
  await withPepper('p-participants', async () => {
    const { db } = await makeDb({ sessionKeys: ['u-c'] });
    assert.equal(await isConversationParticipant(db, 'c1', 'u-c'), true);
  });
});

test('tanpa bukti → bukan peserta (fail-closed)', async () => {
  await withPepper('p-participants', async () => {
    const { db } = await makeDb({ members: ['u-a'], receipts: ['u-b'], sessionKeys: ['u-c'] });
    assert.equal(await isConversationParticipant(db, 'c1', 'u-stranger'), false);
    assert.equal(await isConversationParticipant(db, 'c1', ''), false);
    assert.equal(await isConversationParticipant(db, 'c1', 'x'.repeat(65)), false);
    assert.equal(await isConversationParticipant(db, 'c1', 42), false);
  });
});

test('bukti ter-scope ke conversationId — anggota grup lain tidak lolos', async () => {
  await withPepper('p-participants', async () => {
    const { db } = await makeDb({ members: ['u-a'], receipts: ['u-a'], sessionKeys: ['u-a'] });
    assert.equal(
      await isConversationParticipant(db, 'c-other', 'u-a'),
      false,
      'keanggotaan/receipt/session key di c1 tidak boleh dipakai untuk percakapan lain (N-02)'
    );
  });
});

test('filterConversationParticipants: gabungan keanggotaan + receipt, dedupe, buang nilai rusak', async () => {
  await withPepper('p-participants', async () => {
    const { db } = await makeDb({ members: ['u-a'], receipts: ['u-b'] });
    const allowed = await filterConversationParticipants(
      db,
      'c1',
      ['u-a', 'u-b', 'u-b', 'u-stranger', null, 123, '', 'y'.repeat(65)]
    );
    assert.deepEqual(allowed, ['u-a', 'u-b']);
  });
});

test('filterConversationParticipants: fallback per-kandidat dibatasi (anti N+1 liar)', async () => {
  await withPepper('p-participants', async () => {
    const ghosts = Array.from({ length: MAX_PARTICIPANT_FALLBACK_CHECKS + 4 }, (_, i) => `ghost-${i}`);
    const { db, calls } = await makeDb({ members: [], receipts: [] });
    const allowed = await filterConversationParticipants(db, 'c1', ghosts);
    assert.deepEqual(allowed, []);
    assert.equal(
      calls.receipt,
      MAX_PARTICIPANT_FALLBACK_CHECKS,
      `paling banyak ${MAX_PARTICIPANT_FALLBACK_CHECKS} kandidat non-anggota diperiksa`
    );
  });
});

test('filterConversationParticipants: target grup yang punya baris tidak kena batas fallback', async () => {
  await withPepper('p-participants', async () => {
    const members = Array.from({ length: MAX_PARTICIPANT_FALLBACK_CHECKS + 4 }, (_, i) => `u-${i}`);
    const { db, calls } = await makeDb({ members });
    const allowed = await filterConversationParticipants(db, 'c1', members);
    assert.deepEqual(allowed, members);
    assert.equal(calls.receipt, 0, 'semua target dikenali dari satu query keanggotaan');
  });
});

test('filterConversationParticipants: input kosong tidak menyentuh DB', async () => {
  await withPepper('p-participants', async () => {
    const { db, calls } = await makeDb();
    assert.deepEqual(await filterConversationParticipants(db, 'c1', []), []);
    assert.equal(calls.membership, 0);
  });
});
