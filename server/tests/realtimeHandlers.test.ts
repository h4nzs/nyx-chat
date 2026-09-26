import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportOpCode } from '@nyx/shared';
import { handleChatMessage, handlePresence, handleKeySync, type RealtimeContext } from '../src/network/realtimeHandlers.js';

// --- Fake dependency-injection context ---
// Semua helper dicatat ke `calls` agar kita bisa membuktikan bahwa handler
// benar-benar menggunakan dependency yang di-injeksikan (bukan import statis).
function makeCtx() {
  const calls = {
    sendToUser: [] as unknown[][],
    sendToDevice: [] as unknown[][],
    broadcastToUsers: [] as unknown[][],
    sendJsonToUser: [] as unknown[][],
    checkRateLimit: [] as unknown[][],
    isActiveDeviceAllowed: [] as unknown[][],
  };

  const fakePrisma = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === '$transaction') return async (fns: unknown[]) => Promise.all(fns as Promise<unknown>[]);
      return new Proxy({}, {
        get(_m, method: string) {
          if (method === 'findUnique') {
            return async () => ({
              id: 'x',
              isGroup: false,
              senderId: 'u1',
              conversation: { isGroup: false },
              devices: [{ publicKey: Buffer.from('k'), pqPublicKey: Buffer.from('k') }],
            });
          }
          if (method === 'create') {
            return async () => ({
              id: 'm1',
              conversationId: 'c1',
              senderId: 'u1',
              content: 'x',
              createdAt: new Date().toISOString(),
              type: 'USER',
              isViewOnce: false,
              sender: { id: 'u1', encryptedProfile: null },
            });
          }
          if (method === 'update' || method === 'delete' || method === 'upsert' || method === 'deleteMany') {
            return async () => ({});
          }
          return async () => ({});
        },
      });
    },
  }) as unknown as RealtimeContext['prisma'];

  const fakeRedis = new Proxy({}, {
    get(_t, method: string) {
      // SET NX default: selalu sukses (reserved). Test dedupe menggantikan
      // redisClient ini dengan makeStatefulRedis yang benar-benar stateful.
      if (method === 'set') return async () => 'OK';
      if (method === 'get') return async () => null;
      if (method === 'del') return async () => 1;
      return async () => ({});
    },
  }) as unknown as RealtimeContext['redisClient'];

  const fakePub = new Proxy({}, {
    get(_t, method: string) {
      if (method === 'sMembers') return async () => [];
      return async () => ({});
    },
  }) as unknown as RealtimeContext['pubClient'];

  const ctx: RealtimeContext = {
    sendToUser: async (...a) => { calls.sendToUser.push(a); },
    sendToDevice: async (...a) => { calls.sendToDevice.push(a); },
    broadcastToUsers: async (...a) => { calls.broadcastToUsers.push(a); },
    sendJsonToUser: async (...a) => { calls.sendJsonToUser.push(a); },
    checkRateLimit: async (...a) => { calls.checkRateLimit.push(a); return true; },
    isActiveDeviceAllowed: async (...a) => { calls.isActiveDeviceAllowed.push(a); return true; },
    prisma: fakePrisma,
    redisClient: fakeRedis,
    pubClient: fakePub,
  };

  return { ctx, calls };
}

test('handleChatMessage: menyimpan pesan dan mengirim ack ke pengirim saat payload valid', async () => {
  const { ctx, calls } = makeCtx();
  const payload = { conversationId: 'c1', content: 'halo', tempId: 123 };
  await handleChatMessage(ctx, 'u1', 'd1', payload, 'msg-1');

  // Bukti injeksi: prisma.message.create dipanggil lewat ctx (bukan import langsung).
  assert.ok(calls.sendJsonToUser.length >= 1, 'sendJsonToUser harus dipanggil');

  const ackCall = calls.sendJsonToUser.find((c) => c[1] === TransportOpCode.ACK);
  assert.ok(ackCall, 'harus mengirim ACK ke pengirim');
  const ackData = (ackCall![2] as { data: { ok: boolean; msg?: unknown } }).data;
  assert.equal(ackData.ok, true);
  assert.ok(ackData.msg, 'ack harus membawa pesan yang tersimpan');
});

