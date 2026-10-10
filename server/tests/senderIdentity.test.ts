// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 4] Identitas pengirim & field at-rest lain — kontrak privasi.
 *
 * Latar: audit dump 2026-10-09 menemukan `Message.senderId` berisi **userId
 * asli** pada 6 pesan grup (jalur fallback `senderPseudonym ?? userId`), blob
 * metadata v2 memuat `senderId` penulis, dan 19 pesan SYSTEM menyimpan
 * `targetDeviceKey` (Device.id) apa adanya. Semua ditutup di sini; test ini
 * mengunci perilaku + jalur wiring-nya supaya tidak kembali.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { clearAtRestSecretCacheForTests, openAtRest, sealAtRest } from '../src/utils/atRestSecrets.js';
import {
  isUsableSenderPseudonym,
  openMessageForClient,
  openSenderId,
  openSystemContentDeviceKeys,
  sealSystemContentDeviceKeys,
  senderIdForStorage,
} from '../src/utils/senderIdentity.js';
import { sanitizeGroupMetadataBlob } from '../src/utils/groupMetadataBlob.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

before(() => {
  process.env.NYX_AT_REST_PEPPER = 'test-pepper-tier4-sender-identity';
  clearAtRestSecretCacheForTests();
});

const USER_ID = '3a11517c-dcb2-4a91-8af2-47667b52121b';
const OTHER_ID = '451b0e0a-aad7-4579-9442-6fe954513ecb';
const PSEUDONYM = 'BK8geEuQewyx1aSEzEbVtA';
const DEVICE_ID = '26d49b76-e7da-44cc-8a63-cf6de6b69d8b';

// ---------------------------------------------------------------------------
// senderId: penyimpanan
// ---------------------------------------------------------------------------

test('1:1 tetap NULL (sealed sender) walaupun klien mengirim pseudonym', async () => {
  assert.equal(await senderIdForStorage({ isGroup: false, userId: USER_ID, senderPseudonym: PSEUDONYM }), null);
  assert.equal(await senderIdForStorage({ isGroup: false, userId: USER_ID }), null);
});

test('grup: pseudonym valid disimpan apa adanya (byte-identik)', async () => {
  const stored = await senderIdForStorage({ isGroup: true, userId: USER_ID, senderPseudonym: PSEUDONYM });
  assert.equal(stored, PSEUDONYM);
});

test('grup tanpa pseudonym → userId TER-SEAL (dump tidak memuat identitas)', async () => {
  const stored = await senderIdForStorage({ isGroup: true, userId: USER_ID });
  assert.ok(stored && stored !== USER_ID, 'userId asli TIDAK boleh tersimpan');
  assert.doesNotMatch(stored!, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'bukan bentuk UUID');
  assert.equal(stored, await senderIdForStorage({ isGroup: true, userId: USER_ID }), 'deterministik (lookup/upsert idempoten)');
  assert.equal(await openSenderId(stored), USER_ID, 'server tetap bisa membukanya untuk routing');
});

test('grup: klien lama yang mengirim userId mentah tidak diizinkan tersimpan apa adanya', async () => {
  const fromLegacyClient = await senderIdForStorage({ isGroup: true, userId: USER_ID, senderPseudonym: USER_ID });
  assert.notEqual(fromLegacyClient, USER_ID);
  assert.equal(await openSenderId(fromLegacyClient), USER_ID);

  // UUID milik ORANG LAIN pun ditolak (tidak boleh jadi kanal spoof/petunjuk identitas).
  const spoofed = await senderIdForStorage({ isGroup: true, userId: USER_ID, senderPseudonym: OTHER_ID });
  assert.notEqual(spoofed, OTHER_ID);
  assert.equal(await openSenderId(spoofed), USER_ID, 'yang tersimpan adalah identitas PENGIRIM yang terautentikasi');
});

