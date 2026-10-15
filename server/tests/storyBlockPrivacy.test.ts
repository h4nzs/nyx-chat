// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.3 — D8 & D9] Story & BlockedUser.
 *
 * D8: `Story.senderId` dulu FK asli → dump DB memberi "siapa membuat story
 *     kapan". Kini penulis disimpan sebagai `authorTag` ter-seal.
 * D9: `BlockedUser(blockerId, blockedId)` dulu graph permusuhan eksplisit.
 *     Kini pasangan tag ter-seal.
 *
 * Aturan yang TIDAK boleh dilanggar (diuji di sini):
 *   1. Tag ter-seal tidak pernah keluar ke klien — kalau bocor, penyerang
 *      dengan dump bisa memetakan tag → user dan proteksi seluruh kolom
 *      ter-seal (UHC routing, block) runtuh.
 *   2. Kontrak API klien tidak berubah (`senderId`/`{id}[]` tetap dikirim,
 *      di-resolve server saat request).
 *   3. Karena FK cascade hilang, penghapusan akun & dead man's switch wajib
 *      membersihkan baris milik user secara eksplisit.
 *
 * [2026-10 legacy purge] `authorTag`/`blockerTag`/`blockedTag` kini NOT NULL;
 * jalur baca tidak lagi mengenali baris plaintext lama.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { openAtRest } from '../src/utils/atRestSecrets.js';
import {
  blockedUserTag,
  purgeSealedUserRows,
  resolveRoutingUser,
  routingCandidates,
  routingIdentity,
  storyAuthorTag,
  type SealedOwnedRowsPrisma,
} from '../src/utils/routingIdentity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

function modelBody(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `model ${model} harus ada`);
  return match[1]!;
}

test('D8: storyAuthorTag deterministik, ter-seal, dan bisa dibuka server', async () => {
  const tag = await storyAuthorTag('u-han');
  assert.equal(tag, await routingIdentity('u-han'), 'Tag = primitive identity ter-seal yang sama');
  assert.notEqual(tag, 'u-han', 'bukan userId asli (D8)');
  assert.equal(await resolveRoutingUser(tag), 'u-han', 'server masih bisa menurunkan penulis untuk request');
  assert.notEqual(await storyAuthorTag('u-ken'), tag);
});

test('D9: blockedUserTag dipakai untuk kedua sisi relasi (blokir/unblock/gating)', async () => {
  const blocker = await blockedUserTag('u-han');
  const blocked = await blockedUserTag('u-ken');
  assert.notEqual(blocker, blocked, 'dua sisi relasi tidak boleh bertabrakan');
  assert.equal(await resolveRoutingUser(blocker), 'u-han');
  assert.equal(await resolveRoutingUser(blocked), 'u-ken');

  // Simulasi penyimpanan + gating: "apakah u-ken diblokir oleh u-han?"
  const rows = [{ blockerTag: blocker, blockedTag: blocked, createdAt: new Date() }];
  const isBlocked = rows.some(r => r.blockerTag === blocker && r.blockedTag === blocked);
  const isBlockedReverse = rows.some(r => r.blockerTag === blocked && r.blockedTag === blocker);
  assert.equal(isBlocked, true, 'arah blokir terdeteksi');
  assert.equal(isBlockedReverse, false, 'arah sebaliknya bukan relasi yang sama');
});

test('D2/D8/D9: purgeSealedUserRows membersihkan keanggotaan, Story & BlockedUser tanpa FK cascade', async () => {
  const calls: Array<{ model: string; where: Record<string, unknown> }> = [];
  const fake: SealedOwnedRowsPrisma = {
    // [BUGFIX 2026-10-09] UserHiddenConversation ikut dibersihkan eksplisit:
    // kolom userId ter-seal → tidak ada FK ke User untuk di-cascade.
    userHiddenConversation: {
      deleteMany: async ({ where }) => {
        calls.push({ model: 'userHiddenConversation', where });
        return { count: 1 };
      },
    },
    story: {
      deleteMany: async ({ where }) => {
        calls.push({ model: 'story', where });
        return { count: 2 };
      },
    },
    blockedUser: {
      deleteMany: async ({ where }) => {
        calls.push({ model: 'blockedUser', where });
        return { count: 3 };
      },
    },
  };

  await purgeSealedUserRows(fake, 'u-han');

  const tag = await storyAuthorTag('u-han');
  const membershipCandidates = await routingCandidates('u-han');
  assert.deepEqual(
    calls[0],
    { model: 'userHiddenConversation', where: { userId: { in: membershipCandidates } } },
    'keanggotaan grup dihapus via kandidat sealed + legacy'
  );
  assert.deepEqual(calls[1], { model: 'story', where: { authorTag: tag } }, 'story dihapus berdasarkan tag penulis');
  assert.deepEqual(
    calls[2],
    { model: 'blockedUser', where: { OR: [{ blockerTag: tag }, { blockedTag: tag }] } },
    'block dihapus di KEDUA arah relasi'
  );
});

