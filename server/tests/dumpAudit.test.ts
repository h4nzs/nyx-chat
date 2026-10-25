// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 3.2] Unit test untuk logika analisis dump — memakai FIXTURE,
 * tanpa Postgres. Script nyata (`scripts/privacy-dump-audit.ts`) hanya
 * membungkus fungsi-fungsi ini: seed DB → `pg_dump` → `auditDumpForIdentityLeaks`.
 *
 * Dua kontrol wajib ada supaya guardrail tidak vakum:
 *  - dump "bersih" → audit LULUS (tidak ada false positive), dan
 *  - dump "bocor" (userId asli di kolom identitas) → audit GAGAL (benar-benar
 *    menangkap regresi, bukan sekadar hijau).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditDumpForIdentityLeaks,
  auditPassed,
  auditRedisArtifacts,
  columnValues,
  formatAuditReport,
  leakedSecrets,
  parseCopySections,
  unescapePgValue,
} from '../src/utils/dumpAudit.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const SEAL_ALICE = 'c2VhbGVkLWJ5dGVzLWZvci1hbGljZQ';
const SEAL_MSG = 'c2VhbGVkLWJ5dGVzLWZvci1tZXNzYWdl';
const HASH = 'a'.repeat(64);

/** Dump "bersih": semua identitas sudah ter-seal/tag/hash. */
const CLEAN_DUMP = `--
-- PostgreSQL database dump
--

COPY public."User" (id, "externalIdSealed") FROM stdin;
${ALICE}\t${SEAL_ALICE}
${BOB}\t\\N
\\.

COPY public."Device" (id, "userId", name, "nameSealed", "installationTag") FROM stdin;
dev-1\t${ALICE}\tChrome on macOS\t${SEAL_ALICE}\tdeadbeef
\\.

COPY public."Conversation" (id, "authSecret") FROM stdin;
conv-1\t${HASH}
\\.

COPY public."Message" (id, "conversationId", "senderId", replied_to_id, "deleteSecret") FROM stdin;
${MSG}\tconv-1\t\\N\t\t${HASH}
\\.

COPY public."MessageStatus" (id, "messageId", "userId", status) FROM stdin;
st-1\t${MSG}\t${HASH}\tREAD
\\.

COPY public."UserHiddenConversation" (id, "userId", "conversationId", "tokenHash", "tokenEpoch", "expiresAt") FROM stdin;
m-1\t${SEAL_ALICE}\tconv-1\t${HASH}\t0\t2026-01-01T00:00:00Z
\\.

COPY public."Story" (id, "authorTag") FROM stdin;
story-1\t${SEAL_ALICE}
\\.

COPY public."BlockedUser" (id, "blockerTag", "blockedTag") FROM stdin;
blk-1\t${SEAL_ALICE}\t${SEAL_MSG}
\\.

COPY public."PushSubscription" (id, "endpointSealed") FROM stdin;
push-1\t${SEAL_MSG}
\\.
`;

/** Dump "bocor": regresi D2/D4/D10 mengembalikan identitas apa adanya. */
const LEAKY_DUMP = CLEAN_DUMP
  .replace(`st-1\t${MSG}\t${HASH}`, `st-1\t${MSG}\t${ALICE}`)
  .replace(`m-1\t${SEAL_ALICE}`, `m-1\t${ALICE}`)
  .replace(`${MSG}\tconv-1\t\\N`, `${MSG}\tconv-1\t${BOB}`)
  .replace(`conv-1\t${HASH}`, `conv-1\tplaintext-auth-secret`);

const CTX = {
  userIds: [ALICE, BOB],
  messageIds: [MSG],
  deviceNames: ['Chrome on macOS'],
  externalIds: [],
  pushEndpoints: ['https://fcm.googleapis.com/send/abc'],
};

test('parseCopySections: baca tabel, kolom (tanpa kutip), baris & NULL', () => {
  const sections = parseCopySections(CLEAN_DUMP);
  const tables = sections.map((s) => s.table).sort();
  assert.deepEqual(tables, [
    'BlockedUser',
    'Conversation',
    'Device',
    'Message',
    'MessageStatus',
    'PushSubscription',
    'Story',
    'User',
    'UserHiddenConversation',
  ]);

  const device = sections.find((s) => s.table === 'Device')!;
  assert.deepEqual(device.columns, ['id', 'userId', 'name', 'nameSealed', 'installationTag']);
  assert.equal(device.rows.length, 1);
  assert.equal(device.rows[0]![3], SEAL_ALICE);
});

test('unescapePgValue: NULL sentinel + escape TAB/backslash', () => {
  assert.equal(unescapePgValue('\\N'), '\0NULL\0');
  assert.equal(unescapePgValue('a\\tb'), 'a\tb');
  assert.equal(unescapePgValue('a\\\\b'), 'a\\b');
  assert.equal(unescapePgValue('plain'), 'plain');
});

test('columnValues: lewati NULL, ambil nilai kolom yang ada', () => {
  const sections = parseCopySections(CLEAN_DUMP);
  assert.deepEqual(columnValues(sections, 'User', 'externalIdSealed'), [SEAL_ALICE], 'NULL di-skip');
  assert.deepEqual(columnValues(sections, 'Nope', 'id'), [], 'tabel tak ada → kosong');
  assert.deepEqual(columnValues(sections, 'User', 'missing'), [], 'kolom tak ada → kosong');
});

test('audit dump BERSIH → LULUS (tidak ada false positive)', () => {
  const findings = auditDumpForIdentityLeaks(CLEAN_DUMP, CTX);
  assert.equal(auditPassed(findings), true, formatAuditReport(findings));
  // 11 kolom identitas + 2 rahasia otoritas.
  assert.equal(findings.length, 13);
});

