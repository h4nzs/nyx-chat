// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.1–§37.3.4] Kontrak token keanggotaan grup.
 *
 * Test ini mengunci hal-hal yang mudah "dikembalikan" tanpa sadar saat refactor:
 *   1. Schema: token mentah TIDAK ada kolomnya — hanya `tokenHash` (unique),
 *      `tokenEpoch`, `expiresAt`; `userId` tetap nullable routing-only.
 *   2. Token 256-bit (43-char base64url), sama di klien & schema payload.
 *   3. Sync anonim ada di `routes/groups.ts`, token di body, tanpa `requireAuth`
 *      dan tanpa menyentuh `userId`.
 *   4. Penyimpanan token di semua titik invite melewati `upsertMembership`
 *      (hash di dalam util).
 *   5. Revocation: kick menaikkan epoch + merotasi token grup + menghapus baris;
 *      leave menghapus baris.
 *   6. Klien tidak lagi memakai header `X-Delivery-Tokens`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

const TOKEN = 'A'.repeat(43); // 43-char base64url (256-bit)
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

test('schema: hanya hash token yang disimpan, plus epoch & expiry', () => {
  const schema = read('../prisma/schema.prisma');
  const modelStart = schema.indexOf('model UserHiddenConversation');
  assert.ok(modelStart >= 0, 'model UserHiddenConversation harus ada');
  const model = schema.slice(modelStart, schema.indexOf('}', modelStart));

  assert.match(model, /tokenHash\s+String\s+@unique/, 'tokenHash WAJIB & unique (lookup sync)');
  assert.match(model, /tokenEpoch\s+Int\s+@default\(0\)/, 'epoch per baris keanggotaan');
  assert.match(model, /expiresAt\s+DateTime/, 'TTL token anggota');
  assert.match(model, /userId\s+String\?/, 'userId nullable (routing-only, bukan discovery key)');
  assert.doesNotMatch(model, /deliveryToken/, 'token mentah tidak boleh punya kolom');
});

test('schema Conversation: epoch + expiry token grup', () => {
  const schema = read('../prisma/schema.prisma');
  const modelStart = schema.indexOf('model Conversation');
  const model = schema.slice(modelStart, schema.indexOf('model Message ', modelStart));
  assert.match(model, /groupEpoch\s+Int\s+@default\(0\)/);
  assert.match(model, /groupTokenExpiresAt\s+DateTime\?/);
  assert.match(model, /epochRotatedAt\s+DateTime\?/);
  assert.match(model, /authSecret\s+String\?/, 'authSecret = SHA-256 token grup (bukan token mentah)');
});

