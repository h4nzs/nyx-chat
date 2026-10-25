// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.2 — D2 lanjutan] Routing identity `UserHiddenConversation`.
 *
 * Kolom itu dulu menyimpan userId ASLI tiap anggota (routing-only, tapi di dump
 * ia = daftar keanggotaan: siapa di grup mana). Sekarang nilainya di-seal
 * (AEAD deterministik, kunci dari pepper) sehingga:
 *   - server tetap bisa membukanya untuk push/sweeper/broadcast,
 *   - dump saja tidak bisa membaca keanggotaan,
 *   - lookup/upsert tetap deterministik (nilai kanonik = seal tunggal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { openAtRest } from '../src/utils/atRestSecrets.js';
import {
  deleteMembership,
  findMembership,
  purgeSealedUserRows,
  resolveRoutingUser,
  routingCandidates,
  routingIdentity,
  upsertMembership,
  type MembershipPrisma,
  type SealedOwnedRowsPrisma,
} from '../src/utils/routingIdentity.js';
import { hashGroupToken } from '../src/utils/groupTokens.js';

// Token uji 43-char (validasi bentuk tidak dilakukan di util, tapi ini bentuk nyata).
const TOKEN_1 = 'A'.repeat(43);
const TOKEN_2 = 'B'.repeat(43);

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

type UhcRow = { id: string; userId: string | null; conversationId: string; tokenHash: string; tokenEpoch: number; expiresAt: Date };

/** Fake minimal: menyimpan baris in-memory supaya alur upsert/delete bisa diuji. */
function makeFake(rows: UhcRow[] = []): {
  prisma: MembershipPrisma;
  rows: UhcRow[];
  log: string[];
} {
  const log: string[] = [];
  const prisma: MembershipPrisma = {
    userHiddenConversation: {
      findFirst: async ({ where }) => {
        log.push('findFirst');
        const conversationId = (where.conversationId as string | undefined) ?? undefined;
        const userIdFilter = where.userId as { in?: string[] } | undefined;
        const candidates = userIdFilter?.in ?? [];
        const found = rows.find(
          (r) =>
            (conversationId === undefined || r.conversationId === conversationId) &&
            r.userId !== null &&
            candidates.includes(r.userId)
        );
        return found ? { id: found.id } : null;
      },
      update: async ({ where, data }) => {
        log.push('update');
        const row = rows.find((r) => r.id === where.id);
        if (row) {
          row.tokenHash = data.tokenHash as string;
          row.tokenEpoch = data.tokenEpoch as number;
          row.expiresAt = data.expiresAt as Date;
        }
        return row;
      },
      create: async ({ data }) => {
        log.push('create');
        const row: UhcRow = { id: `row-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        log.push('deleteMany');
        const conversationId = where.conversationId as string | undefined;
        const candidates = (where.userId as { in?: string[] } | undefined)?.in ?? [];
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i]!;
          if (r.conversationId === conversationId && r.userId !== null && candidates.includes(r.userId)) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      },
    },
  };
  return { prisma, rows, log };
}

test('routingIdentity: sealed deterministik, bukan userId, bisa dibuka server', async () => {
  const sealed = await routingIdentity('u-han');
  assert.notEqual(sealed, 'u-han', 'nilai DB bukan userId asli (D2)');
  assert.equal(await routingIdentity('u-han'), sealed, 'deterministik → indeks [userId, conversationId] tetap jalan');
  assert.equal(await openAtRest(sealed), 'u-han', 'server masih bisa membuka untuk routing');
  assert.notEqual(await routingIdentity('u-ken'), sealed, 'user berbeda → nilai berbeda');
});

test('routingCandidates: satu nilai kanonik (sealed), tanpa kandidat plaintext', async () => {
  const candidates = await routingCandidates('u-han');
  assert.deepEqual(candidates, [await routingIdentity('u-han')]);
  assert.notEqual(candidates[0], 'u-han', 'userId asli tidak pernah jadi kandidat');
});

test('resolveRoutingUser: sealed → userId, plaintext/kosong → null', async () => {
  assert.equal(await resolveRoutingUser(await routingIdentity('u-han')), 'u-han');
  assert.equal(await resolveRoutingUser('u-plaintext'), null, 'nilai plaintext tidak lagi dikenali');
  assert.equal(await resolveRoutingUser(null), null);
  assert.equal(await resolveRoutingUser(''), null);
});

test('upsertMembership: baris baru disimpan ter-seal (bukan userId asli)', async () => {
  const { prisma, rows } = makeFake();
  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', token: TOKEN_1 });

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.userId, 'u-han');
  assert.equal(await openAtRest(rows[0]!.userId), 'u-han', 'routing tetap bisa menemukan user');
  assert.match(rows[0]!.tokenHash, /^[a-f0-9]{64}$/, 'token disimpan sebagai SHA-256 hex');
  assert.equal(rows[0]!.tokenHash, hashGroupToken(TOKEN_1), 'hash cocok dengan token mentah');
});

test('upsertMembership: baris plaintext lama tidak dikenali → baris baru ber-seal', async () => {
  // Tidak ada lagi baris plaintext di DB (reset + purge). Kalaupun ada, ia
  // tidak bisa dicocokkan oleh nilai kanonik sealed dan akan dibiarkan sebagai
  // sisa lama — bukan di-upgrade diam-diam (FK/NOT NULL sudah tidak menyisakan
  // jalur itu). Yang penting: penulisan baru selalu ber-seal.
  const { prisma, rows, log } = makeFake([
    { id: 'row-1', userId: 'u-han', conversationId: 'c1', tokenHash: 'old', tokenEpoch: 0, expiresAt: new Date() },
  ]);

  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', token: TOKEN_2 });

  assert.deepEqual(log, ['findFirst', 'create'], 'tidak cocok → baris baru dibuat');
  const created = rows[1]!;
  assert.notEqual(created.userId, 'u-han');
  assert.equal(await openAtRest(created.userId), 'u-han', 'baris baru ter-seal');
  assert.equal(created.tokenHash, hashGroupToken(TOKEN_2));
});

test('upsertMembership: pengulangan tidak menggandakan baris (determinisme seal)', async () => {
  const { prisma, rows } = makeFake();
  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', token: TOKEN_1 });
  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', token: TOKEN_2 });

  assert.equal(rows.length, 1, 'sealed deterministik → findFirst menemukan baris yang sama');
  assert.equal(rows[0]!.tokenHash, hashGroupToken(TOKEN_2));
});

test('findMembership/deleteMembership: mengenali baris sealed saja', async () => {
  const sealedRow = makeFake([
    { id: 'row-1', userId: await routingIdentity('u-han'), conversationId: 'c1', tokenHash: 'h1', tokenEpoch: 0, expiresAt: new Date() },
  ]);
  assert.equal(await findMembership(sealedRow.prisma, { userId: 'u-han', conversationId: 'c1' }), true);
  assert.equal(await deleteMembership(sealedRow.prisma, { userId: 'u-han', conversationId: 'c1' }), 1);
  assert.equal(sealedRow.rows.length, 0);

  const plaintextRow = makeFake([
    { id: 'row-1', userId: 'u-plaintext', conversationId: 'c2', tokenHash: 'h2', tokenEpoch: 0, expiresAt: new Date() },
  ]);
  assert.equal(await findMembership(plaintextRow.prisma, { userId: 'u-plaintext', conversationId: 'c2' }), false);
  assert.equal(await deleteMembership(plaintextRow.prisma, { userId: 'u-plaintext', conversationId: 'c2' }), 0);

  const empty = makeFake();
  assert.equal(await findMembership(empty.prisma, { userId: 'u-x', conversationId: 'c9' }), false);
  assert.equal(await deleteMembership(empty.prisma, { userId: 'u-x', conversationId: 'c9' }), 0);
});

test('purgeSealedUserRows: bersihkan keanggotaan ber-seal, story, dan block', async () => {
  // [BUGFIX 2026-10-09] UserHiddenConversation tidak punya FK ke User lagi
  // (nilai kolom ter-seal), jadi pembersihan saat akun dihapus harus eksplisit.
  const tag = await routingIdentity('u-han');
  const rows: UhcRow[] = [
    { id: 'row-1', userId: tag, conversationId: 'c1', tokenHash: 'h1', tokenEpoch: 0, expiresAt: new Date() },
    { id: 'row-2', userId: await routingIdentity('u-other'), conversationId: 'c1', tokenHash: 'h3', tokenEpoch: 0, expiresAt: new Date() },
  ];
  const calls: string[] = [];

  const prisma: SealedOwnedRowsPrisma = {
    userHiddenConversation: {
      deleteMany: async ({ where }) => {
        calls.push('membership');
        const candidates = (where.userId as { in: string[] }).in;
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i]!;
          if (r.userId !== null && candidates.includes(r.userId)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
    story: {
      deleteMany: async ({ where }) => {
        // [docs/37 §37.4 P6] story dihapus dengan SELURUH kandidat kunci seal
        // (aktif + legacy), jadi bentuk `in` yang benar — bukan nilai tunggal.
        const candidates = (where as { authorTag: { in: string[] } }).authorTag.in;
        assert.ok(candidates.includes(tag), 'kandidat memuat tag kunci aktif');
        calls.push('story');
        return { count: 1 };
      },
    },
    blockedUser: {
      deleteMany: async ({ where }) => {
        calls.push('blockedUser');
        assert.ok(Array.isArray((where as { OR?: unknown[] }).OR), 'block user/blokir dicari via OR');
        return { count: 2 };
      },
    },
  };

  await purgeSealedUserRows(prisma, 'u-han');

  assert.deepEqual(rows.map((r) => r.id), ['row-2'], 'baris user lain tidak ikut terhapus');
  assert.deepEqual(calls, ['membership', 'story', 'blockedUser']);
});

test('Tier 1.2 wiring: tidak ada penulisan userId mentah ke UserHiddenConversation', () => {
  const handlers = read('../src/network/realtimeHandlers.ts');
  const messages = read('../src/routes/messages.ts');
  const conversations = read('../src/routes/conversations.ts');
  const sweeper = read('../src/jobs/messageSweeper.ts');
  const users = read('../src/routes/users.ts');
  const presence = read('../src/utils/presencePeers.ts');

  for (const [name, src] of [['realtimeHandlers', handlers], ['messages', messages], ['conversations', conversations]] as const) {
    assert.doesNotMatch(src, /userHiddenConversation\.upsert\(/, `${name}: penulisan wajib lewat upsertMembership (sealing)`);
    assert.doesNotMatch(
      src,
      /userHiddenConversation\.delete\(\{[\s\S]{0,80}userId_conversationId/,
      `${name}: revocation wajib lewat deleteMembership (nilai kanonik sealed)`
    );
  }

  assert.equal(
    (handlers.match(/upsertMembership\(/g) || []).length + (messages.match(/upsertMembership\(/g) || []).length + (conversations.match(/upsertMembership\(/g) || []).length,
    4,
    'empat jalur penulisan keanggotaan memakai helper'
  );

  assert.match(sweeper, /await resolveRoutingUser\(uc\.userId\)/, 'sweeper membuka routing identity sebelum notifikasi');
  assert.match(users, /await resolveRoutingUser\(p\.userId\)/, 'broadcast profil membuka routing identity peer');
  assert.match(presence, /await routingCandidates\(userId\)/, 'presence memakai kandidat lookup');
  assert.match(presence, /peers\.map\(\(p\) => resolveRoutingUser\(p\.userId\)\)/, 'presence membuka routing identity peer');
});
