// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-31] Otorisasi event realtime yang mengubah/menghapus data.
 *
 * Tiga skenario dari laporan audit, diuji di level handler:
 *  - F-01 `message:view_once_opened` oleh pihak ketiga tidak boleh menghapus
 *    pesan orang lain atau memalsukan receipt.
 *  - F-02 `group:fulfilled_key` dari non-anggota tanpa admin capability token
 *    tidak boleh menulis baris SYSTEM.
 *  - F-05 `typing` dengan target di luar peer / melebihi cap tidak dikirim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TransportOpCode } from '@nyx/shared';

import {
  handleKeySync,
  handlePresence,
  MAX_TYPING_TARGETS,
  type RealtimeContext,
} from '../src/network/realtimeHandlers.js';

interface SentCall {
  target: string;
  opCode: number;
  data: unknown;
}

function makeCtx (prisma: Record<string, unknown>) {
  const sent: SentCall[] = [];
  const ctx = {
    sendToUser: async () => {},
    sendToDevice: async () => {},
    broadcastToUsers: async () => {},
    sendJsonToUser: async (target: string, opCode: number, data: unknown) => {
      sent.push({ target, opCode, data });
    },
    checkRateLimit: async () => true,
    isActiveDeviceAllowed: async () => true,
    prisma: prisma as unknown as RealtimeContext['prisma'],
    redisClient: {} as RealtimeContext['redisClient'],
    pubClient: {} as RealtimeContext['pubClient'],
  } as unknown as RealtimeContext;
  return { ctx, sent };
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

// ============================================================================
// F-01 — message:view_once_opened
// ============================================================================

/**
 * [PASS-2 REG-1] Fake memakai bentuk DATA produksi, bukan payload ideal:
 *  - percakapan 1:1 menyimpan `senderId: null` (sealed sender),
 *  - klien (`Lightbox.tsx`) mengirim `targetRecipient = message.senderId`,
 *  - bukti peserta dipegang server: receipt di percakapan itu / session key.
 */
function makeViewOnceCtx (opts: {
  senderId?: string | null;
  storedDeleteSecret?: string | null;
  receipt?: boolean;
  sessionKey?: boolean;
  isViewOnce?: boolean;
  isGroup?: boolean;
  /** Jumlah penerima yang tercatat saat kirim (0 = baris lama tanpa daftar). */
  recipientCount?: number;
}) {
  let deletes = 0;
  const opens: Array<{ messageId: string; openerTag: string }> = [];
  const prisma = {
    message: {
      findUnique: async () => ({
        conversationId: 'c1',
        senderId: opts.senderId ?? null,
        deleteSecret: opts.storedDeleteSecret ?? null,
        isViewOnce: opts.isViewOnce ?? true,
        conversation: { isGroup: opts.isGroup ?? false },
      }),
      delete: async () => { deletes += 1; return {}; },
    },
    messageStatus: {
      findFirst: async () => (opts.receipt ? { id: 'receipt-1' } : null),
    },
    sessionKey: {
      findFirst: async () => (opts.sessionKey ? { id: 'sk-1' } : null),
    },
    userHiddenConversation: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    conversation: { findUnique: async () => ({ id: 'c1', isGroup: opts.isGroup ?? false }) },
    // [PASS-2 residual] pencatatan pembukaan per penerima.
    messageViewOnceOpen: {
      upsert: async ({ where }: { where: { messageId_openerTag: { messageId: string; openerTag: string } } }) => {
        const key = where.messageId_openerTag;
        // Upsert idempoten: penerima yang sama membuka dua kali tetap satu baris.
        if (!opens.some((o) => o.messageId === key.messageId && o.openerTag === key.openerTag)) {
          opens.push(key);
        }
        return {};
      },
      count: async ({ where }: { where: { messageId?: string } }) =>
        opens.filter((o) => o.messageId === where.messageId).length,
    },
    // [PASS-2 residual lanjutan] daftar penerima yang dicatat saat kirim.
    messageViewOnceRecipient: {
      count: async ({ where }: { where: { messageId?: string } }) =>
        where.messageId === 'm1' ? (opts.recipientCount ?? 0) : 0,
    },
  };
  const built = makeCtx(prisma);
  return { ...built, deletes: () => deletes, opens: () => opens };
}

test('F-01: pihak ketiga tidak bisa menghapus pesan view-once orang lain', async () => {
  const { ctx, sent, deletes } = makeViewOnceCtx({ senderId: null });
  await handleKeySync(ctx, 'u-attacker', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-1',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-attacker' },
  });

  assert.equal(deletes(), 0, 'pesan TIDAK boleh dihapus');
  assert.equal(
    sent.filter((c) => (c.data as { event?: string }).event === 'message:viewed').length,
    0,
    'receipt palsu tidak boleh dikirim'
  );
});

