// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * T3b delivery tokens (doc 26.2) — unit tests.
 *
 * Prisma REST handlers tidak mudah di-unit-test tanpa instance Express penuh,
 * jadi test ini mengunci KONTRAK di level source + Prisma schema:
 *   1. Schema: kolom `deliveryToken` additive (nullable, unique) + index
 *      `conversationId` ada — prasyarat dual-accept sync.
 *   2. Sync endpoint menerima header `X-Delivery-Tokens` dan mem-match via
 *      `deliveryToken in (...)` (token possession, bukan identity join).
 *   3. Dual-write: create/invite menyimpan token pada row yang sama dengan
 *      userId (transisi — jalur legacy tidak putus).
 *   4. Revocation: kick/leave menghapus row (token mati).
 *   5. Client token maps hidup di encrypted metadata v2 (deliveryTokenMap),
 *      bukan di field plaintext payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22-char base64url
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

test('T3b: schema UserHiddenConversation punya deliveryToken nullable unique + index conversationId', () => {
  const schema = read('../prisma/schema.prisma');
  const modelStart = schema.indexOf('model UserHiddenConversation');
  assert.ok(modelStart >= 0, 'model UserHiddenConversation harus ada');
  const model = schema.slice(modelStart, schema.indexOf('}', modelStart));

  assert.match(model, /deliveryToken\s+String\?\s+@unique/, 'deliveryToken nullable @unique (additive, legacy rows tanpa token)');
  assert.match(model, /@@index\(\[conversationId\]\)/, 'index conversationId untuk sync per-token lookup');
});

test('T3b: format token = 22-char base64url (16 random bytes), konsisten dengan shared schemas', () => {
  const schemas = read('../../packages/shared/src/schemas.ts');
  // zod 4: z.record(keySchema, valueSchema) — keduanya 22-char base64url.
  assert.match(schemas, /targetDeliveryTokens:\s*z\.record\(z\.string\(\)\.regex\(\/\^\[A-Za-z0-9_-]\{22\}\$\/\),\s*z\.string\(\)\.regex\(\/\^\[A-Za-z0-9_-]\{22\}\$\/\)\)/,
    'MessageSendPayloadSchema memvalidasi targetDeliveryTokens (key & value 22-char)');
  assert.ok(TOKEN_RE.test(TOKEN));
  assert.ok(!TOKEN_RE.test('short'), 'token terlalu pendek ditolak');
  assert.ok(!TOKEN_RE.test('contains+plus-and/slash0000'), 'karakter non-base64url ditolak');
});

test('T3b: sync endpoint dual-accept — header X-Delivery-Tokens di-match via deliveryToken in(...)', () => {
  const src = read('../src/routes/conversations.ts');
  assert.match(src, /x-delivery-tokens/i, 'sync membaca header X-Delivery-Tokens');
  assert.match(src, /deliveryToken:\s*\{\s*in:\s*tokens\s*\}/, 'lookup by token possession (unique index), bukan join userId');
  assert.match(src, /slice\(0,\s*500\)/, 'jumlah token per request di-cap 500 (anti amplifikasi)');
});

test('T3b: dual-write di semua titik invite (create, invite REST, chat relay WT & REST)', () => {
  const conversationsRoute = read('../src/routes/conversations.ts');
  const messagesRoute = read('../src/routes/messages.ts');
  const handlers = read('../src/network/realtimeHandlers.ts');

  // POST /conversations dan POST /:id/participants: create row dengan token
  assert.match(conversationsRoute, /deliveryTokens\?\.\[uid\] \?\? null/, 'create/invite: token disimpan saat create row');
  // Chat relay (WT + REST fallback): upsert dengan token
  assert.match(handlers, /targetDeliveryTokens\?\.\[targetId\] \?\? null/, 'WT relay: token pada create row');
  assert.match(messagesRoute, /targetDeliveryTokens\?\.\[targetId\] \?\? null/, 'REST relay: token pada create row');
});

test('T3b: revocation — kick/leave menghapus row token', () => {
  const src = read('../src/routes/conversations.ts');
  const matches = src.match(/userHiddenConversation\.delete\(/g) ?? [];
  assert.ok(matches.length >= 2, 'kick (DELETE participants) dan leave (/leave) keduanya menghapus row');
});

test('T3b: token maps HIDUP di encrypted metadata v2 — tidak ada plaintext delivery di payload publik', () => {
  const sharedTypes = read('../../packages/shared/src/types.ts');
  assert.match(sharedTypes, /deliveryTokenMap\?:\s*Record<string, string>/,
    'GroupMetadataV2.deliveryTokenMap (di dalam encrypted metadata)');

  const pseudonyms = read('../../web/src/lib/groupPseudonyms.ts');
  assert.match(pseudonyms, /getMyDeliveryToken/, 'client helper mengambil token milik sendiri dari peta');
  assert.match(pseudonyms, /collectMyDeliveryTokens/, 'client mengumpulkan semua token miliknya untuk sync header');
});

test('T3b: client sync mengirim X-Delivery-Tokens (transisi dual-path)', () => {
  const store = read('../../web/src/store/conversation.ts');
  assert.match(store, /X-Delivery-Tokens/, 'loadConversations mengirim header token');
  assert.match(store, /deliveryTokens/, 'createGroup mengirim creator-issued tokens');
});