test('audit dump BOCOR → GAGAL, tepat pada kolom yang bocor', () => {
  const findings = auditDumpForIdentityLeaks(LEAKY_DUMP, CTX);
  assert.equal(auditPassed(findings), false);

  const failed = findings.filter((f) => !f.ok).map((f) => f.rule).sort();
  assert.deepEqual(failed, [
    'Conversation.authSecret-hashed', // plaintext-auth-secret
    'Message.senderId',               // BOB apa adanya
    'MessageStatus.userId',           // ALICE apa adanya
    'UserHiddenConversation.userId',  // ALICE apa adanya
  ]);
});

test('audit reply edge: replied_to_id ter-seal, bukan id pesan asli', () => {
  const dump = CLEAN_DUMP.replace(`\\N\t\t${HASH}`, `\\N\t${MSG}\t${HASH}`);
  const findings = auditDumpForIdentityLeaks(dump, CTX);
  const reply = findings.find((f) => f.rule === 'Message.replied_to_id')!;
  assert.equal(reply.ok, false, 'id pesan asli di reply edge harus ditangkap');
});

// REGRESI (dump nyata 2026-10-09): tabel KOSONG menelan blok tabel berikutnya,
// sehingga kolom di tabel itu tidak pernah diaudit dan laporan tetap hijau.
test('parseCopySections: tabel KOSONG tidak menelan tabel berikutnya', () => {
  const dump = `COPY public."Empty" (id) FROM stdin;
\\.

COPY public."MessageStatus" (id, "userId") FROM stdin;
st-1\t${ALICE}
\\.

COPY public."AlsoEmpty" (id) FROM stdin;
\\.

COPY public."User" (id) FROM stdin;
u-1
\\.
`;
  const sections = parseCopySections(dump);
  assert.deepEqual(sections.map((s) => `${s.table}:${s.rows.length}`), [
    'Empty:0',
    'MessageStatus:1',
    'AlsoEmpty:0',
    'User:1',
  ]);
  assert.deepEqual(columnValues(sections, 'MessageStatus', 'userId'), [ALICE]);
});

test('audit: kebocoran SETELAH tabel kosong tetap ditangkap', () => {
  const dump = `COPY public."Empty" (id) FROM stdin;
\\.

COPY public."Message" (id, "conversationId", "senderId", replied_to_id, "deleteSecret") FROM stdin;
m-1\tconv-1\t${BOB}\t\\N\t${HASH}
\\.
`;
  const findings = auditDumpForIdentityLeaks(dump, CTX);
  const sender = findings.find((f) => f.rule === 'Message.senderId')!;
  assert.equal(sender.ok, false, 'userId asli di Message.senderId harus GAGAL walau ada tabel kosong sebelumnya');
});

test('audit anti-vakum: kolom target tidak ada di dump → GAGAL, bukan hijau', () => {
  const findings = auditDumpForIdentityLeaks(CLEAN_DUMP, CTX);
  const vacuous = findings.filter((f) => !f.ok);
  assert.deepEqual(vacuous, [], 'dump bersih tidak boleh punya finding gagal');

  // Dump tanpa tabel Story/BlockedUser: kolomnya tidak bisa diverifikasi.
  const partial = CLEAN_DUMP
    .split('\n\n')
    .filter((block) => !block.includes('COPY public."Story"') && !block.includes('COPY public."BlockedUser"'))
    .join('\n\n');
  const partialFindings = auditDumpForIdentityLeaks(partial, CTX);
  assert.equal(auditPassed(partialFindings), false);
  assert.deepEqual(
    partialFindings.filter((f) => !f.ok).map((f) => f.rule).sort(),
    ['BlockedUser.blockedTag', 'BlockedUser.blockerTag', 'Story.authorTag']
  );
});

test('audit parse gagal → finding dump-parseable GAGAL (bukan diam-diam lolos)', () => {
  const findings = auditDumpForIdentityLeaks('-- hanya komentar, tanpa COPY\n', CTX);
  assert.equal(auditPassed(findings), false);
  assert.equal(findings[0]!.rule, 'dump-parseable');
});

test('leakedSecrets: hanya nilai yang cocok, tanpa duplikasi palsu', () => {
  const sections = parseCopySections(LEAKY_DUMP);
  assert.deepEqual(leakedSecrets(sections, 'MessageStatus', 'userId', [ALICE, BOB]), [ALICE]);
  assert.deepEqual(leakedSecrets(sections, 'Story', 'authorTag', [ALICE]), [], 'authorTag ter-seal aman');
  assert.deepEqual(leakedSecrets(sections, 'Story', 'authorTag', []), [], 'tanpa rahasia → tidak ada klaim');
});

test('auditRedisArtifacts: key & member SET tidak boleh memuat userId', () => {
  const clean = auditRedisArtifacts(
    [`active_device:${'f'.repeat(64)}`, 'online_users'],
    ['f'.repeat(64), 'deadbeef'],
    [ALICE]
  );
  assert.equal(auditPassed(clean), true, formatAuditReport(clean));

  const leaky = auditRedisArtifacts(
    [`active_device:${ALICE}`, 'linking_token:x'],
    [ALICE, 'tag-1'],
    [ALICE]
  );
  assert.equal(auditPassed(leaky), false);
  assert.deepEqual(leaky.filter((f) => !f.ok).map((f) => f.rule), ['redis.key-names', 'redis.set-members']);
});
