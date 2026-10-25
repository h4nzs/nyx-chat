// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4) — sisa "jalur admin grup lain"; `docs/29` §5.8] Perilaku
 * otorisasi endpoint grup diuji dengan klien Prisma palsu, bukan regex atas
 * source:
 *
 *   POST   /:id/participants          → authorizeMemberMutation
 *   DELETE /:id/participants/:userId  → authorizeMemberRemoval (admin-only)
 *   DELETE /:id/leave                 → authorizeMemberLeave
 *   PUT    /:id/details               → authorizeDetailsWrite
 *   POST   /:id/key-rotation          → authorizeKeyRotation
 *   DELETE /:id/group                 → authorizeGroupPurge
 *
 * Yang dikunci di sini adalah **matriks keputusan + urutannya**: kode status,
 * pesan kontrak, bahwa tidak ada cabang fail-open, bahwa hitungan anggota
 * diperiksa sebelum `ok` (409 lebih dulu), dan bahwa pencarian keanggotaan
 * memakai nilai routing ter-seal (userId mentah tidak pernah jadi nilai query).
 *
 * Tidak butuh Postgres/Redis (`AGENTS.md`): semua query dilayani fake in-memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeMemberMutation,
  authorizeMemberRemoval,
  authorizeMemberLeave,
  authorizeDetailsWrite,
  authorizeKeyRotation,
  authorizeGroupPurge,
  BLIND_AUTH_REQUIRED,
  MEMBERS_REMAIN,
  type GroupAccessDb,
} from '../src/utils/groupAccess.js';
import { hashAdminToken } from '../src/utils/adminCapability.js';
import { hashCredentialToken, clearAtRestSecretCacheForTests } from '../src/utils/atRestSecrets.js';

const CONVERSATION_ID = 'conv-1';
const GHOST_CONVERSATION_ID = 'conv-ghost';
const USER_ID = 'user-1';
const GROUP_TOKEN = 'group-secret-token-yang-panjang';
const ADMIN_TOKEN = 'admin-secret-token-yang-panjang';

interface FakeOptions {
  /** Conversation ada? Default true. */
  exists?: boolean;
  /** Nilai `isGroup` (dipakai guard purge). */
  isGroup?: boolean;
  /** Jumlah baris keanggotaan tersisa (guard purge). */
  remainingMembers?: number;
  /** Hash admin tersimpan; `null` = fail-closed (warisan pembersihan legacy). */
  adminSecretHash?: string | null;
  /** Pemanggil punya baris delivery-token sendiri? (leave tanpa group token) */
  ownsDeliveryToken?: boolean;
  /** Group token sudah lewat TTL? Default false (tanpa `groupTokenExpiresAt`). */
  groupTokenExpired?: boolean;
}

function fakeDb(options: FakeOptions = {}): {
  db: GroupAccessDb;
  calls: {
    conversationSelects: Array<Record<string, boolean>>;
    memberCounts: string[];
    membershipQueries: Array<Record<string, unknown>>;
  };
} {
  const {
    exists = true,
    isGroup = true,
    remainingMembers = 0,
    adminSecretHash = hashAdminToken(ADMIN_TOKEN),
    ownsDeliveryToken = false,
    groupTokenExpired = false,
  } = options;

  const calls = {
    conversationSelects: [] as Array<Record<string, boolean>>,
    memberCounts: [] as string[],
    membershipQueries: [] as Array<Record<string, unknown>>,
  };

  const db: GroupAccessDb = {
    conversation: {
      async findUnique({ where, select }) {
        calls.conversationSelects.push(select);
        if (!exists || where.id === GHOST_CONVERSATION_ID || where.id !== CONVERSATION_ID) return null;
        return {
          authSecret: hashCredentialToken(GROUP_TOKEN),
          adminSecretHash,
          isGroup,
          groupTokenExpiresAt: groupTokenExpired
            ? new Date(Date.now() - 60_000)
            : new Date(Date.now() + 60_000),
        };
      },
    },
    userHiddenConversation: {
      async findFirst({ where }) {
        calls.membershipQueries.push(where);
        return ownsDeliveryToken ? { id: 'uhc-1' } : null;
      },
      async count({ where }) {
        calls.memberCounts.push(where.conversationId);
        return remainingMembers;
      },
    },
  };

  return { db, calls };
}

