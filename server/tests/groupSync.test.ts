// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Perilaku anonymous sync.
 *
 * Fake DB di sini SENGAJA melempar kalau ada query yang menyentuh `userId`:
 * jalur sync tidak boleh membaca identitas akun, bahkan sebagai filter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashGroupToken, MEMBER_TOKEN_TTL_MS, TOKEN_REFRESH_GRACE_MS } from '../src/utils/groupTokens.js';
import { resolveSyncMemberships, MAX_SYNC_TOKENS, type SyncDb } from '../src/utils/groupSync.js';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const TOKEN_UNKNOWN = 'Z'.repeat(43);

interface Row {
  id: string;
  conversationId: string;
  tokenEpoch: number;
  expiresAt: Date;
  tokenHash: string;
}

function makeDb (opts: {
  rows: Row[];
  epochs?: Record<string, number>;
}): { db: SyncDb; queries: string[] } {
  const queries: string[] = [];
  const epochs = opts.epochs ?? {};

  const db: SyncDb = {
    userHiddenConversation: {
      findMany: async ({ where }) => {
        queries.push('membership.findMany');
        const whereRecord = where as unknown as Record<string, unknown>;
        if ('userId' in whereRecord) throw new Error('sync tidak boleh query userId');
        const hashes = where.tokenHash.in;
        return opts.rows.filter((row) => hashes.includes(row.tokenHash));
      },
    },
    conversation: {
      findMany: async ({ where }) => {
        queries.push('conversation.findMany');
        return where.id.in.map((id) => ({
          id,
          isGroup: true,
          encryptedMetadata: 'opaque',
          lastMessageAt: new Date('2026-10-24T00:00:00Z'),
          createdAt: new Date('2026-10-01T00:00:00Z'),
          updatedAt: new Date('2026-10-24T00:00:00Z'),
          groupEpoch: epochs[id] ?? 0,
          groupTokenExpiresAt: null,
        }));
      },
    },
  };
  return { db, queries };
}

const now = new Date('2026-10-24T12:00:00Z');

test('sync: token → percakapan, status ok, tanpa query userId', async () => {
  const { db, queries } = makeDb({
    rows: [{
      id: 'row-1',
      conversationId: 'conv-1',
      tokenEpoch: 0,
      expiresAt: new Date(now.getTime() + MEMBER_TOKEN_TTL_MS),
      tokenHash: hashGroupToken(TOKEN_A),
    }],
  });

  const result = await resolveSyncMemberships(db, [TOKEN_A], now);
  assert.equal(result.memberships.length, 1);
  assert.equal(result.memberships[0]!.status, 'ok');
  assert.equal(result.memberships[0]!.conversationId, 'conv-1');
  assert.equal(result.memberships[0]!.index, 0);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.unknown, 0);
  assert.deepEqual(queries, ['membership.findMany', 'conversation.findMany']);
});

test('sync: epoch grup naik → token lama stale (kick/rotasi)', async () => {
  const { db } = makeDb({
    rows: [{
      id: 'row-1',
      conversationId: 'conv-1',
      tokenEpoch: 3,
      expiresAt: new Date(now.getTime() + MEMBER_TOKEN_TTL_MS),
      tokenHash: hashGroupToken(TOKEN_A),
    }],
    epochs: { 'conv-1': 4 },
  });

  const result = await resolveSyncMemberships(db, [TOKEN_A], now);
  assert.equal(result.memberships[0]!.status, 'stale');
  assert.equal(result.stale, 1);
  assert.equal(result.conversations.length, 0, 'token stale tidak mendapat metadata grup');
});