test('F-01: pengirim dengan deleteSecret sah tetap bisa menghapus pesan view-once', async () => {
  const secret = 'a'.repeat(64);
  const { ctx, deletes } = makeViewOnceCtx({
    senderId: null,
    storedDeleteSecret: sha256(secret),
  });
  await handleKeySync(ctx, 'u-sender', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-2',
    data: { messageId: 'm1', conversationId: 'c1', deleteSecret: secret },
  });
  assert.equal(deletes(), 1);
});

test('REG-1: payload Lightbox apa adanya (targetRecipient = id PENGIRIM) tetap menghapus + kirim viewed', async () => {
  const { ctx, sent, deletes } = makeViewOnceCtx({ senderId: null, receipt: true });
  await handleKeySync(ctx, 'u-recipient', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-3',
    // Bentuk persis `web/src/components/Lightbox.tsx`: id lawan bicara, tanpa
    // deleteSecret. Gate lama mensyaratkan `targetRecipient === userId` sehingga
    // pesan tidak pernah dihapus dan receipt tidak pernah terkirim.
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-sender' },
  });
  assert.equal(deletes(), 1, 'pesan view-once penerima harus dihapus dari antrean server');
  const viewed = sent.filter((c) => (c.data as { event?: string }).event === 'message:viewed');
  assert.equal(viewed.length, 1, 'pengirim harus menerima receipt viewed');
  assert.equal(viewed[0]!.target, 'u-sender');
});

test('REG-1: bukti peserta boleh session key (penerima belum pernah mengirim receipt)', async () => {
  const { ctx, deletes } = makeViewOnceCtx({ senderId: null, sessionKey: true });
  await handleKeySync(ctx, 'u-recipient', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-3b',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-sender' },
  });
  assert.equal(deletes(), 1);
});

test('REG-1 residual: view-once di GRUP tidak menghapus pesan anggota lain', async () => {
  const { ctx, sent, deletes, opens } = makeViewOnceCtx({ senderId: null, receipt: true, isGroup: true });
  await handleKeySync(ctx, 'u-recipient', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-group-1',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-sender' },
  });

  assert.equal(deletes(), 0, 'baris harus bertahan supaya anggota lain bisa membuka');
  assert.equal(opens().length, 1, 'pembukaan dicatat per penerima');
  assert.ok(opens()[0]!.openerTag.length > 0, 'tag pembaca opaque (bukan userId)');
  assert.notEqual(opens()[0]!.openerTag, 'u-recipient');
  assert.equal(
    sent.filter((c) => (c.data as { event?: string }).event === 'message:viewed').length,
    1,
    'pengirim tetap menerima receipt viewed'
  );
});

test('REG-1 lanjutan: view-once grup TIDAK dihapus selama masih ada penerima yang belum membuka', async () => {
  const { ctx, deletes, opens } = makeViewOnceCtx({
    senderId: null, receipt: true, isGroup: true, recipientCount: 2,
  });
  await handleKeySync(ctx, 'u-recipient-a', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-group-2a',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-sender' },
  });

  assert.equal(opens().length, 1);
  assert.equal(deletes(), 0, 'penerima kedua belum membuka — baris harus bertahan');
});

