// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi Burner Chat (2026-10-18).
 *
 * Gejala yang dilaporkan:
 *  1. Guest tidak bisa mengirim pesan — Enter/klik kirim "tidak terjadi apa pun".
 *  2. Host menekan destroy, guest tidak melihat apa pun; refresh halaman guest
 *     masih menampilkan room yang seharusnya sudah mati (flaky).
 *
 * Kontrak server yang dikunci di sini:
 *  • `burner:join` WAJIB membalas ACK berisi status room — guest yang masuk
 *    setelah destroy harus tahu tanpa menunggu event realtime.
 *  • `burner:send`/`burner:reply` di room terminated WAJIB membalas ACK error
 *    (`ROOM_TERMINATED`), bukan diam. Tanpa balasan, klien hanya bisa menunggu
 *    timeout dan UI tampak rusak.
 *  • Pengirim di-`sAdd` ulang ke room (self-heal membership) — `handleDisconnect`
 *    menyapu semua `burner:room:*`, jadi tanpa ini destroy setelah satu
 *    reconnect tidak pernah sampai ke guest.
 *  • `burner:destroy` menyimpan status SEBELUM menyiarkan, menyiarkan
 *    `burner:terminated` ke semua anggota, menghapus set room, dan meng-ACK host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TransportOpCode } from '@nyx/shared';
import { handleKeySync, type RealtimeContext } from '../src/network/realtimeHandlers.js';
import { sealIdentity } from '../src/utils/redisIdentity.js';
import { burnerTerminatedKey, isValidBurnerRoomId } from '../src/routes/burner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (p: string) => readFileSync(path.join(here, p), 'utf8');

const ROOM = 'burner_a1b2c3';

interface FakeState {
  keys: Map<string, string>;
  sets: Map<string, Set<string>>;
  acks: { target: string; data: { msgId?: string; data?: Record<string, unknown> } }[];
  relays: { target: string; event: string; data: Record<string, unknown> }[];
}

function makeCtx(state: FakeState = { keys: new Map(), sets: new Map(), acks: [], relays: [] }) {
  const ctx: RealtimeContext = {
    sendToUser: async () => {},
    sendToDevice: async () => {},
    broadcastToUsers: async () => {},
    sendJsonToUser: async (target: string, opCode: TransportOpCode, payload: unknown) => {
      if (opCode === TransportOpCode.ACK) {
        state.acks.push({ target, data: payload as { msgId?: string; data?: Record<string, unknown> } });
        return;
      }
      const json = payload as { event?: string; data?: Record<string, unknown> };
      state.relays.push({ target, event: String(json.event), data: json.data ?? {} });
    },
    checkRateLimit: async () => true,
    isActiveDeviceAllowed: async () => true,
    prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => ({}) }) }) as unknown as RealtimeContext['prisma'],
    redisClient: new Proxy({}, {
      get: (_t, method: string) => {
        if (method === 'exists') return async (key: string) => (state.keys.has(key) ? 1 : 0);
        if (method === 'set') return async (key: string, value: string) => { state.keys.set(key, value); return 'OK'; };
        if (method === 'get') return async (key: string) => state.keys.get(key) ?? null;
        if (method === 'del') return async (key: string) => (state.keys.delete(key) ? 1 : 0);
        return async () => undefined;
      },
    }) as unknown as RealtimeContext['redisClient'],
    pubClient: new Proxy({}, {
      get: (_t, method: string) => {
        if (method === 'sAdd') return async (key: string, member: string) => {
          const set = state.sets.get(key) ?? new Set<string>();
          const sizeBefore = set.size;
          set.add(member);
          state.sets.set(key, set);
          return set.size - sizeBefore;
        };
        if (method === 'sMembers') return async (key: string) => Array.from(state.sets.get(key) ?? []);
        if (method === 'sRem') return async (key: string, member: string) => {
          const set = state.sets.get(key);
          if (!set) return 0;
          return set.delete(member) ? 1 : 0;
        };
        if (method === 'del') return async (key: string) => (state.sets.delete(key) ? 1 : 0);
        return async () => undefined;
      },
    }) as unknown as RealtimeContext['pubClient'],
  };
  return { ctx, state };
}

function ackData(state: FakeState, msgId: string): Record<string, unknown> {
  const ack = state.acks.find((a) => a.data.msgId === msgId);
  assert.ok(ack, `ACK untuk ${msgId} harus terkirim`);
  return ack!.data.data ?? {};
}

test('isValidBurnerRoomId: hanya bentuk room yang dibuat klien yang diterima', () => {
  assert.equal(isValidBurnerRoomId('burner_0123456789abcdef'), true);
  assert.equal(isValidBurnerRoomId(ROOM), true);
  // Fail-closed: bukan tempat memanggil key Redis sembarang.
  assert.equal(isValidBurnerRoomId('burner_'), false);
  assert.equal(isValidBurnerRoomId('burner_room'), true);
  assert.equal(isValidBurnerRoomId('burner_abc:def'), false);
  assert.equal(isValidBurnerRoomId('online_users'), false);
  assert.equal(isValidBurnerRoomId('burner_' + 'a'.repeat(65)), false);
  assert.equal(isValidBurnerRoomId(undefined), false);
  assert.equal(isValidBurnerRoomId(42), false);
});

