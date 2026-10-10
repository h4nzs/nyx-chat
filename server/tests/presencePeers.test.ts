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
import { clearAtRestSecretCacheForTests, sealAtRest } from '../src/utils/atRestSecrets.js';

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

test('collectPresencePeers: dua query, dedupe, hanya nilai ter-seal yang dikenali', async () => {
  await withPepper('p-presence', async () => {
    const sealedBob = await sealAtRest('u-bob');
    const sealedCarol = await sealAtRest('u-carol');
    const calls: Array<Record<string, unknown>> = [];
    const fake: PresenceMembershipClient = {
      userHiddenConversation: {
        findMany: async (args) => {
          calls.push(args as Record<string, unknown>);
          if (calls.length === 1) {
            return [{ conversationId: 'c1' }, { conversationId: 'c2' }];
          }
          return [
            { userId: sealedBob },
            { userId: sealedBob }, // duplikat lintas conversation
            { userId: null }, // baris token-only (routing-only, tanpa identitas)
            { userId: sealedCarol },
            { userId: 'u-plaintext-lama' }, // baris plaintext lama → tidak dikenali lagi
          ];
        },
      },
    };

    const peers = await collectPresencePeers(fake, 'me');
    assert.deepEqual(peers.sort(), ['u-bob', 'u-carol'], 'identitas ter-seal dibuka; plaintext lama diabaikan');
    assert.equal(calls.length, 2, 'dua query (conversation saya → anggota lain), bukan N+1');
    assert.deepEqual(calls[0].select, { conversationId: true });
    assert.deepEqual(calls[1].distinct, ['userId'], 'dedupe userId di DB');

    // [docs/28 Tier 1.2] kolom userId kini routing identity TER-SEAL → lookup
    // memakai nilai kanonik (tunggal) dan nilai baris dibuka kembali sebelum
    // dipakai sebagai target broadcast.
    const mineWhere = calls[0].where as { userId: { in: string[] } };
    const peerWhere = calls[1].where as { conversationId: unknown; userId: { not: null; notIn: string[] } };
    assert.deepEqual(mineWhere.userId.in, [await sealAtRest('me')], 'kandidat = bentuk sealed tunggal');
    assert.notEqual(mineWhere.userId.in[0], 'me', 'nilai tersimpan bukan userId asli (D2)');
    assert.deepEqual(peerWhere.conversationId, { in: ['c1', 'c2'] });
    assert.deepEqual(peerWhere.userId.notIn, mineWhere.userId.in, 'peer tidak termasuk diri sendiri');
    assert.equal(peerWhere.userId.not, null);
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
    // Presence kini lazy (opt-in): join/leave hanya di-fan-out ke klien yang
    // BENAR-BENAR berlangganan user tersebut — bukan ke seluruh peer online.
    assert.match(src, /notifyPresenceWatchers\(/, `${name}: join/leave hanya ke watcher`);
  }

  // Server menurunkan daftar peer sendiri, memvalidasi langganan terhadapnya,
  // dan membalas status peer yang benar-benar disimpan.
  assert.match(handlers, /collectPresencePeers\(/, 'presence memakai daftar peer');
  assert.match(handlers, /subscribePresence\(/, 'presence memakai registry langganan');
  assert.match(handlers, /peerSet\.has\(id\)/, 'langganan hanya boleh untuk peer yang dikenal');
  assert.match(handlers, /type: 'sync', statuses/, 'balasan presence berisi status peer yang disimpan');
  assert.doesNotMatch(
    handlers,
    /sendJsonToUser\(userId, TransportOpCode\.PRESENCE, \{ type: 'bulk', userIds: onlineUsers \}\)/,
    'regresi D14: snapshot roster global'
  );

  // Redis tidak lagi memuat userId asli di `online_users`.
  assert.match(handlers, /sAdd\('online_users', identityTag\(userId\)\)/, 'keanggotaan online_users memakai tag');
  assert.match(bridge, /sRem\('online_users', identityTag\(userId\)\)/, 'keluar online_users memakai tag');
  assert.doesNotMatch(handlers, /sAdd\('online_users', userId\)/, 'regresi D14: userId asli di SET online_users');
  assert.doesNotMatch(bridge, /sRem\('online_users', userId\)/, 'regresi D14: userId asli di SET online_users');
});