/** Jalankan dengan pepper agar `sealAtRest` (nilai routing) bisa dipakai. */
async function withPepper<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NYX_AT_REST_PEPPER;
  process.env.NYX_AT_REST_PEPPER = 'test-pepper-group-access';
  clearAtRestSecretCacheForTests();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NYX_AT_REST_PEPPER;
    else process.env.NYX_AT_REST_PEPPER = prev;
    clearAtRestSecretCacheForTests();
  }
}

const headers = (extra: Record<string, string> = {}) => ({ 'x-group-token': GROUP_TOKEN, ...extra });

// ─── Tambah/kick anggota ────────────────────────────────────────────────────

test('tambah/kick anggota: conversation hilang → 404 (tanpa semantik izin)', async () => {
  const { db } = fakeDb({ exists: false });
  assert.deepEqual(await authorizeMemberMutation(db, GHOST_CONVERSATION_ID, headers()), {
    ok: false,
    status: 404,
    error: 'Not found',
  });
});

test('tambah/kick anggota: tanpa token, token salah, atau token tipe salah → 403 fail-closed', async () => {
  const { db } = fakeDb();
  for (const bad of [{}, { 'x-group-token': '' }, { 'x-group-token': 'token-salah' }, { 'x-group-token': 42 }, { 'x-group-token': ['a'] }]) {
    assert.deepEqual(await authorizeMemberMutation(db, CONVERSATION_ID, bad as Record<string, unknown>), {
      ok: false,
      status: 403,
      error: BLIND_AUTH_REQUIRED,
    });
  }
});

test('tambah anggota: group token lewat TTL → 403 walau hash cocok', async () => {
  const { db } = fakeDb({ groupTokenExpired: true });
  assert.deepEqual(await authorizeMemberMutation(db, CONVERSATION_ID, headers()), {
    ok: false,
    status: 403,
    error: BLIND_AUTH_REQUIRED,
  });
});

test('tambah/kick anggota: X-Group-Token benar → ok', async () => {
  const { db, calls } = fakeDb();
  assert.deepEqual(await authorizeMemberMutation(db, CONVERSATION_ID, headers()), { ok: true });
  // Jalur anggota tidak boleh menyentuh capability admin / hitungan anggota.
  assert.ok(calls.conversationSelects.every((s) => s.adminSecretHash !== true), 'tidak membaca hash admin');
  assert.equal(calls.memberCounts.length, 0, 'tidak menghitung anggota');
});

// ─── Kick anggota (admin-only) ─────────────────────────────────────────────

test('kick anggota: token grup saja ditolak; X-Admin-Token benar → ok', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await authorizeMemberRemoval(db, CONVERSATION_ID, headers()), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
  assert.deepEqual(
    await authorizeMemberRemoval(db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })),
    { ok: true }
  );
  assert.deepEqual(
    await authorizeMemberRemoval(db, GHOST_CONVERSATION_ID, { 'x-admin-token': ADMIN_TOKEN }),
    { ok: false, status: 404, error: 'Not found' }
  );
});

// ─── Leave ─────────────────────────────────────────────────────────────────

test('leave: conversation hilang → tetap 404 (jalur kedua tidak boleh meloloskan)', async () => {
  const { db } = fakeDb({ exists: false, ownsDeliveryToken: true });
  assert.deepEqual(await authorizeMemberLeave(db, GHOST_CONVERSATION_ID, {}, USER_ID), {
    ok: false,
    status: 404,
    error: 'Not found',
  });
});

test('leave: token grup benar → ok tanpa query keanggotaan', async () => {
  const { db, calls } = fakeDb();
  assert.deepEqual(await authorizeMemberLeave(db, CONVERSATION_ID, headers(), USER_ID), { ok: true });
  assert.equal(calls.membershipQueries.length, 0);
});

test('leave tanpa metadata: baris delivery-token sendiri → ok, dan lookup memakai nilai ter-seal', async () => {
  await withPepper(async () => {
    const { db, calls } = fakeDb({ ownsDeliveryToken: true });
    assert.deepEqual(await authorizeMemberLeave(db, CONVERSATION_ID, {}, USER_ID), { ok: true });

    assert.equal(calls.membershipQueries.length, 1, 'satu query keanggotaan');
    const where = calls.membershipQueries[0]!;
    assert.equal(where.conversationId, CONVERSATION_ID);
    const candidates = (where.userId as { in?: string[] }).in ?? [];
    assert.ok(candidates.length > 0, 'lookup harus lewat kandidat routing');
    assert.ok(
      candidates.every((c) => c !== USER_ID),
      'userId mentah tidak boleh jadi nilai query (docs/28 Tier 1.2)'
    );
  });
});

