// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §7.1] Gating & binding credential keanggotaan grup (blind RSA).
 *
 * Temuan: `POST /credential-issuance` dulu menandatangani blinded message APA
 * PUN untuk user terautentikasi mana pun yang mengetahui UUID conversation, dan
 * presentasi hanya mencocokkan serial↔conversation (tanpa binding konteks).
 * Akibatnya akun luar bisa menerbitkan credential untuk grup yang bukan
 * miliknya dan memasukkannya ke `/sync` (daftar percakapan + metadata bocor).
 *
 * Test ini mengunci janji perbaikannya:
 *   1. issuance/commit WAJIB punya bukti keanggotaan (token-first, tanpa join
 *      userId) — authSecret grup ATAU delivery token milik pemanggil;
 *   2. commit dibatasi tiket issuance (tidak bisa menyuntik serial tanpa batas);
 *   3. kunci Redis kuota tidak lagi memuat userId asli (`identityTag`);
 *   4. pesan yang ditandatangani terikat conversationId, dan binding itu
 *      diambil dari `preparedMsg` yang dipresentasikan (offset prefix acak
 *      suite — diverifikasi terhadap library asli, bukan asumsi).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RSABSSA } from '@cloudflare/blindrsa-ts';

import {
  buildCredentialMessage,
  credentialClaimFromPrepared,
  parseCredentialMessage,
  CREDENTIAL_PREPARE_PREFIX_BYTES,
} from '@nyx/shared';
import {
  CREDENTIAL_ISSUANCE_DAILY_MAX,
  commitAllowed,
  credentialCommitKey,
  credentialDay,
  credentialDays,
  credentialIssuanceKey,
  exceedsIssuanceQuota,
} from '../src/utils/credentialIssuance.js';
import { identityTag } from '../src/utils/redisIdentity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

const CONV = '11111111-2222-4333-8444-555555555555';
const USER = 'user-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NONCE = 'a'.repeat(32);

test('29 §7.1: kunci kuota memakai identityTag — userId asli tidak masuk Redis', () => {
  const key = credentialIssuanceKey(USER, CONV, '2026-10-11');
  assert.equal(key, `cred:issue:${identityTag(USER)}:${CONV}:2026-10-11`);
  assert.ok(!key.includes(USER), 'key tidak boleh memuat userId mentah');
  assert.equal(key, credentialIssuanceKey(USER, CONV, '2026-10-11'), 'deterministik (counter idempoten)');
  assert.notEqual(key, credentialIssuanceKey('user-lain', CONV, '2026-10-11'));

  const commitKey = credentialCommitKey(USER, CONV, '2026-10-11');
  assert.ok(commitKey.startsWith('cred:commit:'), 'kunci commit terpisah dari issuance');
  assert.ok(!commitKey.includes(USER));
});

test('29 §7.1: kuota issuance 3/hari, NaN fail-open (infra error tidak memblokir)', () => {
  assert.equal(CREDENTIAL_ISSUANCE_DAILY_MAX, 3);
  assert.equal(exceedsIssuanceQuota(1), false);
  assert.equal(exceedsIssuanceQuota(3), false);
  assert.equal(exceedsIssuanceQuota(4), true);
  assert.equal(exceedsIssuanceQuota(Number.NaN), false);
});

test('29 §7.1: commit ditolak tanpa tiket issuance, dan tidak melebihi jumlah issuance', () => {
  assert.equal(commitAllowed(1, 0), false, 'tanpa issuance = tidak ada tiket → tolak');
  assert.equal(commitAllowed(1, 1), true);
  assert.equal(commitAllowed(2, 2), true);
  assert.equal(commitAllowed(3, 2), false, 'commit > issuance = penyuntikan serial');
});

test('29 §7.1: hari kuota mencakup kemarin (grace issuance 23:59 → commit 00:01)', () => {
  const days = credentialDays(new Date('2026-10-11T00:05:00.000Z'));
  assert.deepEqual(days, ['2026-10-11', '2026-10-10']);
  assert.equal(credentialDay(new Date('2026-10-11T23:59:59.999Z')), '2026-10-11');
});

test('29 §7.1: format pesan credential — roundtrip build/parse, nonce divalidasi', () => {
  const msg = buildCredentialMessage(CONV, NONCE);
  assert.equal(msg, `nyx-grp-cred:v1:${CONV}:${NONCE}`);
  assert.deepEqual(parseCredentialMessage(msg), { conversationId: CONV, nonce: NONCE });

  assert.equal(parseCredentialMessage('nyx-grp-cred:v1:conv:zz'), null, 'nonce non-hex ditolak');
  assert.equal(parseCredentialMessage('nyx-grp-cred:v1:conv'), null, 'tanpa nonce ditolak');
  assert.equal(parseCredentialMessage('pesan-bebas'), null);
  assert.throws(() => buildCredentialMessage(CONV, 'x'), /nonce/);
});

test('29 §7.1: binding diambil dari preparedMsg (offset prefix acak suite asli)', async () => {
  const suite = RSABSSA.SHA384.PSS.Randomized();
  const msg = buildCredentialMessage(CONV, NONCE);
  const prepared = suite.prepare(new TextEncoder().encode(msg)) as Uint8Array;

  // Kontrak RSABSSA-...-Randomized: prepared = prefix acak (32B) || pesan asli.
  assert.equal(prepared.length, CREDENTIAL_PREPARE_PREFIX_BYTES + msg.length,
    'panjang prefix suite harus sesuai konstanta binding');
  assert.equal(
    new TextDecoder().decode(prepared.subarray(CREDENTIAL_PREPARE_PREFIX_BYTES)),
    msg,
    'body pesan mulai tepat di offset prefix — kalau suite berubah, test ini gagal'
  );
  assert.deepEqual(credentialClaimFromPrepared(prepared), { conversationId: CONV });
  assert.notEqual(credentialClaimFromPrepared(prepared)?.conversationId, 'conv-lain',
    'klaim terikat conversation pembuat pesan');

  // Pesan asing / terlalu pendek tidak boleh menghasilkan klaim.
  assert.equal(credentialClaimFromPrepared(new Uint8Array(4)), null);
  assert.equal(credentialClaimFromPrepared(suite.prepare(new TextEncoder().encode('halo')) as Uint8Array), null);
});