test('isUsableSenderPseudonym: bentuk yang diterima vs ditolak', () => {
  assert.equal(isUsableSenderPseudonym(PSEUDONYM, USER_ID), true);
  assert.equal(isUsableSenderPseudonym('  ' + PSEUDONYM + '  ', USER_ID), true);
  assert.equal(isUsableSenderPseudonym(USER_ID, USER_ID), false, 'userId sendiri');
  assert.equal(isUsableSenderPseudonym(OTHER_ID, USER_ID), false, 'bentuk UUID');
  assert.equal(isUsableSenderPseudonym('', USER_ID), false);
  assert.equal(isUsableSenderPseudonym(undefined, USER_ID), false);
  assert.equal(isUsableSenderPseudonym('x'.repeat(129), USER_ID), false);
});

test('openSenderId: baris legacy (plaintext) & kosong tetap terbaca', async () => {
  assert.equal(await openSenderId(null), null);
  assert.equal(await openSenderId(undefined), null);
  assert.equal(await openSenderId(PSEUDONYM), PSEUDONYM, 'pseudonym legacy apa adanya');
  assert.equal(await openSenderId(USER_ID), USER_ID, 'baris lama berisi userId tetap terbaca (migrasi mulus)');
});

// ---------------------------------------------------------------------------
// Device id di content pesan SYSTEM
// ---------------------------------------------------------------------------

test('SYSTEM GROUP_KEY: targetDeviceKey tersegel saat disimpan, dibuka saat dibaca', async () => {
  const content = JSON.stringify({
    type: 'GROUP_KEY',
    key: 'ciphertext-e2ee',
    senderDeviceKey: 'FO5JjSCgLeiAocFq6g0nq6pnU3mvnuughGuak45UrWY',
    senderSigningKey: 'signing-key-b64',
    targetDeviceKey: DEVICE_ID,
  });

  const sealed = await sealSystemContentDeviceKeys(content);
  assert.ok(!sealed.includes(DEVICE_ID), 'Device.id tidak boleh terbaca dari baris tersimpan');
  const parsedStored = JSON.parse(sealed) as Record<string, unknown>;
  assert.equal(parsedStored.type, 'GROUP_KEY', 'field lain tetap utuh');
  assert.equal(parsedStored.senderDeviceKey, 'FO5JjSCgLeiAocFq6g0nq6pnU3mvnuughGuak45UrWY', 'kunci PUBLIK tidak di-seal');
  assert.equal(parsedStored.key, 'ciphertext-e2ee');

  const opened = JSON.parse(await openSystemContentDeviceKeys(sealed)) as Record<string, unknown>;
  assert.equal(opened.targetDeviceKey, DEVICE_ID, 'klien menerima nilai yang sama seperti sebelumnya');
});

test('content non-JSON / tanpa targetDeviceKey tidak disentuh (byte-identik)', async () => {
  const e2ee = 'aGVsbG8td29ybGQtY2lwaGVydGV4dA';
  assert.equal(await sealSystemContentDeviceKeys(e2ee), e2ee);
  assert.equal(await openSystemContentDeviceKeys(e2ee), e2ee);

  const other = JSON.stringify({ type: 'METADATA_UPDATED', encryptedMetadata: '{"v":2}' });
  assert.equal(await sealSystemContentDeviceKeys(other), other);
});

// ---------------------------------------------------------------------------
// Baris pesan → klien
// ---------------------------------------------------------------------------

test('openMessageForClient: senderId + sessionId + device key dibuka sekaligus', async () => {
  const row = {
    id: 'msg-1',
    senderId: await senderIdForStorage({ isGroup: true, userId: USER_ID }),
    sessionId: await sealAtRest('sess-1'),
    content: await sealSystemContentDeviceKeys(JSON.stringify({ type: 'GROUP_KEY', key: 'k', targetDeviceKey: DEVICE_ID })),
    createdAt: new Date(),
  };
  const opened = await openMessageForClient(row);
  assert.equal(opened.senderId, USER_ID);
  assert.equal(opened.sessionId, 'sess-1');
  assert.equal((JSON.parse(opened.content!) as { targetDeviceKey: string }).targetDeviceKey, DEVICE_ID);
  assert.equal(opened.id, 'msg-1', 'field lain dipertahankan');
});