test('route status di-mount di app (/api/burner) dan memakai key terminated yang sama dengan handler', () => {
  const app = readSrc('../src/app.ts');
  assert.match(app, /app\.use\("\/api\/burner", burnerRouter\)/);
  assert.equal(burnerTerminatedKey(ROOM), `burner:terminated:${ROOM}`);
});

test('burner:join di room TERMINATED → ACK terminated tanpa mendaftarkan anggota', async () => {
  const { ctx, state } = makeCtx();
  await ctx.redisClient.set(burnerTerminatedKey(ROOM), '1');

  await handleKeySync(ctx, 'guest_1', 'dev_1', { event: 'burner:join', msgId: 'j1', data: { roomId: ROOM } });

  const data = ackData(state, 'j1');
  assert.equal(data.ok, true);
  assert.equal(data.terminated, true);
  assert.equal(state.sets.get(`burner:room:${ROOM}`)?.size ?? 0, 0, 'room mati tidak boleh diisi lagi');
});

test('burner:join di room HIDUP → ACK terminated:false dan anggota terdaftar (ter-seal)', async () => {
  const { ctx, state } = makeCtx();
  await handleKeySync(ctx, 'guest_2', 'dev_2', { event: 'burner:join', msgId: 'j2', data: { roomId: ROOM } });

  const data = ackData(state, 'j2');
  assert.equal(data.terminated, false);

  const members = state.sets.get(`burner:room:${ROOM}`);
  assert.equal(members?.size, 1);
  assert.equal(members!.has('guest_2'), false, 'member harus ter-seal, bukan userId mentah');
  assert.equal(members!.has(await sealIdentity('guest_2')), true);
});

test('burner:send di room TERMINATED → ACK {ok:false, ROOM_TERMINATED}, tidak meneruskan pesan ke host', async () => {
  const { ctx, state } = makeCtx();
  await ctx.redisClient.set(burnerTerminatedKey(ROOM), '1');

  await handleKeySync(ctx, 'guest_1', 'dev_1', {
    event: 'burner:send',
    msgId: 's1',
    data: { roomId: ROOM, hostUserId: 'host_1', targetDeviceId: 'hdev', ciphertext: 'ct' },
  });

  const data = ackData(state, 's1');
  assert.equal(data.ok, false);
  assert.equal(data.error, 'ROOM_TERMINATED');
  assert.equal(state.relays.length, 0);
});

test('burner:send di room hidup → pesan diteruskan ke host, pengirim di-self-heal ke room, ACK ok', async () => {
  const { ctx, state } = makeCtx();
  await handleKeySync(ctx, 'guest_1', 'dev_1', {
    event: 'burner:send',
    msgId: 's2',
    data: { roomId: ROOM, hostUserId: 'host_1', targetDeviceId: 'hdev', ciphertext: 'ct' },
  });

  assert.equal(state.relays.length, 1);
  assert.equal(state.relays[0]!.target, 'host_1');
  assert.equal(state.relays[0]!.event, 'burner:receive');
  assert.equal(state.relays[0]!.data.ciphertext, 'ct');
  assert.equal(state.sets.get(`burner:room:${ROOM}`)?.has(await sealIdentity('guest_1')), true);
  assert.equal(ackData(state, 's2').ok, true);
});

test('burner:reply di room TERMINATED → ACK error (host tidak lagi menganggap terkirim)', async () => {
  const { ctx, state } = makeCtx();
  await ctx.redisClient.set(burnerTerminatedKey(ROOM), '1');

  await handleKeySync(ctx, 'host_1', 'hdev', {
    event: 'burner:reply',
    msgId: 'r1',
    data: { roomId: ROOM, ciphertext: 'ct' },
  });

  assert.equal(ackData(state, 'r1').error, 'ROOM_TERMINATED');
  assert.equal(state.relays.length, 0);
});

test('burner:destroy → status disimpan, semua anggota diberi burner:terminated, set dibersihkan, host dapat ACK notified', async () => {
  const { ctx, state } = makeCtx();
  const guestA = await sealIdentity('guest_a');
  const guestB = await sealIdentity('guest_b');
  state.sets.set(`burner:room:${ROOM}`, new Set([guestA, guestB]));

  await handleKeySync(ctx, 'host_1', 'hdev', { event: 'burner:destroy', msgId: 'd1', data: { roomId: ROOM } });

  assert.equal(state.keys.get(burnerTerminatedKey(ROOM)), '1');
  const terminatedTargets = state.relays.filter((r) => r.event === 'burner:terminated').map((r) => r.target).sort();
  assert.deepEqual(terminatedTargets, ['guest_a', 'guest_b']);
  assert.equal(state.sets.has(`burner:room:${ROOM}`), false, 'set room dibersihkan');

  const ack = ackData(state, 'd1');
  assert.equal(ack.ok, true);
  assert.equal(ack.notified, 2);
});

test('burner:destroy untuk room tanpa anggota tetap ACK (status tetap tersimpan untuk gerbang REST)', async () => {
  const { ctx, state } = makeCtx();
  await handleKeySync(ctx, 'host_1', 'hdev', { event: 'burner:destroy', msgId: 'd2', data: { roomId: ROOM } });

  assert.equal(state.keys.get(burnerTerminatedKey(ROOM)), '1');
  assert.equal(ackData(state, 'd2').notified, 0);
});