test('29 §7.1: verifyPresentation menolak presentasi tanpa binding conversation', () => {
  const lib = read('../src/lib/groupCredentials.ts');
  assert.match(lib, /credentialClaimFromPrepared\(preparedMsg\)/, 'klaim dibaca dari preparedMsg');
  assert.match(lib, /claim\.conversationId !== conversationId/, 'conversation yang diklaim harus cocok');
  // [docs/35 §35.6.6 — Fase 5] Import kini berbentuk multi-baris (suite ID ikut);
  // yang dikunci adalah sumbernya, bukan tata letak import.
  assert.match(lib, /from '@nyx\/shared'/,
    'format dibagi lewat @nyx/shared, bukan string duplikat');
  assert.match(lib, /credentialClaimFromPrepared,/,
    'helper klaim tetap diimpor dari @nyx/shared');
});

test('29 §7.1: route issuance/commit memerlukan bukti keanggotaan + tiket', () => {
  const src = read('../src/routes/conversations.ts');
  // [docs/30 WS-G] Keputusan otorisasi kini diuji sebagai PERILAKU dengan klien
  // Prisma palsu (tests/credentialAuth.test.ts: tanpa bukti → tolak, token grup
  // salah → tolak, token undangan lintas-conversation → tolak, dedup + batas
  // token). Yang dikunci di sini tinggal WIRING-nya: route harus memakai modul
  // itu, bukan implementasi lokal yang bisa menyimpang tanpa teruji.
  const auth = read('../src/utils/credentialAuth.ts');
  assert.match(src, /from '\.\.\/utils\/credentialAuth\.js'/, 'route memakai modul otorisasi teruji');
  assert.match(src, /authorizeCredentialIssuance\(authDb, conversationId/, 'helper otorisasi dipanggil dengan klien ter-inject');
  assert.equal((src.match(/MEMBERSHIP_PROOF_REQUIRED/g) ?? []).length, 2,
    'issuance DAN commit sama-sama menolak tanpa bukti keanggotaan');
  assert.match(auth, /credentialTokenMatches\(conversation\.authSecret, groupToken\)/,
    'bukti #1: authSecret grup (blind member auth)');
  assert.match(auth, /deliveryToken: \{ in: \[\.\.\.new Set\(tokens\)\]\.slice\(0, MAX_DELIVERY_TOKENS\) \}/,
    'bukti #2: delivery token milik pemanggil dicocokkan ke baris (conversationId, token), dibatasi konstanta');
  assert.doesNotMatch(src, /cred:issue:\$\{req\.user\.id\}/,
    'kunci Redis tidak boleh memuat userId asli (regresi docs/28 Tier 4)');
  assert.match(src, /credentialIssuanceKey\(req\.user\.id, conversationId, today!\)/,
    'kuota issuance lewat helper ber-tag');
  assert.match(src, /commitAllowed\(committed, issued\)/,
    'commit dibatasi tiket issuance (anti-spam serial arbitrer)');
  assert.match(src, /CREDENTIAL_COMMIT_WITHOUT_ISSUANCE/);
});

test('29 §7.1: klien mengirim bukti keanggotaan pada issuance & commit', () => {
  const client = read('../../web/src/lib/groupCredentials.ts');
  assert.match(client, /buildIssuanceHeaders/, 'header bukti dibangun sekali, dipakai dua kali');
  assert.match(client, /getMyGroupToken/, 'bukti authSecret dari metadata ter-dekripsi');
  assert.match(client, /getMyDeliveryToken/, 'bukti delivery token milik sendiri');
  assert.match(client, /'X-Group-Token'/, 'header authSecret dikirim');
  assert.match(client, /'X-Delivery-Tokens'/, 'header delivery token dikirim');
  assert.match(client, /buildCredentialMessage\(conversationId, hex\)/,
    'format pesan dari @nyx/shared (tidak lagi inline)');
  assert.doesNotMatch(client, /`nyx-grp-cred:v1:\$\{conversationId\}/,
    'format tidak boleh ditulis ulang sebagai string lokal');

  assert.match(client, /const commitHeaders = buildIssuanceHeaders\(conversationId\);/,
    'header bukti dibangun untuk commit');
  assert.match(client, /headers: Object\.keys\(proofHeaders\)\.length > 0 \? proofHeaders : undefined/,
    'issuance memakai header yang sudah dibangun');
  assert.match(client, /headers: Object\.keys\(commitHeaders\)\.length > 0 \? commitHeaders : undefined/,
    'commit memakai header yang sudah dibangun');
});

test('29 §7.1: discovery token-first tidak lagi melewatkan metadata v3', () => {
  const lib = read('../../web/src/lib/groupPseudonyms.ts');
  assert.match(lib, /meta\?\.v !== 2 && meta\?\.v !== 3/,
    'collectMyDeliveryTokens harus menerima v3 (satu-satunya bentuk yang masih ditulis)');
  assert.match(lib, /export function getMyGroupToken/, 'helper authSecret tersedia untuk issuance');
});
