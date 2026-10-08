// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0.7 — D14] Presence per-kontak.
 *
 * Sebelumnya setiap klien yang connect menerima `{ type: 'bulk', userIds }`
 * berisi SELURUH `online_users`, dan join/leave di-broadcast ke seluruh roster
 * → setiap pengguna bisa memanen graph presensi platform. Test ini mengunci
 * (a) logika peer-scoping, (b) hilangnya broadcast roster penuh.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  collectPresencePeers,
  dedupePeers,
  intersectOnline,
  type PresenceMembershipClient,
} from '../src/utils/presencePeers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

test('dedupePeers: peer unik, tanpa diri sendiri, tanpa baris token-only', () => {
  const mine = [{ conversationId: 'c1' }, { conversationId: 'c2' }];
  const peers = [
    { userId: 'u-bob' },
    { userId: 'u-bob' }, // duplikat lintas conversation
    { userId: 'me' }, // diri sendiri
    { userId: null }, // baris token-only (routing-only, tanpa identitas)
    { userId: '' }, // rusak
    { userId: 'u-carol' },
  ];

  assert.deepEqual(dedupePeers(mine, peers, 'me').sort(), ['u-bob', 'u-carol']);
});

test('dedupePeers: tanpa conversation → tidak ada peer (bukan "semua orang")', () => {
  assert.deepEqual(dedupePeers([], [{ userId: 'u-bob' }], 'me'), []);
});

test('intersectOnline: hanya peer yang sedang online', () => {
  assert.deepEqual(intersectOnline(['a', 'b', 'c'], new Set(['a', 'c', 'z'])), ['a', 'c']);
  assert.deepEqual(intersectOnline(['a'], ['b']), []);
  assert.deepEqual(intersectOnline([], new Set(['a'])), []);
});

test('collectPresencePeers: dua query, dedupe userId, filter null', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fake: PresenceMembershipClient = {
    userHiddenConversation: {
      findMany: async (args) => {
        calls.push(args as Record<string, unknown>);
        if (calls.length === 1) {
          return [{ conversationId: 'c1' }, { conversationId: 'c2' }];
        }
        return [{ userId: 'u-bob' }, { userId: 'u-bob' }, { userId: null }, { userId: 'u-carol' }];
      },
    },
  };

  const peers = await collectPresencePeers(fake, 'me');
  assert.deepEqual(peers.sort(), ['u-bob', 'u-carol']);
  assert.equal(calls.length, 2, 'dua query (conversation saya → anggota lain), bukan N+1');
  assert.deepEqual(calls[0].select, { conversationId: true });
  assert.deepEqual(calls[1].distinct, ['userId'], 'dedupe userId di DB');
  assert.deepEqual(calls[1].where, {
    conversationId: { in: ['c1', 'c2'] },
    userId: { not: null, notIn: ['me'] },
  });
});

test('collectPresencePeers: tanpa conversation → berhenti sebelum query kedua', async () => {
  let calls = 0;
  const fake: PresenceMembershipClient = {
    userHiddenConversation: {
      findMany: async () => {
        calls += 1;
        return [];
      },
    },
  };
  assert.deepEqual(await collectPresencePeers(fake, 'me'), []);
  assert.equal(calls, 1, 'tidak ada query anggota kalau user belum punya conversation');
});

test('D14 wiring: roster global tidak lagi dikirim ke klien / di-broadcast', () => {
  const handlers = read('../src/network/realtimeHandlers.ts');
  const bridge = read('../src/network/redisBridge.ts');

  for (const [name, src] of [['realtimeHandlers', handlers], ['redisBridge', bridge]] as const) {
    assert.doesNotMatch(
      src,
      /broadcastToUsers\(onlineUsers,/,
      `${name}: broadcast tidak boleh memakai seluruh roster online_users`
    );
    assert.match(src, /collectPresencePeers\(/, `${name}: presence memakai daftar peer`);
    assert.match(src, /intersectOnline\(peers, onlineUsers\)/, `${name}: join/leave hanya ke peer yang online`);
  }

  assert.match(
    handlers,
    /type: 'bulk', userIds: peersOnline/,
    'snapshot presence berisi peer, bukan seluruh user online'
  );
  assert.doesNotMatch(
    handlers,
    /sendJsonToUser\(userId, TransportOpCode\.PRESENCE, \{ type: 'bulk', userIds: onlineUsers \}\)/,
    'regresi D14: snapshot roster global'
  );
});
