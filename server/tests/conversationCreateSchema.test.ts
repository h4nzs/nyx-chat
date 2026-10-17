// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Skema pembuatan percakapan (`POST /api/conversations`) — unit tests.
 *
 * Regresi nyata (produksi 2026-10-16): route memakai skema lokal tanpa
 * `.passthrough()`, dan `zodValidate` mengganti `req.body` dengan hasil parse.
 * `adminSecretHash` tidak terdaftar di skema → dibuang zod → handler selalu
 * melihat `undefined` → SETIAP pembuatan grup dijawab
 * `400 adminSecretHash required for groups`, walau klien mengirimnya
 * (`web/src/store/conversation.ts#createGroup`).
 *
 * Yang dikunci di sini adalah PERILAKU skema (bukan teks sumber): key yang
 * dibaca handler harus selamat dari parse. Ditambah wiring route → modul
 * supaya definisi skema tidak bisa kembali ditulis inline tanpa uji.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createConversationBodySchema } from '../src/utils/conversationSchemas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

const PEER = '11111111-1111-1111-1111-111111111111';
const DELIVERY_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22-char base64url
const ADMIN_HASH = 'a'.repeat(64); // SHA-256 hex dari capability token

// Body yang PERSIS dikirim klien pada createGroup (lihat
// web/src/store/conversation.ts: userIds, isGroup, encryptedMetadata: null,
// deliveryTokens, adminSecretHash).
const clientBody = {
  userIds: [PEER],
  isGroup: true,
  encryptedMetadata: null,
  deliveryTokens: { [PEER]: DELIVERY_TOKEN },
  adminSecretHash: ADMIN_HASH,
};

test('POST /conversations: adminSecretHash SELAMAT dari parse (regresi strip zod)', () => {
  const parsed = createConversationBodySchema.parse(clientBody) as Record<string, unknown>;
  assert.equal(parsed.adminSecretHash, ADMIN_HASH,
    'adminSecretHash harus sampai ke handler — zod membuang key yang tidak terdaftar di skema');
});

test('POST /conversations: semua key yang dibaca handler terdaftar di skema', () => {
  const parsed = createConversationBodySchema.parse(clientBody) as Record<string, unknown>;
  for (const key of ['userIds', 'isGroup', 'encryptedMetadata', 'deliveryTokens', 'adminSecretHash']) {
    assert.ok(key in parsed, `${key} hilang setelah parse (handler membacanya dari req.body)`);
  }
  assert.equal(parsed.encryptedMetadata, null, 'null (grup tanpa metadata awal) dipertahankan');
});

test('POST /conversations: permintaan tanpa adminSecretHash tetap lolos skema', () => {
  // Pesan "adminSecretHash required for groups" harus tetap datang dari handler
  // (spesifik untuk grup), bukan dari zod.
  const parsed = createConversationBodySchema.parse({
    userIds: [PEER],
    isGroup: true,
    encryptedMetadata: null,
  }) as Record<string, unknown>;
  assert.equal(parsed.adminSecretHash, undefined);
  assert.equal(parsed.isGroup, true);

  // 1:1 (isGroup absent) juga tetap valid tanpa hash.
  const direct = createConversationBodySchema.parse({ userIds: [PEER] }) as Record<string, unknown>;
  assert.deepEqual(direct.userIds, [PEER]);
});

test('POST /conversations: key asing & payload tidak sah tetap ditolak/dibuang', () => {
  const parsed = createConversationBodySchema.parse({
    ...clientBody,
    adminSecret: ADMIN_HASH, // nama salah — tidak boleh ikut masuk
  }) as Record<string, unknown>;
  assert.ok(!('adminSecret' in parsed), 'key tak dikenal dibuang (skema bukan passthrough)');

  assert.throws(() => createConversationBodySchema.parse({ ...clientBody, userIds: [] }),
    'userIds kosong ditolak');
  assert.throws(() => createConversationBodySchema.parse({
    ...clientBody,
    deliveryTokens: { [PEER]: 'short' },
  }), 'token undangan bukan 22-char base64url ditolak');
  assert.throws(() => createConversationBodySchema.parse({
    ...clientBody,
    deliveryTokens: { [PEER]: 123 },
  }), 'nilai token non-string ditolak');
});

test('POST /conversations: route memakai skema bersama (wiring teruji)', () => {
  const src = read('../src/routes/conversations.ts');
  assert.match(src, /zodValidate\(\{\s*body:\s*createConversationBodySchema\s*\}\)/,
    'route memakai createConversationBodySchema, bukan definisi inline');
  assert.match(src, /req\.body\.adminSecretHash/,
    'handler masih membaca adminSecretHash dari req.body (pasangan skema↔handler)');
  assert.doesNotMatch(src, /const ConversationSchema = z\.object/,
    'skema lokal non-passthrough tidak boleh kembali ke route');
});