test('handlePresence: menyiarkan envelope PRESENCE bertipe typing dengan bentuk benar ke penerima', async () => {
  const { ctx, calls } = makeCtx();
  await handlePresence(ctx, 'u1', { event: 'typing:start', conversationId: 'c1', targetRecipients: ['p1'] });

  const typingCall = calls.sendJsonToUser.find(
    (c) => c[1] === TransportOpCode.PRESENCE && (c[2] as { type?: string }).type === 'typing'
  );
  assert.ok(typingCall, 'harus mengirim envelope typing ke penerima');

  const data = typingCall![2] as { type: string; userId: string; conversationId: string; isTyping: boolean };
  assert.equal(data.type, 'typing');
  assert.equal(data.userId, 'u1');
  assert.equal(data.conversationId, 'c1');
  assert.equal(data.isTyping, true);
  assert.equal(typingCall![0], 'p1');
});

test('handleChatMessage: menolak payload tidak valid tanpa melempar error (unhandled rejection)', async () => {
  const { ctx, calls } = makeCtx();
  // content kosong -> gagal MessageSendPayloadSchema; tidak boleh melempar.
  await assert.doesNotReject(
    handleChatMessage(ctx, 'u1', 'd1', { conversationId: '', content: '' }, 'msg-2')
  );

  const ackCall = calls.sendJsonToUser.find((c) => c[1] === TransportOpCode.ACK);
  assert.ok(ackCall, 'harus mengirim ACK penolakan');
  assert.equal((ackCall![2] as { data: { ok: boolean } }).data.ok, false);
});

// Fake redis STATEFUL untuk menguji dedupe SET NX: set dengan NX benar-benar
// atomik terhadap isi map, get/del membaca/menghapus entry.
function makeStatefulRedis(store = new Map<string, string>()) {
  return {
    store,
    client: new Proxy({}, {
      get(_t, method: string) {
        if (method === 'set') {
          return async (key: string, val: string, opts?: { NX?: boolean; EX?: number }) => {
            if (opts?.NX && store.has(key)) return null;
            store.set(key, val);
            return 'OK';
          };
        }
        if (method === 'get') return async (key: string) => store.get(key) ?? null;
        if (method === 'del') return async (key: string) => { store.delete(key); return 1; };
        return async () => ({});
      },
    }),
  };
}

// Context dengan fakeRedis stateful (menggantikan proxy generik makeCtx).
function makeCtxWithRedis(redisClient: unknown) {
  const base = makeCtx();
  base.ctx.redisClient = redisClient as RealtimeContext['redisClient'];
  return base;
}

test('handleChatMessage: idempotensi — retry dengan tempId sama TIDAK membuat pesan kedua, ACK ulang pesan asli', async () => {
  const { store, client } = makeStatefulRedis();
  const { ctx, calls } = makeCtxWithRedis(client);

  // Hitung jumlah insert via counter di proxy prisma.
  let createCount = 0;
  const makeMessageModel = () => new Proxy({}, {
    get(_m, method: string) {
      if (method === 'create') {
        return async () => {
          createCount++;
          return { id: 'm' + createCount, conversationId: 'c1', senderId: 'u1', content: 'x', createdAt: new Date().toISOString(), type: 'USER', isViewOnce: false, sender: { id: 'u1', encryptedProfile: null } };
        };
      }
      if (method === 'findUnique') {
        // Duplicate path membaca pesan existing berdasarkan id di slot dedupe.
        return async ({ where }: { where?: { id?: string } }) => {
          const id = where?.id;
          if (id && store.get('nyx:send_dedupe:d1:777') === id) {
            return { id, conversationId: 'c1', senderId: 'u1', content: 'x', createdAt: new Date().toISOString(), type: 'USER', isViewOnce: false, sender: { id: 'u1', encryptedProfile: null } };
          }
          return null;
        };
      }
      return async () => ({});
    },
  });
  const origPrisma = ctx.prisma as unknown as Record<string, unknown>;
  const messageModel = makeMessageModel();
  ctx.prisma = new Proxy(origPrisma, {
    get(target, prop: string) {
      if (prop === 'message') return messageModel;
      return (target as Record<string, unknown>)[prop];
    },
  }) as unknown as RealtimeContext['prisma'];

  const payload = { conversationId: 'c1', content: 'halo', tempId: 777 };

  // Kirim pertama: reserved → insert → slot diisi msgId.
  await handleChatMessage(ctx, 'u1', 'd1', payload, 'ack-1');
  assert.equal(createCount, 1, 'kirim pertama harus insert sekali');
  const slotKey = 'nyx:send_dedupe:d1:777';
  assert.equal(store.get(slotKey), 'm1', 'slot harus berisi id pesan hasil insert');

  // Retry (ACK pertama hilang): slot sudah terisi → duplicate path → ACK ulang
  // pesan asli, TANPA insert baru.
  calls.sendJsonToUser.length = 0;
  await handleChatMessage(ctx, 'u1', 'd1', payload, 'ack-2');
  assert.equal(createCount, 1, 'retry TIDAK boleh insert lagi (idempoten)');

  const ackCall = calls.sendJsonToUser.find((c) => c[1] === TransportOpCode.ACK);
  assert.ok(ackCall, 'retry harus tetap menerima ACK');
  const ackData = (ackCall![2] as { data: { ok: boolean; msg?: { id: string } } }).data;
  assert.equal(ackData.ok, true, 'ACK duplicate harus ok:true');
  assert.equal(ackData.msg?.id, 'm1', 'ACK duplicate harus membawa pesan asli');
});