test('D8/D9 schema: kolom identitas asli hilang, tag ter-seal menggantikan', () => {
  const schema = read('../prisma/schema.prisma');
  const story = modelBody(schema, 'Story');
  const blocked = modelBody(schema, 'BlockedUser');

  assert.doesNotMatch(story, /^\s*senderId\s+\S/m, 'Story tidak lagi punya kolom senderId');
  assert.doesNotMatch(story, /sender\s+User/, 'relasi FK ke User dihapus');
  assert.match(story, /authorTag\s+String\s/, 'penulis disimpan sebagai tag ter-seal (NOT NULL)');

  assert.doesNotMatch(blocked, /^\s*blockerId\s+\S/m, 'tidak ada kolom blockerId');
  assert.doesNotMatch(blocked, /^\s*blockedId\s+\S/m, 'tidak ada kolom blockedId');
  assert.doesNotMatch(blocked, /User\s+@relation/, 'tidak ada relasi FK ke User');
  assert.match(blocked, /blockerTag\s+String\s[\s\S]*blockedTag\s+String\s/, 'pasangan tag ter-seal (NOT NULL)');
  assert.match(blocked, /@@unique\(\[blockerTag, blockedTag\]\)/, 'uniqueness dipertahankan (idempoten)');

  const user = modelBody(schema, 'User');
  assert.doesNotMatch(user, /stories\s+Story\[\]/, 'relasi User.stories dihapus');
  assert.doesNotMatch(user, /blockedUsers\s+BlockedUser\[\]/, 'relasi User.blockedUsers dihapus');
});

test('D8: tag ter-seal TIDAK pernah dikirim ke klien (whitelist respons)', () => {
  const stories = read('../src/routes/stories.ts');

  assert.doesNotMatch(stories, /json\(\{ \.\.\.story/, 'dilarang menyebar record mentah (akan membocorkan authorTag)');
  assert.doesNotMatch(
    stories,
    /stories\.map\(s => \(\{ \.\.\.s/,
    'list story juga harus lewat whitelist'
  );
  assert.match(stories, /function toClientStory\(/, 'mapper whitelist ada');
  assert.match(stories, /res\.json\(stories\.map\(s => toClientStory\(s, userId\)\)\)/, 'list memakai mapper');
  assert.match(stories, /res\.json\(toClientStory\(story, authorId\)\)/, 'by-id memakai mapper');

  const mapper = stories.slice(stories.indexOf('function toClientStory'));
  const mapperBody = mapper.slice(0, mapper.indexOf('\n}'));
  assert.doesNotMatch(mapperBody, /authorTag/, 'authorTag tidak boleh ada di respons');
  assert.match(mapperBody, /senderId/, 'senderId (identitas asli, di-resolve server) tetap dikirim → kontrak klien utuh');
});

test('D9: endpoint block memakai pasangan tag & tetap mengembalikan identitas untuk UI', () => {
  const users = read('../src/routes/users.ts');

  assert.match(users, /where: \{ blockerTag_blockedTag: \{ blockerTag, blockedTag \} \}/, 'block = upsert pasangan tag');
  assert.doesNotMatch(users, /blockerId_blockedId/, 'regresi D9: compound key lama berbasis identitas');
  assert.match(users, /where: \{ blockerTag: await blockedUserTag\(userId\) \}/, 'list blocked memakai tag');
  assert.match(users, /resolveRoutingUser\(r\.blockedTag\)/, 'identitas diblokir dibuka untuk respons (kontrak klien)');
  assert.match(users, /purgeSealedUserRows\(prisma as unknown as SealedOwnedRowsPrisma, userId\)/, 'hapus akun membersihkan baris tanpa FK');
});

test('D8/D9: dead man’s switch juga membersihkan baris milik user', () => {
  // Kebijakan auto-destruct hidup di `jobs/cleanup.ts` (dipisah supaya cron dan
  // `/api/admin/cleanup` menjalankan kode yang sama); pengikatan Prisma nyata
  // (`purgeSealedUserRows`) ada di pemanggilnya.
  const cleanup = read('../src/jobs/cleanup.ts');
  assert.match(cleanup, /await purgeUser\(user\.id\)/, 'auto-destruct membersihkan baris ter-seal sebelum akun dihapus');
  assert.ok(
    cleanup.indexOf('await purgeUser(user.id)') < cleanup.indexOf('await db.user.deleteMany({ where: { id: user.id } })'),
    'urutan benar: bersihkan dulu, baru hapus akun'
  );

  const sweeper = read('../src/jobs/systemSweeper.ts');
  assert.match(sweeper, /purgeUser: \(userId\) => purgeSealedUserRows\(prisma, userId\)/, 'sweeper menyuntik pembersih nyata');
});

test('D8/D9: nilai NULL/plaintext tidak melempar, tapi juga tidak dikenali', async () => {
  // Baris baru: tag ter-seal (NOT NULL). Nilai lama (NULL/identitas mentah) tidak
  // lagi punya jalur pembacaan — resolve mengembalikan null, bukan crash.
  assert.equal(await resolveRoutingUser(null), null, 'NULL → null, bukan crash');
  assert.equal(await resolveRoutingUser('u-lama'), null, 'identitas plaintext tidak lagi terbaca');
  assert.equal(await openAtRest('u-lama'), null, 'plaintext memang bukan ciphertext');
});
