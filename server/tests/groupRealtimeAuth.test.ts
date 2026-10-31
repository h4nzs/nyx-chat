// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-31 — F-02] Gate tulis baris SYSTEM lewat jalur realtime.
 *
 * Yang dikunci: penulis harus anggota grup (baris UserHiddenConversation) ATAU
 * pemegang admin capability token (kasus createGroup, saat pembuat belum punya
 * baris keanggotaan). Target notifikasi disaring ke anggota asli.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  authorizeGroupSystemWrite,
  MAX_METADATA_TARGETS,
  type GroupRealtimeAuthDb,
} from '../src/utils/groupRealtimeAuth.js';
import { sealAtRest } from '../src/utils/atRestSecrets.js';

function adminHash (token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

interface FakeOptions {
  missing?: boolean;
  isGroup?: boolean;
  adminToken?: string;
  members?: string[];
}

/**
 * Fake Prisma minimal. Kolom `userId` di dunia nyata TER-SEAL, jadi fake ini
 * memakai nilai `sealAtRest` yang sama supaya jalur kandidat ikut teruji.
 */
async function makeDb (opts: FakeOptions): Promise<GroupRealtimeAuthDb> {
  const sealed = new Map<string, string>();
  for (const member of opts.members ?? []) {
    sealed.set(await sealAtRest(member), member);
  }
  const rows = Array.from(sealed.keys()).map((userId) => ({ userId }));
  const adminSecretHash = opts.adminToken ? adminHash(opts.adminToken) : null;

  const userHiddenConversation = {
    async findFirst (args: { where: Record<string, unknown> }) {
      const where = args.where as { userId?: { in?: string[] } };
      const candidates = where.userId?.in ?? [];
      return candidates.some((candidate) => sealed.has(candidate)) ? { id: 'row' } : null;
    },
    async findMany (args: { where: Record<string, unknown> }) {
      const where = args.where as { userId?: { in?: string[] } };
      const candidates = new Set(where.userId?.in ?? []);
      return rows.filter((row) => candidates.has(row.userId));
    },
  };

  return {
    conversation: {
      async findUnique () {
        if (opts.missing) return null;
        return { id: 'c1', isGroup: opts.isGroup ?? true, adminSecretHash };
      },
    },
    userHiddenConversation,
  } as unknown as GroupRealtimeAuthDb;
}

test('conversation tidak ada → not_found (tidak ada tulisan)', async () => {
  const db = await makeDb({ missing: true, members: ['u1'] });
  const decision = await authorizeGroupSystemWrite(db, { userId: 'u1', conversationId: 'c1' });
  assert.deepEqual(decision, { ok: false, reason: 'not_found' });
});

test('percakapan 1:1 ditolak — event ini hanya untuk grup', async () => {
  const db = await makeDb({ isGroup: false, members: ['u1'] });
  const decision = await authorizeGroupSystemWrite(db, { userId: 'u1', conversationId: 'c1' });
  assert.deepEqual(decision, { ok: false, reason: 'not_group' });
});

test('bukan anggota & tanpa admin token → unauthorized (skenario F-02)', async () => {
  const db = await makeDb({ members: ['u-member'] });
  const decision = await authorizeGroupSystemWrite(db, {
    userId: 'u-attacker',
    conversationId: 'c1',
  });
  assert.deepEqual(decision, { ok: false, reason: 'unauthorized' });
});

test('anggota grup boleh menulis', async () => {
  const db = await makeDb({ members: ['u1', 'u2'] });
  const decision = await authorizeGroupSystemWrite(db, { userId: 'u1', conversationId: 'c1' });
  assert.equal(decision.ok, true);
});

test('pembuat grup lolos lewat admin capability token (belum punya baris keanggotaan)', async () => {
  const db = await makeDb({ members: ['u-member'], adminToken: 'admin-token' });
  const creator = await authorizeGroupSystemWrite(db, {
    userId: 'u-creator',
    conversationId: 'c1',
    adminCapabilityToken: 'admin-token',
  });
  assert.equal(creator.ok, true);
});

test('token admin salah tidak memberi akses', async () => {
  const db = await makeDb({ members: ['u-member'], adminToken: 'admin-token' });
  const decision = await authorizeGroupSystemWrite(db, {
    userId: 'u-attacker',
    conversationId: 'c1',
    adminCapabilityToken: 'token-palsu',
  });
  assert.deepEqual(decision, { ok: false, reason: 'unauthorized' });
});

test('target notifikasi disaring ke anggota asli, berlebih dipotong', async () => {
  const members = ['u1', 'u2', 'u3'];
  const db = await makeDb({ members });
  const strangers = Array.from({ length: MAX_METADATA_TARGETS + 50 }, (_, i) => `ghost-${i}`);
  const decision = await authorizeGroupSystemWrite(db, {
    userId: 'u1',
    conversationId: 'c1',
    targetRecipients: ['u2', 'ghost-0', 'u3', 'u1', ...strangers],
  });
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.ok === true ? decision.allowedTargets : [], ['u2', 'u3', 'u1']);
});