test('handleChatMessage: insert gagal melepaskan slot dedupe sehingga retry bisa tersimpan', async () => {
  const { store, client } = makeStatefulRedis();
  const { ctx, calls } = makeCtxWithRedis(client);

  // Prisma yang selalu gagal saat create.
  const origPrisma = ctx.prisma as unknown as Record<string, unknown>;
  ctx.prisma = new Proxy(origPrisma, {
    get(target, prop: string) {
      if (prop === 'message') {
        return new Proxy({}, {
          get(_m, method: string) {
            if (method === 'create') return async () => { throw new Error('db down'); };
            return async () => ({});
          },
        });
      }
      return (target as Record<string, unknown>)[prop];
    },
  }) as unknown as RealtimeContext['prisma'];

  const payload = { conversationId: 'c1', content: 'halo', tempId: 888 };
  await handleChatMessage(ctx, 'u1', 'd1', payload, 'ack-1');

  // Slot harus sudah dibebaskan setelah insert gagal.
  assert.equal(store.has('nyx:send_dedupe:d1:888'), false, 'slot harus di-release saat insert gagal');

  const ackCall = calls.sendJsonToUser.find((c) => c[1] === TransportOpCode.ACK);
  assert.ok(ackCall, 'harus mengirim ACK error');
  assert.equal((ackCall![2] as { data: { ok: boolean } }).data.ok, false);
});

// --- T1: Group sender pseudonyms (doc 26.2/26.7) ---

test('T1: chat_message grup dengan senderPseudonym tersimpan dengan pseudonym, bukan userId auth', async () => {
  const { ctx, calls } = makeCtx();
  // Prisma fake: capture create args (ganti default Proxy makeCtx untuk message.create).
  let created: Record<string, unknown> | null = null;
  const baseCreate = (ctx.prisma as unknown as Record<string, never>);
  void baseCreate;
  const origPrisma = ctx.prisma;
  ctx.prisma = new Proxy(origPrisma as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === 'message') {
        return {
          findUnique: async () => null,
          create: async (args: { data: Record<string, unknown> }) => {
            created = args.data;
            return {
              id: 'm-t1',
              conversationId: 'c1',
              content: 'x',
              createdAt: new Date().toISOString(),
              type: 'USER',
              isViewOnce: false,
              sender: { id: 'pseudonym', encryptedProfile: null },
              ...args.data,
            };
          },
          update: async () => ({}),
          delete: async () => ({}),
        };
      }
      if (prop === 'conversation') {
        return {
          findUnique: async () => ({ id: 'c1', isGroup: true }),
          update: async () => ({}),
        };
      }
      if (prop === '$transaction') return async (fns: unknown[]) => Promise.all(fns as Promise<unknown>[]);
      return (target as Record<string, unknown>)[prop];
    },
  }) as unknown as RealtimeContext['prisma'];

  await handleChatMessage(ctx, 'u-real', 'd1', {
    conversationId: 'c1',
    content: 'sealed-payload',
    tempId: 1,
    senderPseudonym: 'AAAAAAAAAAAAAAAAAAAAAA',
  } as never, 'ack-t1');

  assert.ok(created, 'pesan harus dibuat');
  assert.equal(created!['senderId'], 'AAAAAAAAAAAAAAAAAAAAAA', 'senderId DB = pseudonym (bukan userId)');
});