test('openMessageForClient: baris 1:1/legacy tidak berubah bentuk', async () => {
  const row = { id: 'msg-2', senderId: null, sessionId: null, content: 'opaque-ciphertext' };
  const opened = await openMessageForClient(row);
  assert.deepEqual(opened, row);
});

// ---------------------------------------------------------------------------
// Blob metadata grup
// ---------------------------------------------------------------------------

test('sanitize: wrapper metadata v2 kehilangan senderId, sisanya utuh', () => {
  const blob = JSON.stringify({
    v: 2,
    kind: 'group_metadata',
    chainId: 'WZCoXa8Wfdw',
    ct: 'ciphertext',
    signature: 'sig',
    senderId: USER_ID,
    senderDeviceKey: 'FO5JjSCgLeiAocFq6g0nq6pnU3mvnuughGuak45UrWY',
  });
  const clean = sanitizeGroupMetadataBlob(blob)!;
  assert.ok(!clean.includes('senderId'), 'field senderId dibuang');
  assert.ok(!clean.includes(USER_ID), 'userId penulis dibuang');
  const parsed = JSON.parse(clean) as Record<string, unknown>;
  assert.equal(parsed.chainId, 'WZCoXa8Wfdw');
  assert.equal(parsed.ct, 'ciphertext');
  assert.equal(parsed.signature, 'sig');
  assert.equal(parsed.senderDeviceKey, 'FO5JjSCgLeiAocFq6g0nq6pnU3mvnuughGuak45UrWY', 'routing device key WAJIB tetap ada');
  assert.equal(parsed.v, 2);
});

test('sanitize: blob v1 (legacy rantai) TIDAK disentuh — readernya butuh senderId', () => {
  const v1 = JSON.stringify({ header: { n: 0 }, ciphertext: 'ct', signature: 'sig', senderId: USER_ID, senderDeviceKey: 'dev-key' });
  assert.equal(sanitizeGroupMetadataBlob(v1), v1);
});

test('sanitize: non-JSON, null, dan blob tanpa senderId dikembalikan apa adanya', () => {
  assert.equal(sanitizeGroupMetadataBlob(null), null);
  assert.equal(sanitizeGroupMetadataBlob(undefined), undefined);
  assert.equal(sanitizeGroupMetadataBlob('opaque-client-blob'), 'opaque-client-blob');
  const withoutSender = JSON.stringify({ v: 2, kind: 'group_metadata', chainId: 'c', ct: 'x', signature: 's' });
  assert.equal(sanitizeGroupMetadataBlob(withoutSender), withoutSender);
});

test('sanitize: idempoten (blob yang sudah bersih tetap sama)', () => {
  const blob = JSON.stringify({ v: 2, kind: 'group_metadata', chainId: 'c', ct: 'x', senderId: USER_ID });
  const once = sanitizeGroupMetadataBlob(blob)!;
  assert.equal(sanitizeGroupMetadataBlob(once), once);
});

// ---------------------------------------------------------------------------
// Wiring: jalur tulis nyata + key Redis + bucket waktu
// ---------------------------------------------------------------------------

