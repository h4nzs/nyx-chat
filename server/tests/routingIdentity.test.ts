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
 *   - lookup/upsert tetap deterministik (kandidat sealed + legacy).
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
  resolveRoutingUser,
  routingCandidates,
  routingIdentity,
  upsertMembership,
  type MembershipPrisma,
} from '../src/utils/routingIdentity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

type UhcRow = { id: string; userId: string | null; conversationId: string; deliveryToken: string };

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
        if (row) row.deliveryToken = data.deliveryToken;
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

test('routingCandidates: [ter-seal, apa adanya] untuk baris legacy', async () => {
  const candidates = await routingCandidates('u-han');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0], await routingIdentity('u-han'));
  assert.equal(candidates[1], 'u-han', 'kandidat kedua melayani baris lama (plaintext)');
});

test('resolveRoutingUser: sealed → userId, plaintext legacy → apa adanya, kosong → null', async () => {
  assert.equal(await resolveRoutingUser(await routingIdentity('u-han')), 'u-han');
  assert.equal(await resolveRoutingUser('u-legacy'), 'u-legacy');
  assert.equal(await resolveRoutingUser(null), null);
  assert.equal(await resolveRoutingUser(''), null);
});

test('upsertMembership: baris baru disimpan ter-seal (bukan userId asli)', async () => {
  const { prisma, rows } = makeFake();
  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', deliveryToken: 'tok-1' });

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.userId, 'u-han');
  assert.equal(await openAtRest(rows[0]!.userId), 'u-han', 'routing tetap bisa menemukan user');
  assert.equal(rows[0]!.deliveryToken, 'tok-1');
});

test('upsertMembership: baris legacy plaintext di-upgrade, bukan diduplikasi', async () => {
  const { prisma, rows, log } = makeFake([
    { id: 'row-1', userId: 'u-han', conversationId: 'c1', deliveryToken: 'tok-lama' },
  ]);

  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', deliveryToken: 'tok-baru' });

  assert.equal(rows.length, 1, 'tidak ada duplikat (deliveryToken unik tidak dilanggar)');
  assert.equal(rows[0]!.deliveryToken, 'tok-baru');
  assert.equal(rows[0]!.userId, 'u-han', 'baris legacy tidak diubah nilainya (masih plaintext)');
  assert.deepEqual(log, ['findFirst', 'update'], 'jalur update, bukan create');
});

test('upsertMembership: pengulangan tidak menggandakan baris (determinisme seal)', async () => {
  const { prisma, rows } = makeFake();
  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', deliveryToken: 'tok-1' });
  await upsertMembership(prisma, { userId: 'u-han', conversationId: 'c1', deliveryToken: 'tok-2' });

  assert.equal(rows.length, 1, 'sealed deterministik → findFirst menemukan baris yang sama');
  assert.equal(rows[0]!.deliveryToken, 'tok-2');
});

test('findMembership/deleteMembership: mengenali baris sealed maupun legacy', async () => {
  const sealedRow = makeFake([
    { id: 'row-1', userId: await routingIdentity('u-han'), conversationId: 'c1', deliveryToken: 't1' },
  ]);
  assert.equal(await findMembership(sealedRow.prisma, { userId: 'u-han', conversationId: 'c1' }), true);
  assert.equal(await deleteMembership(sealedRow.prisma, { userId: 'u-han', conversationId: 'c1' }), 1);
  assert.equal(sealedRow.rows.length, 0);

  const legacyRow = makeFake([
    { id: 'row-1', userId: 'u-legacy', conversationId: 'c2', deliveryToken: 't2' },
  ]);
  assert.equal(await findMembership(legacyRow.prisma, { userId: 'u-legacy', conversationId: 'c2' }), true);
  assert.equal(await deleteMembership(legacyRow.prisma, { userId: 'u-legacy', conversationId: 'c2' }), 1);

  const empty = makeFake();
  assert.equal(await findMembership(empty.prisma, { userId: 'u-x', conversationId: 'c9' }), false);
  assert.equal(await deleteMembership(empty.prisma, { userId: 'u-x', conversationId: 'c9' }), 0);
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
      `${name}: revocation wajib lewat deleteMembership (kandidat sealed + legacy)`
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