test('T2 FINAL: distribute_keys ditolak eksplisit (legacy path dihapus, pairwise-only)', async () => {
  const { ctx, calls } = makeCtx();
  await handleKeySync(ctx, 'u-real', 'd1', {
    event: 'messages:distribute_keys',
    msgId: 'ack-removed',
    data: {
      conversationId: 'c1',
      senderPseudonym: 'BBBBBBBBBBBBBBBBBBBBBB',
      keys: [{ userId: 'u2', key: 'sealed-key-material', senderDeviceKey: 'dev-u-real' }],
    },
  });

  const ack = calls.sendJsonToUser.find((c) => (c[2] as { data?: { error?: string } } | undefined)?.data?.error?.includes('distribute_keys removed'));
  assert.ok(ack, 'ACK error eksplisit harus dikirim (bukan hening)');
  assert.equal((ack![2] as { data: { ok: boolean } }).data.ok, false, 'ACK = gagal (event tidak lagi didukung)');
  const relay = calls.sendJsonToUser.find((c) => c[0] === 'u2');
  assert.ok(!relay, 'TIDAK boleh ada relay ke target');
});

test('T1: unsend grup tanpa deleteSecret ditolak (deleteSecret-only untuk grup)', async () => {
  const { ctx } = makeCtx();
  (ctx.prisma as unknown as { message: { findUnique: () => unknown; delete: () => Promise<void> } }).message = {
    findUnique: () => ({ conversationId: 'c1', senderId: 'PSEUDO-not-user', deleteSecret: 'secret123' }),
    delete: async () => {},
  };
  // Tidak ada deleteSecret → meski senderId cocok userId auth pun tidak (pseudonym ≠ userId).
  await assert.doesNotReject(handleKeySync(ctx, 'u-real', 'd1', {
    event: 'message:unsend',
    msgId: '',
    data: { messageId: 'm1', conversationId: 'c1' },
  }));
  // deleteSecret valid → lolos (tidak ada error).
  await assert.doesNotReject(handleKeySync(ctx, 'u-real', 'd1', {
    event: 'message:unsend',
    msgId: '',
    data: { messageId: 'm1', conversationId: 'c1', deleteSecret: 'secret123' },
  }));
});

test('handleKeySync: meneruskan session:request_key ke target lewat emitEventToUser (bukti injeksi)', async () => {
  const { ctx, calls } = makeCtx();
  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'session:request_key',
    msgId: '',
    data: { conversationId: 'c1', sessionId: 's1', targetId: 't1' },
  });

  const call = calls.sendJsonToUser.find(
    (c) => c[1] === TransportOpCode.KEY_SYNC && (c[2] as { event?: string }).event === 'session:request_key'
  );
  assert.ok(call, 'harus meneruskan session:request_key ke target');
  assert.equal(call![0], 't1');
});

// --- Batch receipt (N+1 fix) ---

// Prisma fake untuk batch: pesan + status existing terkontrol per test.
function makeCtxForBatch(opts: {
  messages: Array<{ id: string; senderId: string | null; conversation: { isGroup: boolean } }>;
  existingStatuses?: Array<{ messageId: string; status: string }>;
}) {
  const base = makeCtx();
  const upserts: Array<{ messageId: string; userId: string; status: string }> = [];
  const ttlUpdates: Array<{ ids: string[]; expiresAt: Date }> = [];

  const prisma = {
    message: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        opts.messages.filter((m) => where.id.in.includes(m.id)),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { expiresAt: Date } }) => {
        ttlUpdates.push({ ids: where.id.in, expiresAt: data.expiresAt });
        return { count: where.id.in.length };
      },
    },
    messageStatus: {
      findMany: async () => opts.existingStatuses ?? [],
      upsert: async ({ where, create, update }: {
        where: { messageId_userId: { messageId: string; userId: string } };
        create: { messageId: string; userId: string; status: string };
        update: { status: string };
      }) => {
        upserts.push({ messageId: where.messageId_userId.messageId, userId: where.messageId_userId.userId, status: update.status ?? create.status });
        return {};
      },
    },
  };
  base.ctx.prisma = prisma as unknown as RealtimeContext['prisma'];
  return { ...base, upserts, ttlUpdates };
}

test('batch receipt: N pesan diproses dengan upsert + broadcast paralel (bukan N loop query)', async () => {
  const messages = [
    { id: 'm1', senderId: 'u2', conversation: { isGroup: false } },
    { id: 'm2', senderId: 'u2', conversation: { isGroup: false } },
    { id: 'm3', senderId: 'u3', conversation: { isGroup: true } },
  ];
  const { ctx, calls, upserts } = makeCtxForBatch({ messages });

  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageIds: ['m1', 'm2', 'm3', 'm1'] }, // m1 duplikat
  });

  // Semua pesan milik orang lain di-upsert (duplikat di-dedupe).
  assert.equal(upserts.length, 3, '3 pesan unik harus di-upsert');
  assert.deepEqual(upserts.map((u) => u.messageId).sort(), ['m1', 'm2', 'm3']);

  // Broadcast status ke pengirim: u2 (m1, m2) dan u3 (m3) → 3 event.
  const statusEvents = calls.sendJsonToUser.filter(
    (c) => c[1] === TransportOpCode.KEY_SYNC && (c[2] as { event?: string }).event === 'message:status_updated'
  );
  assert.equal(statusEvents.length, 3, '3 broadcast status (2 ke u2, 1 ke u3)');
});

