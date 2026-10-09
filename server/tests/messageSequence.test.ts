// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B1] Urutan pesan berbasis sequence per-conversation.
 *
 * Aturan yang diuji:
 *   1. `reserveMessageSeq` menaikkan counter (atomik oleh DB; di sini diuji
 *      semantik increment-nya lewat fake).
 *   2. `parseMessageCursor` menerima seq (klien baru) DAN ISO date (legacy).
 *   3. `toRawServerMessage` hanya mengirim seq > 0 (0 = legacy).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reserveMessageSeq, parseMessageCursor, type SeqPrismaClient } from '../src/utils/messageSequence.js';
import { toRawServerMessage, type PrismaMessageInput } from '../src/utils/mappers.js';

function fakeSeqClient(start = 0): SeqPrismaClient & { current: number } {
  const state = { current: start };
  return {
    get current() { return state.current; },
    conversation: {
      update: async ({ data }) => {
        state.current += data.messageSeq.increment;
        return { messageSeq: state.current };
      },
    },
  };
}

test('B1: reserveMessageSeq menaikkan counter dan mengembalikan nilai baru', async () => {
  const client = fakeSeqClient(0);
  assert.equal(await reserveMessageSeq(client, 'c1'), 1);
  assert.equal(await reserveMessageSeq(client, 'c1'), 2);
  assert.equal(await reserveMessageSeq(client, 'c1'), 3);
});

test('B1: dua pemanggil bersamaan mendapat seq berbeda (tidak ada tabrakan)', async () => {
  const client = fakeSeqClient(0);
  const results = await Promise.all([
    reserveMessageSeq(client, 'c1'),
    reserveMessageSeq(client, 'c1'),
    reserveMessageSeq(client, 'c1'),
  ]);
  assert.equal(new Set(results).size, 3, 'setiap pesan dapat seq unik');
  assert.deepEqual([...results].sort((a, b) => a - b), [1, 2, 3]);
});

test('B1: parseMessageCursor — seq numerik', () => {
  assert.deepEqual(parseMessageCursor('42'), { kind: 'seq', seq: 42 });
  assert.deepEqual(parseMessageCursor('0'), { kind: 'seq', seq: 0 });
  assert.deepEqual(parseMessageCursor('  7 '), { kind: 'seq', seq: 7 });
});

test('B1: parseMessageCursor — ISO date legacy', () => {
  const iso = '2026-10-08T00:00:00.000Z';
  const parsed = parseMessageCursor(iso);
  assert.equal(parsed.kind, 'date');
  if (parsed.kind === 'date') assert.equal(parsed.date.toISOString(), iso);
});

test('B1: parseMessageCursor — kosong / invalid', () => {
  assert.deepEqual(parseMessageCursor(''), { kind: 'none' });
  assert.deepEqual(parseMessageCursor(undefined), { kind: 'none' });
  assert.deepEqual(parseMessageCursor('bukan-kursor'), { kind: 'none' });
  // Angka tidak aman secara integer → bukan seq, bukan date → none.
  assert.deepEqual(parseMessageCursor('99999999999999999999'), { kind: 'none' });
});

test('B1: mapper hanya mengirim seq > 0 (0/undefined = legacy)', () => {
  const base: PrismaMessageInput = {
    id: 'm1',
    conversationId: 'c1',
    senderId: null,
    content: 'x',
    createdAt: '2026-10-08T00:00:00.000Z',
  };
  assert.equal(toRawServerMessage({ ...base, seq: 12 }).seq, 12);
  assert.equal(toRawServerMessage({ ...base, seq: 0 }).seq, undefined, 'seq 0 dianggap legacy');
  assert.equal(toRawServerMessage({ ...base, seq: null }).seq, undefined);
  assert.equal(toRawServerMessage(base).seq, undefined);
});