test('format token: 43-char base64url (256-bit), konsisten di shared & server schema', () => {
  const shared = read('../../packages/shared/src/schemas.ts');
  assert.match(
    shared,
    /targetDeliveryTokens:\s*z\.record\(z\.string\(\)\.min\(1\),\s*z\.string\(\)\.regex\(\/\^\[A-Za-z0-9_-\]\{43\}\$\/\)\)/,
    'MessageSendPayloadSchema memvalidasi token 43-char'
  );
  const schemes = read('../src/utils/conversationSchemas.ts');
  assert.match(schemes, /DELIVERY_TOKEN_RE = \/\^\[A-Za-z0-9_-\]\{43\}\$\//);
  assert.ok(TOKEN_RE.test(TOKEN));
  assert.ok(!TOKEN_RE.test('A'.repeat(22)), 'token 22-char (128-bit) lama ditolak');
});

test('sync anonim: token di body, tanpa requireAuth, tanpa userId', () => {
  const src = read('../src/routes/groups.ts');
  assert.match(src, /router\.post\('\/sync'/);
  assert.doesNotMatch(src, /requireAuth/, 'jalur sync tidak boleh memakai sesi');
  assert.doesNotMatch(src, /req\.user/, 'jalur sync tidak boleh membaca identitas akun');
  assert.doesNotMatch(src, /userHiddenConversation[\s\S]{0,200}userId/, 'sync tidak boleh query kolom userId');
  assert.match(src, /MAX_SYNC_TOKENS/, 'jumlah token per request di-cap');
  assert.match(src, /tokens:\s*z\.array\(tokenSchema\)/, 'token diterima dari body');
});

test('sync dipasang SEBELUM CSRF (tidak ada cookie di jalur ini)', () => {
  const app = read('../src/app.ts');
  const groupsIdx = app.indexOf('app.use("/api/groups"');
  const csrfIdx = app.indexOf('doubleCsrfProtection(req, res, next)');
  assert.ok(groupsIdx >= 0, 'router /api/groups dipasang');
  assert.ok(csrfIdx > groupsIdx, 'router grup harus di atas lapisan CSRF');
});

test('token-keyed rows di semua titik invite (create, invite REST, chat relay WT & REST)', () => {
  const conversationsRoute = read('../src/routes/conversations.ts');
  const messagesRoute = read('../src/routes/messages.ts');
  const handlers = read('../src/network/realtimeHandlers.ts');

  assert.match(conversationsRoute, /if \(!token\) continue;/, 'create/invite: anggota tanpa token tidak didaftarkan');
  assert.match(handlers, /if \(targetToken\)/, 'WT relay: row hanya saat token ada');
  assert.match(messagesRoute, /if \(targetToken\)/, 'REST relay: row hanya saat token ada');
});

test('token grup awal 43-char; rotasi memindahkan epoch semua baris anggota', () => {
  const conversationsRoute = read('../src/routes/conversations.ts');
  assert.match(conversationsRoute, /const authSecret = newOpaqueToken\(\)/, 'token grup awal 43-char base64url');
  assert.doesNotMatch(conversationsRoute, /randomBytes\(32\)\.toString\('hex'\)/, 'jangan kembali ke 64-hex (ditolak schema mailbox)');

  const tokens = read('../src/utils/groupTokens.ts');
  assert.match(tokens, /data: \{ tokenEpoch: epoch \}/, 'rotasi harus memindahkan baris anggota ke epoch baru');
  assert.match(tokens, /where: \{ conversationId \}/, 'updateMany dibatasi ke percakapan yang dirotasi');
});

test('mailbox pull menerima member token era berjalan (anti-deadlock rotasi)', () => {
  const src = read('../src/routes/groups.ts');
  const start = src.indexOf("router.post('/:id/mailbox/pull'");
  const route = src.slice(start, src.indexOf("router.get('/:id/epoch'", start));
  assert.ok(start >= 0 && route.length > 0, 'route mailbox pull harus ada');
  assert.match(route, /evaluateMemberToken\(member, conversation\.groupEpoch/, 'fallback memakai status epoch member token');
  assert.match(route, /member\.conversationId !== conversationId/, 'member token grup lain tidak boleh membaca mailbox');
  assert.match(route, /GROUP_AUTH_REQUIRED/, 'tetap 403 bila keduanya tidak sah');

  const client = read('../../web/src/lib/groupMailbox.ts');
  assert.match(
    client,
    /getMyGroupToken\(conversationId\) \?\? getMyDeliveryToken\(conversationId\)/,
    'klien jatuh ke member token saat group token lama sudah mati'
  );
});

test('revocation: kick merotasi epoch + menghapus baris, leave menghapus baris', () => {
  const src = read('../src/routes/conversations.ts');
  assert.match(src, /rotateGroupToken\(tx as unknown as GroupTokenDb/, 'kick menaikkan epoch + rotasi token grup dalam transaksi');
  assert.match(src, /res\.json\(\{ authSecret: rotated\.token, epoch: rotated\.epoch/, 'kick mengembalikan token era baru ke admin');

  const matches = src.match(/deleteMembership\(/g) ?? [];
  assert.ok(matches.length >= 2, 'kick dan leave menghapus baris keanggotaan');

  const groupsRoute = read('../src/routes/groups.ts');
  assert.match(groupsRoute, /router\.delete\('\/:id\/membership'/, 'holder-initiated revoke tersedia');
  assert.match(groupsRoute, /router\.post\('\/:id\/epoch'/, 'admin capability bisa menaikkan epoch');
  assert.match(groupsRoute, /router\.get\('\/:id\/epoch'/, 'status era dibaca admin untuk keputusan rotasi PCS');
});

test('klien: sync anonim, bukan header X-Delivery-Tokens', () => {
  const store = read('../../web/src/store/conversation.ts');
  assert.doesNotMatch(store, /X-Delivery-Tokens/, 'header lama dihapus (hard cut)');
  // [docs/37 §37.4 P3] Transport-nya kini di `lib/groupSync.ts` (OHTTP POST bila
  // aktif, bukti Privacy Pass opsional); store hanya memanggil helper itu.
  assert.match(store, /syncGroupMemberships\(/, 'loadConversations memakai sync anonim');
  const groupSync = read('../../web/src/lib/groupSync.ts');
  assert.match(groupSync, /'\/api\/groups\/sync'/, 'endpoint anonim');
  assert.match(groupSync, /JSON\.stringify\(\{ tokens,/, 'token dikirim di body');
  assert.match(groupSync, /ohttpFetch\('\/api\/groups\/sync'/, 'sync lewat OHTTP POST');

  const pseudonyms = read('../../web/src/lib/groupPseudonyms.ts');
  assert.match(pseudonyms, /MEMBER_TOKEN_BYTES = 32/, 'token anggota 256-bit');
});