test('REG-1 lanjutan: penerima TERAKHIR membuka → baris dihapus tanpa menunggu expiresAt', async () => {
  const { ctx, deletes } = makeViewOnceCtx({
    senderId: null, receipt: true, isGroup: true, recipientCount: 1,
  });
  await handleKeySync(ctx, 'u-recipient', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-group-2b',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-sender' },
  });

  assert.equal(deletes(), 1, 'semua penerima yang tercatat sudah membuka');
});

test('REG-1: pesan NON view-once tidak bisa dihapus lewat event ini', async () => {
  const { ctx, deletes } = makeViewOnceCtx({ senderId: null, receipt: true, isViewOnce: false });
  await handleKeySync(ctx, 'u-recipient', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-3c',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-sender' },
  });
  assert.equal(deletes(), 0);
});

// ============================================================================
// F-02 — group:fulfilled_key
// ============================================================================

function makeGroupWriteCtx (opts: { member: boolean; adminToken?: string; isGroup?: boolean }) {
  let creates = 0;
  const adminSecretHash = opts.adminToken ? sha256(opts.adminToken) : null;
  const prisma: Record<string, unknown> = {
    conversation: {
      findUnique: async () => ({
        id: 'c1',
        isGroup: opts.isGroup ?? true,
        adminSecretHash,
        groupEpoch: 0,
      }),
      update: async () => ({ messageSeq: 1 }),
    },
    message: {
      create: async () => {
        creates += 1;
        return { id: 'sys-1' };
      },
    },
    userHiddenConversation: {
      // [PASS-2 N-03] Baris nyata selalu punya tokenEpoch + expiresAt (gate
      // `requireFresh` menolak baris tanpa keduanya).
      findFirst: async () => (opts.member
        ? { id: 'row', tokenEpoch: 0, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }
        : null),
      findMany: async () => [],
    },
  };
  prisma.$transaction = async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[]);

  const built = makeCtx(prisma);
  return { ...built, creates: () => creates };
}

test('F-02: group:fulfilled_key dari non-anggota tanpa token admin ditolak', async () => {
  const { ctx, sent, creates } = makeGroupWriteCtx({ member: false });
  await handleKeySync(ctx, 'u-attacker', 'd1', {
    event: 'group:fulfilled_key',
    msgId: 'evt-4',
    data: { requesterId: 'u-victim', conversationId: 'c1', encryptedKey: 'opaque' },
  });

  assert.equal(creates(), 0, 'tidak ada baris SYSTEM yang boleh ditulis');
  assert.equal(
    sent.filter((c) => (c.data as { event?: string }).event === 'session:new_key').length,
    0,
    'amplop tidak boleh direlay'
  );
});

test('F-02: pembuat grup (admin capability token) tetap bisa distribusi kunci pertama', async () => {
  const { ctx, sent, creates } = makeGroupWriteCtx({ member: false, adminToken: 'admin-token' });
  await handleKeySync(ctx, 'u-creator', 'd1', {
    event: 'group:fulfilled_key',
    msgId: 'evt-5',
    data: {
      requesterId: 'u-member',
      conversationId: 'c1',
      encryptedKey: 'opaque',
      adminCapabilityToken: 'admin-token',
    },
  });

  assert.equal(creates(), 1);
  assert.equal(
    sent.filter((c) => (c.data as { event?: string }).event === 'session:new_key').length,
    1
  );
});

test('F-02: anggota grup boleh menulis envelove kunci', async () => {
  const { ctx, creates } = makeGroupWriteCtx({ member: true });
  await handleKeySync(ctx, 'u-member', 'd1', {
    event: 'group:fulfilled_key',
    msgId: 'evt-6',
    data: { requesterId: 'u-other', conversationId: 'c1', encryptedKey: 'opaque' },
  });
  assert.equal(creates(), 1);
});

