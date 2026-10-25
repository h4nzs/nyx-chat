// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Index room per-user (`utils/roomMembership.ts`).
 *
 * Pengganti dua `SCAN` seluruh keyspace per disconnect. Yang dikunci: join
 * mencatat room + index, dan leave hanya menyentuh room yang tercatat — member
 * tetap nilai ter-seal, index-nya TAG (bukan userId).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  joinRoom,
  leaveAllRooms,
  roomIndexKey,
  roomKey,
  type RoomRedisClient,
} from '../src/utils/roomMembership.js';

interface Call { op: string; key: string; value?: string }

function fakeClient(index: string[] = []): { client: RoomRedisClient; calls: Call[] } {
  const calls: Call[] = [];
  const store = new Map<string, Set<string>>();
  store.set(roomIndexKey('tag-u1'), new Set(index));

  const client: RoomRedisClient = {
    async sAdd(key, member) {
      calls.push({ op: 'sAdd', key, value: member });
      const set = store.get(key) ?? new Set<string>();
      set.add(member);
      store.set(key, set);
      return 1;
    },
    async sRem(key, member) {
      calls.push({ op: 'sRem', key, value: member });
      // Anggap member memang ada: yang diuji adalah room KEY mana yang disentuh.
      store.get(key)?.delete(member);
      return 1;
    },
    async sMembers(key) {
      calls.push({ op: 'sMembers', key });
      return [...(store.get(key) ?? [])];
    },
    async del(key) {
      calls.push({ op: 'del', key });
      store.delete(key);
      return 1;
    },
    async expire(key, seconds) {
      calls.push({ op: 'expire', key, value: String(seconds) });
      return true;
    },
  };

  return { client, calls };
}

test('join mencatat member ter-seal + index per-user berbasis TAG', async () => {
  const { client, calls } = fakeClient();

  await joinRoom(client, {
    kind: 'burner',
    roomId: 'burner_abc',
    sealedMember: 'SEALED',
    memberTag: 'tag-u1',
  });

  assert.deepEqual(calls[0], { op: 'sAdd', key: 'burner:room:burner_abc', value: 'SEALED' });
  assert.deepEqual(calls[1], { op: 'sAdd', key: 'room:member:tag-u1', value: 'burner:burner_abc' });
  assert.equal(calls[2].op, 'expire');
  assert.equal(calls[2].key, 'room:member:tag-u1');
});

test('leave mengeluarkan user dari setiap room yang tercatat, lalu hapus index', async () => {
  const { client, calls } = fakeClient([
    'burner:room-a',
    'migration:room-b',
    'garbage',
    'burner:',
  ]);

  const removed = await leaveAllRooms(client, { sealedMember: 'SEALED', memberTag: 'tag-u1' });

  const sRemKeys = calls.filter((c) => c.op === 'sRem').map((c) => c.key);
  assert.deepEqual(sRemKeys, ['burner:room:room-a', 'migration:room:room-b']);
  assert.equal(removed, 2);
  assert.equal(calls.at(-1)?.key, 'room:member:tag-u1');
  assert.equal(calls.at(-1)?.op, 'del');
});

test('tanpa index: tidak ada operasi tulis dan hasilnya 0', async () => {
  const { client, calls } = fakeClient();

  const removed = await leaveAllRooms(client, { sealedMember: 'SEALED', memberTag: 'tag-u1' });

  assert.equal(removed, 0);
  assert.deepEqual(calls.map((c) => c.op), ['sMembers']);
});

test('key room dan index memakai bentuk yang sama dengan handler', () => {
  assert.equal(roomKey('burner', 'x'), 'burner:room:x');
  assert.equal(roomKey('migration', 'y'), 'migration:room:y');
  assert.equal(roomIndexKey('tag'), 'room:member:tag');
});