test('leave: tanpa token grup DAN tanpa baris keanggotaan → 403 fail-closed', async () => {
  await withPepper(async () => {
    const { db } = fakeDb({ ownsDeliveryToken: false });
    assert.deepEqual(await authorizeMemberLeave(db, CONVERSATION_ID, {}, USER_ID), {
      ok: false,
      status: 403,
      error: BLIND_AUTH_REQUIRED,
    });
  });
});

// ─── Tulis metadata (details) ───────────────────────────────────────────────

test('details: 403 untuk conversation hilang ATAU token salah (kontrak lama, bukan 404)', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await authorizeDetailsWrite(db, GHOST_CONVERSATION_ID, headers()), {
    ok: false,
    status: 403,
    error: BLIND_AUTH_REQUIRED,
  });
  assert.deepEqual(await authorizeDetailsWrite(db, CONVERSATION_ID, {}), {
    ok: false,
    status: 403,
    error: BLIND_AUTH_REQUIRED,
  });
});

test('details: token grup benar tapi tanpa X-Admin-Token → 403 ADMIN_AUTH_REQUIRED', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await authorizeDetailsWrite(db, CONVERSATION_ID, headers()), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
});

test('details: token grup salah TIDAK memeriksa admin (urutannya token dulu)', async () => {
  const { db, calls } = fakeDb();
  await authorizeDetailsWrite(db, CONVERSATION_ID, { 'x-group-token': 'salah', 'x-admin-token': ADMIN_TOKEN });
  assert.ok(
    calls.conversationSelects.every((s) => s.adminSecretHash !== true),
    'token salah → hash admin tidak boleh dibaca'
  );
});

test('details: token grup + X-Admin-Token benar → ok', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await authorizeDetailsWrite(db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })), { ok: true });
});

test('details: hash admin NULL (legacy) → fail-closed walau token apa pun', async () => {
  const { db } = fakeDb({ adminSecretHash: null });
  assert.deepEqual(await authorizeDetailsWrite(db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
});

// ─── Rotasi kunci ───────────────────────────────────────────────────────────

test('rotasi kunci: admin-only (tanpa capability → 403, conversation hilang → 404)', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await authorizeKeyRotation(db, CONVERSATION_ID, {}), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
  assert.deepEqual(await authorizeKeyRotation(db, GHOST_CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })), {
    ok: false,
    status: 404,
    error: 'Not found',
  });
  assert.deepEqual(await authorizeKeyRotation(db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })), { ok: true });
});

// ─── Purge grup ─────────────────────────────────────────────────────────────

test('purge: 404 conversation hilang, 400 bukan grup, 403 token salah', async () => {
  assert.deepEqual(
    await authorizeGroupPurge(fakeDb({ exists: false }).db, GHOST_CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })),
    { ok: false, status: 404, error: 'Not found' }
  );
  assert.deepEqual(
    await authorizeGroupPurge(fakeDb({ isGroup: false }).db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })),
    { ok: false, status: 400, error: 'Not a group' }
  );
  assert.deepEqual(
    await authorizeGroupPurge(fakeDb().db, CONVERSATION_ID, { 'x-admin-token': ADMIN_TOKEN }),
    { ok: false, status: 403, error: BLIND_AUTH_REQUIRED }
  );
});

test('purge: tanpa capability admin → 403 dan anggota TIDAK dihitung', async () => {
  const { db, calls } = fakeDb({ remainingMembers: 3 });
  assert.deepEqual(await authorizeGroupPurge(db, CONVERSATION_ID, headers()), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
  assert.equal(calls.memberCounts.length, 0, 'gate admin harus mendahului hitungan anggota');
});

test('purge: masih ada anggota → 409 MEMBERS_REMAIN (bukan ok)', async () => {
  const { db, calls } = fakeDb({ remainingMembers: 1 });
  assert.deepEqual(await authorizeGroupPurge(db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })), {
    ok: false,
    status: 409,
    error: MEMBERS_REMAIN,
  });
  assert.deepEqual(calls.memberCounts, [CONVERSATION_ID]);
});

test('purge: token + admin benar dan nol anggota → ok (pemanggil boleh menghapus)', async () => {
  const { db, calls } = fakeDb({ remainingMembers: 0 });
  assert.deepEqual(await authorizeGroupPurge(db, CONVERSATION_ID, headers({ 'x-admin-token': ADMIN_TOKEN })), { ok: true });
  assert.deepEqual(calls.memberCounts, [CONVERSATION_ID]);
});