test('batch receipt READ 1:1: satu updateMany TTL untuk kandidat yang belum READ, grup dikecualikan', async () => {
  const messages = [
    { id: 'm1', senderId: 'u2', conversation: { isGroup: false } },
    { id: 'm2', senderId: 'u2', conversation: { isGroup: false } },
    { id: 'm3', senderId: 'u2', conversation: { isGroup: true } },  // grup → tanpa TTL
    { id: 'm4', senderId: 'u1', conversation: { isGroup: false } },  // pesan sendiri → skip
  ];
  const { ctx, ttlUpdates } = makeCtxForBatch({
    messages,
    existingStatuses: [{ messageId: 'm2', status: 'READ' }], // m2 sudah READ → tanpa TTL
  });

  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageIds: ['m1', 'm2', 'm3', 'm4'] },
  });

  // Satu updateMany, hanya m1 (1:1, belum READ, bukan pesan sendiri).
  assert.equal(ttlUpdates.length, 1, 'TTL harus di-arm sekali untuk seluruh batch');
  assert.deepEqual(ttlUpdates[0].ids, ['m1']);
  // One-shot: TTL baru = now + 24 jam (kira-kira).
  const delta = ttlUpdates[0].expiresAt.getTime() - Date.now();
  assert.ok(delta > 23 * 60 * 60 * 1000 && delta <= 24 * 60 * 60 * 1000, 'grace ~24 jam');
});

test('batch receipt DELIVERED: tidak meng-arm TTL grace', async () => {
  const messages = [{ id: 'm1', senderId: 'u2', conversation: { isGroup: false } }];
  const { ctx, ttlUpdates, upserts } = makeCtxForBatch({ messages });

  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_delivered',
    msgId: '',
    data: { conversationId: 'c1', messageIds: ['m1'] },
  });

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].status, 'DELIVERED');
  assert.equal(ttlUpdates.length, 0, 'DELIVERED tidak boleh meng-arm TTL');
});

test('batch receipt Opaque Mailbox: senderId null 1:1 pakai targets dari klien untuk broadcast', async () => {
  const messages = [
    { id: 'm1', senderId: null, conversation: { isGroup: false } }, // sealed-sender
    { id: 'm2', senderId: 'u2', conversation: { isGroup: false } }, // senderId di DB
    { id: 'm3', senderId: null, conversation: { isGroup: false } }, // tanpa target → skip
  ];
  const { ctx, calls } = makeCtxForBatch({ messages });

  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: {
      conversationId: 'c1',
      messageIds: ['m1', 'm2', 'm3'],
      targets: { m1: 'u9', m2: 'u2' }, // m2: target diabaikan, pakai senderId DB
    },
  });

  const statusEvents = calls.sendJsonToUser.filter(
    (c) => c[1] === TransportOpCode.KEY_SYNC && (c[2] as { event?: string }).event === 'message:status_updated'
  );
  assert.equal(statusEvents.length, 2, 'm1 → u9 (targets), m2 → u2 (DB); m3 tanpa target → skip');
  const byTarget = new Map(statusEvents.map((c) => [c[0], c[2]]));
  assert.ok(byTarget.has('u9'), 'targets harus dipakai untuk pesan sealed-sender (senderId null)');
  assert.ok(byTarget.has('u2'), 'senderId DB tetap prioritas di atas targets');
});

test('batch receipt: pesan kosong / array tidak valid diabaikan tanpa error', async () => {
  const { ctx } = makeCtxForBatch({ messages: [] });
  await assert.doesNotReject(handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageIds: [] },
  }));
  await assert.doesNotReject(handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1' },
  }));
});

// --- T3a: Blind receipts (doc 26.4) — MessageStatus grup v2 menyimpan pseudonym ---