test('wiring: realtimeHandlers tidak menyimpan userId mentah ke kolom senderId', () => {
  const src = read('../src/network/realtimeHandlers.ts');
  assert.match(src, /senderIdForStorage\(/, 'penyimpanan wajib lewat helper');
  // 3 jalur tulis (pesan, GROUP_KEY, METADATA_UPDATED) — semuanya lewat helper.
  assert.equal((src.match(/senderIdForStorage\(/g) || []).length, 3);
  // Tidak ada lagi objek `data:` (yang di-persist) yang menulis fallback userId
  // mentah; satu-satunya sisa adalah payload in-flight distribusi kunci.
  const storedFallbacks = src.match(/senderId: senderPseudonym \?\? userId/g) || [];
  assert.equal(storedFallbacks.length, 1, 'sisa fallback userId hanya boleh payload in-flight');
  assert.match(src, /emitPayload: Record<string, unknown> = \{ conversationId, encryptedKey, type: 'GROUP_KEY', senderId: senderPseudonym \?\? userId/);
  assert.ok(!/data: \{[\s\S]{0,400}?senderId: senderPseudonym \?\? userId/.test(src), 'blok data Prisma tidak boleh memakai fallback userId');
  assert.match(src, /openSenderId\(/, 'jalur baca membuka nilai ter-seal');
  assert.match(src, /sealSystemContentDeviceKeys\(/, 'device id SYSTEM disegel');
  assert.match(src, /sanitizeGroupMetadataBlob\(/, 'blob metadata disanitasi');
});

test('wiring: routes/messages menyegel sessionId dan membukanya saat read', () => {
  const src = read('../src/routes/messages.ts');
  assert.match(src, /sessionId: sessionId \? await sealAtRest\(sessionId\) : null/);
  assert.equal((src.match(/openMessageForClient\(/g) || []).length, 2, 'read list + respons POST');
});

test('wiring: routes/conversations menyimpan metadata tersanitasi & createdAt kasar', () => {
  const src = read('../src/routes/conversations.ts');
  assert.match(src, /encryptedMetadata: isGroup \? sanitizeGroupMetadataBlob\(encryptedMetadata\) : null/);
  assert.match(src, /data: \{ encryptedMetadata: sanitizedMetadata \}/);
  assert.match(src, /createdAt: messageTimeBucket\(\)/);
  assert.ok(!/sandbox:newchat:\$\{creatorId\}/.test(src), 'key Redis sandbox tidak menyematkan userId');
  assert.match(src, /sandbox:newchat:\$\{identityTag\(creatorId\)\}/);
});

test('wiring: key Redis rate-limit/kontak/story/powverify memakai tag, bukan userId', () => {
  const files: Array<[string, RegExp]> = [
    ['../src/routes/users.ts', /rl:contact-bundle:\$\{identityTag\(req\.user\.id\)\}/],
    ['../src/routes/stories.ts', /rl:story-view:\$\{identityTag\(requesterId\)\}:\$\{identityTag\(targetId\)\}/],
    ['../src/routes/auth.ts', /rl:powverify:\$\{identityTag\(userId\)\}/],
    ['../src/utils/otpkQuota.ts', /otpkq:\$\{identityTag\(requesterId\)\}:\$\{identityTag\(targetId\)\}/],
  ];
  for (const [file, pattern] of files) {
    assert.match(read(file), pattern, `${file} harus memakai identityTag`);
  }
});

test('wiring: tidak ada key Redis yang menyematkan userId mentah pada keluarga yang diaudit', () => {
  const sources = [
    read('../src/routes/users.ts'),
    read('../src/routes/stories.ts'),
    read('../src/routes/auth.ts'),
    read('../src/utils/otpkQuota.ts'),
    read('../src/routes/conversations.ts'),
  ].join('\n');
  for (const banned of [
    /`?rl:contact-bundle:\$\{\s*(req\.user\.id|userId|requesterId)/,
    /rl:story-view:\$\{\s*requesterId/,
    /rl:powverify:\$\{\s*userId/,
    /otpkq:\$\{\s*requesterId/,
    /sandbox:newchat:\$\{\s*creatorId/,
  ]) {
    assert.ok(!banned.test(sources), `pola key lama masih ada: ${banned}`);
  }
});

test('legacy: nilai ter-seal deterministik (pepper sama → nilai sama, pepper beda → beda)', async () => {
  const a = await senderIdForStorage({ isGroup: true, userId: USER_ID });
  const b = await senderIdForStorage({ isGroup: true, userId: USER_ID });
  assert.equal(a, b);
  assert.equal(await openAtRest(a), USER_ID);
});