test('sync: kedaluwarsa lewat grace = stale, masih dalam grace = refresh', async () => {
  const rows: Row[] = [
    {
      id: 'row-a',
      conversationId: 'conv-a',
      tokenEpoch: 0,
      expiresAt: new Date(now.getTime() - TOKEN_REFRESH_GRACE_MS - 60_000),
      tokenHash: hashGroupToken(TOKEN_A),
    },
    {
      id: 'row-b',
      conversationId: 'conv-b',
      tokenEpoch: 0,
      expiresAt: new Date(now.getTime() - 60_000),
      tokenHash: hashGroupToken(TOKEN_B),
    },
  ];
  const { db } = makeDb({ rows });

  const result = await resolveSyncMemberships(db, [TOKEN_A, TOKEN_B], now);
  assert.equal(result.memberships.find((m) => m.index === 0)!.status, 'stale');
  assert.equal(result.memberships.find((m) => m.index === 1)!.status, 'refresh');
});

test('sync: token tak dikenal dihitung, tidak menghasilkan entri', async () => {
  const { db } = makeDb({
    rows: [{
      id: 'row-1',
      conversationId: 'conv-1',
      tokenEpoch: 0,
      expiresAt: new Date(now.getTime() + MEMBER_TOKEN_TTL_MS),
      tokenHash: hashGroupToken(TOKEN_A),
    }],
  });

  const result = await resolveSyncMemberships(db, [TOKEN_A, TOKEN_UNKNOWN], now);
  assert.equal(result.memberships.length, 1);
  assert.equal(result.unknown, 1);
});

test('sync: token duplikat dihitung sekali, hash unik per query', async () => {
  let seenHashes: string[] = [];
  const db: SyncDb = {
    userHiddenConversation: {
      findMany: async ({ where }) => {
        seenHashes = where.tokenHash.in;
        return [{
          id: 'row-1',
          conversationId: 'conv-1',
          tokenEpoch: 0,
          expiresAt: new Date(now.getTime() + MEMBER_TOKEN_TTL_MS),
          tokenHash: hashGroupToken(TOKEN_A),
        }, {
          id: 'row-2',
          conversationId: 'conv-2',
          tokenEpoch: 0,
          expiresAt: new Date(now.getTime() + MEMBER_TOKEN_TTL_MS),
          tokenHash: hashGroupToken(TOKEN_B),
        }];
      },
    },
    conversation: {
      findMany: async () => [{ id: 'conv-1', groupEpoch: 0 }, { id: 'conv-2', groupEpoch: 0 }],
    },
  };

  const result = await resolveSyncMemberships(db, [TOKEN_A, TOKEN_A, TOKEN_B], now);
  assert.deepEqual(seenHashes, [hashGroupToken(TOKEN_A), hashGroupToken(TOKEN_B)]);
  assert.deepEqual(result.memberships.map((membership) => membership.index), [0, 1, 2], 'setiap indeks asli terpetakan');
  assert.equal(result.memberships[2]!.conversationId, 'conv-2', 'token B tetap di indeks 2 walau A duplikat');
  assert.equal(result.unknown, 0, 'token ganda tetap dihitung satu hash unik');
});

test('sync: batas token per request', async () => {
  const tokens = Array.from({ length: MAX_SYNC_TOKENS + 20 }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(43));
  let queried = 0;
  const db: SyncDb = {
    userHiddenConversation: {
      findMany: async ({ where }) => {
        queried = where.tokenHash.in.length;
        return [];
      },
    },
    conversation: { findMany: async () => [] },
  };

  const result = await resolveSyncMemberships(db, tokens, now);
  assert.ok(queried <= MAX_SYNC_TOKENS, `hash di-cap ${MAX_SYNC_TOKENS}, dapat ${queried}`);
  assert.equal(MAX_SYNC_TOKENS, 200, 'batas = dokumen docs/37 §37.3.3');
  assert.equal(result.truncated, true, 'pemotongan dilaporkan ke klien');
});

test('sync: di bawah batas tidak ditandai terpotong', async () => {
  const db: SyncDb = {
    userHiddenConversation: { findMany: async () => [] },
    conversation: { findMany: async () => [] },
  };
  const result = await resolveSyncMemberships(db, [TOKEN_A], now);
  assert.equal(result.truncated, false);
});
