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

function makeViewOnceCtx (opts: {
  senderId: string | null;
  storedDeleteSecret?: string | null;
  receipt?: boolean;
}) {
  let deletes = 0;
  const prisma = {
    message: {
      findUnique: async () => ({
        conversationId: 'c1',
        senderId: opts.senderId,
        deleteSecret: opts.storedDeleteSecret ?? null,
      }),
      delete: async () => { deletes += 1; return {}; },
    },
    messageStatus: {
      findUnique: async () => (opts.receipt ? { status: 'DELIVERED' } : null),
    },
    userHiddenConversation: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    conversation: { findUnique: async () => ({ id: 'c1', isGroup: false }) },
  };
  const built = makeCtx(prisma);
  return { ...built, deletes: () => deletes };
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

test('F-01: penerima dengan baris receipt server boleh meng-obliterate', async () => {
  const { ctx, deletes } = makeViewOnceCtx({ senderId: null, receipt: true });
  await handleKeySync(ctx, 'u-recipient', 'd1', {
    event: 'message:view_once_opened',
    msgId: 'evt-3',
    data: { messageId: 'm1', conversationId: 'c1', targetRecipient: 'u-recipient' },
  });
  assert.equal(deletes(), 1);
});

// ============================================================================
// F-02 — group:fulfilled_key
// ============================================================================

function makeGroupWriteCtx (opts: { member: boolean; adminToken?: string; isGroup?: boolean }) {
  let creates = 0;
  const adminSecretHash = opts.adminToken ? sha256(opts.adminToken) : null;
  const prisma: Record<string, unknown> = {
    conversation: {
      findUnique: async () => ({ id: 'c1', isGroup: opts.isGroup ?? true, adminSecretHash }),
      update: async () => ({ messageSeq: 1 }),
    },
    message: {
      create: async () => {
        creates += 1;
        return { id: 'sys-1' };
      },
    },
    userHiddenConversation: {
      findFirst: async () => (opts.member ? { id: 'row' } : null),
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
    },
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

test('F-11: session:fulfill_response ke non-peer ditolak', async () => {
  const { ctx, sent } = makeCtx({ userHiddenConversation: { findMany: async () => [] } });
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