// ============================================================================
// F-05 — typing fan-out
// ============================================================================

test('F-05: typing dengan target melebihi cap ditolak seluruhnya', async () => {
  const { ctx, sent } = makeCtx({ userHiddenConversation: { findMany: async () => [] } });
  await handlePresence(ctx, 'u1', {
    event: 'typing:start',
    conversationId: 'c1',
    targetRecipients: Array.from({ length: MAX_TYPING_TARGETS + 1 }, (_, i) => `u${i}`),
  });

  assert.equal(
    sent.filter((c) => c.opCode === TransportOpCode.PRESENCE).length,
    0
  );
});

test('F-05: typing ke non-peer tidak diteruskan', async () => {
  const { ctx, sent } = makeCtx({
    userHiddenConversation: {
      findMany: async () => [{ conversationId: 'c1' }],
      findFirst: async () => null,
    },
    messageStatus: { findFirst: async () => null },
    sessionKey: { findFirst: async () => null },
  });
  await handlePresence(ctx, 'u1', {
    event: 'typing:start',
    conversationId: 'c1',
    targetRecipients: ['u-stranger'],
  });

  assert.equal(
    sent.filter((c) => c.opCode === TransportOpCode.PRESENCE).length,
    0
  );
});

// ============================================================================
// F-11 — session:fulfill_response tidak boleh menyemprot id sembarang
// ============================================================================

test('REG-2: typing 1:1 tetap sampai walau tidak ada baris keanggotaan (bukti receipt)', async () => {
  const { ctx, sent } = makeCtx({
    userHiddenConversation: { findMany: async () => [], findFirst: async () => null },
    messageStatus: { findFirst: async () => ({ id: 'receipt-1' }) },
    sessionKey: { findFirst: async () => null },
  });
  await handlePresence(ctx, 'u-a', {
    event: 'typing:start',
    conversationId: 'c1',
    targetRecipients: ['u-b'],
  });

  const typing = sent.filter((c) => c.opCode === TransportOpCode.PRESENCE);
  assert.equal(typing.length, 1, 'indikator typing 1:1 tidak boleh mati (REG-2)');
  assert.equal(typing[0]!.target, 'u-b');
});

test('REG-2: session:fulfill_response 1:1 direlay bila requester punya session key', async () => {
  const { ctx, sent } = makeCtx({
    userHiddenConversation: { findMany: async () => [], findFirst: async () => null },
    messageStatus: { findFirst: async () => null },
    sessionKey: { findFirst: async () => ({ id: 'sk-1' }) },
  });
  await handleKeySync(ctx, 'u-b', 'd1', {
    event: 'session:fulfill_response',
    msgId: 'evt-8',
    data: {
      requesterId: 'u-a',
      conversationId: 'c1',
      sessionId: 's1',
      encryptedKey: 'opaque',
    },
  });

  const relayed = sent.filter((c) => (c.data as { event?: string }).event === 'session:new_key');
  assert.equal(relayed.length, 1, 'pemulihan kunci sesi 1:1 tidak boleh ditolak hening');
  assert.equal(relayed[0]!.target, 'u-a');
});

test('F-11: session:fulfill_response ke non-peer ditolak', async () => {
  const { ctx, sent } = makeCtx({
    userHiddenConversation: { findMany: async () => [], findFirst: async () => null },
    messageStatus: { findFirst: async () => null },
    sessionKey: { findFirst: async () => null },
  });
  await handleKeySync(ctx, 'u1', 'd1', {
    event: 'session:fulfill_response',
    msgId: 'evt-7',
    data: {
      requesterId: 'u-stranger',
      conversationId: 'c1',
      sessionId: 's1',
      encryptedKey: 'opaque',
    },
  });

  assert.equal(
    sent.filter((c) => (c.data as { event?: string }).event === 'session:new_key').length,
    0
  );
});