test('T3a: receipt READ grup v2 tersimpan dengan readerPseudonym, broadcast membawa pseudonym', async () => {
  const pseudo = 'PSEUDORECEIVER0000000';
  const messages = [
    { id: 'm1', senderId: 'u2', conversation: { isGroup: true } },
    { id: 'm2', senderId: 'u2', conversation: { isGroup: true } },
  ];
  const { ctx, calls, upserts } = makeCtxForBatch({ messages });

  await handleKeySync(ctx, 'u-real', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageIds: ['m1', 'm2'], readerPseudonym: pseudo },
  });

  assert.equal(upserts.length, 2, 'kedua pesan di-upsert');
  assert.equal(upserts[0].status, 'READ');
  // Composite key upsert harus memakai pseudonym — bukan userId auth.
  assert.ok(upserts.every((u) => u.userId === pseudo), 'MessageStatus.userId = readerPseudonym (bukan u-real)');
  const statusEvents = calls.sendJsonToUser.filter(
    (c) => c[1] === TransportOpCode.KEY_SYNC && (c[2] as { event?: string }).event === 'message:status_updated'
  );
  assert.equal(statusEvents.length, 2, 'broadcast ke sender u2 untuk m1 & m2');
  for (const ev of statusEvents) {
    assert.equal(ev[0], 'u2', 'notifikasi ke pengirim');
    const data = (ev[2] as { data: { userId: string; status: string } }).data;
    assert.equal(data.userId, pseudo, 'broadcast membawa pseudonym pembaca, bukan userId auth');
    assert.equal(data.status, 'READ');
  }
});

test('T3a: receipt 1:1 TIDAK terpengaruh — tanpa readerPseudonym tetap pakai userId auth', async () => {
  const messages = [
    { id: 'm1', senderId: 'u2', conversation: { isGroup: false } },
  ];
  const { ctx, calls, upserts, ttlUpdates } = makeCtxForBatch({ messages });

  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageIds: ['m1'] },
  });

  assert.equal(upserts.length, 1);
  const statusEvents = calls.sendJsonToUser.filter(
    (c) => c[1] === TransportOpCode.KEY_SYNC && (c[2] as { event?: string }).event === 'message:status_updated'
  );
  assert.equal(statusEvents.length, 1);
  const data = (statusEvents[0]![2] as { data: { userId: string } }).data;
  assert.equal(data.userId, 'u1', '1:1: identity tetap userId auth');
  assert.equal(ttlUpdates.length, 1, 'grace TTL 1:1 tetap berjalan');
});

test('T3a: readerPseudonym DIABAIKAN untuk 1:1 meski klien mengirimnya', async () => {
  const messages = [
    { id: 'm1', senderId: 'u2', conversation: { isGroup: false } },
  ];
  const { ctx, calls, upserts } = makeCtxForBatch({ messages });

  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'messages:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageIds: ['m1'], readerPseudonym: 'FAKELEAKATTEMPT000001' },
  });

  assert.equal(upserts.length, 1);
  const statusEvents = calls.sendJsonToUser.filter(
    (c) => c[1] === TransportOpCode.KEY_SYNC && (c[2] as { event?: string }).event === 'message:status_updated'
  );
  const data = (statusEvents[0]![2] as { data: { userId: string } }).data;
  assert.equal(data.userId, 'u1', 'pseudonym tidak boleh bocor ke jalur 1:1');
});

test('T3a singular: pengirim tidak me-receipt pesannya sendiri (senderId === pseudonym)', async () => {
  const pseudo = 'PSEUDOOWNERMSG000000000';
  // Fake prisma minimal untuk jalur singular: pesan grup milik pseudonym kita.
  const base = makeCtx();
  const upsertCalls: Array<{ userId: string; status: string }> = [];
  base.ctx.prisma = {
    message: {
      findUnique: async () => ({ id: 'm1', senderId: pseudo, conversation: { isGroup: true } }),
      updateMany: async () => ({ count: 0 }),
    },
    messageStatus: {
      findUnique: async () => null,
      upsert: async ({ where }: { where: { messageId_userId: { userId: string } } }) => {
        upsertCalls.push({ userId: where.messageId_userId.userId, status: 'READ' });
        return {};
      },
    },
  } as unknown as RealtimeContext['prisma'];

  await handleKeySync(base.ctx, 'u-real', 'd1', {
    event: 'message:mark_as_read',
    msgId: '',
    data: { conversationId: 'c1', messageId: 'm1', readerPseudonym: pseudo },
  });

  assert.equal(upsertCalls.length, 0, 'self-read (pengirim = pseudonym yang sama) harus di-skip');
});
