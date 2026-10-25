// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 — GUARDRAIL PRIVASI AT-REST]
 *
 * Satu suite yang mengunci janji privasi terhadap dump DB (adversary A1) supaya
 * perbaikan Tier 0/1.x tidak bisa regresi diam-diam. Setiap assertion di sini
 * mewakili satu temuan di docs/28-db-dump-threat-model.md:
 *
 *   D1  kunci privat issuer grup TIDAK di DB        (server/api/config)
 *   D2  identitas tidak persist di MessageStatus / UserHiddenConversation
 *   D3  authSecret & deleteSecret disimpan sebagai hash
 *   D4  Tenant.apiKey disimpan sealed
 *   D5  tidak ada ipAddress/userAgent per sesi
 *   D6  blind index username ter-pepper
 *   D7  fingerprint perangkat ter-index
 *   D10 endpoint push ter-seal
 *   D11 metadata bebas tenant & PK time-ordered hilang
 *   D4/D9 residual: identitas B2B, label device, anchor instalasi ter-seal
 *
 * D14 (Redis tanpa userId asli + presence tanpa broadcast roster global) TIDAK
 * diuji di sini — ia dikunci oleh `tests/redisIdentity.test.ts` &
 * `tests/presencePeers.test.ts` (perilaku runtime, bukan bentuk schema).
 *
 * Kalau test ini gagal: BUKAN "test-nya usang" — periksa dulu apakah perubahan
 * itu benar-benar diinginkan, karena artinya janji privasi di docs/28 dibatalkan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

/** Ambil body satu model Prisma (dari `model X {` sampai `}` penutup). */
function modelBody(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `model ${model} harus ada di schema.prisma`);
  return match[1]!;
}

test('D2: identitas asli tidak dipersist di MessageStatus maupun UserHiddenConversation', () => {
  const handlers = read('../src/network/realtimeHandlers.ts');
  const schema = read('../prisma/schema.prisma');

  // Receipt: tag opaque turunan server untuk 1:1/grup v1, pseudonym untuk grup v2.
  assert.equal(
    (handlers.match(/conversationScopedTag\(conversationId, userId\)/g) || []).length,
    2,
    'kedua jalur receipt (per-pesan + batch) memakai tag opaque'
  );
  assert.doesNotMatch(handlers, /persistedReaderId\s*=\s*[^;]*:\s*userId\b/, 'tidak ada fallback userId asli');

  // Keanggotaan: routing identity ter-seal, bukan userId.
  const uhc = modelBody(schema, 'UserHiddenConversation');
  assert.match(uhc, /userId\s+String\?/, 'userId tetap nullable (baris token-only)');
  // [BUGFIX 2026-10-09] Kolom ter-seal TIDAK boleh punya relasi/FK ke User:
  // nilainya bukan id asli, jadi setiap `create` PASTI gagal P2003
  // (UserHiddenConversation_userId_fkey) dan baris keanggotaan tidak pernah
  // tercatat — keanggotaan grup hilang tanpa jejak di log aplikasi.
  assert.doesNotMatch(uhc, /@relation\(fields: \[userId\]/, 'userId ter-seal tanpa FK ke User');
  assert.doesNotMatch(
    modelBody(schema, 'User'),
    /^\s*hiddenConversations\s+UserHiddenConversation\[\]/m,
    'relasi balik hiddenConversations juga harus hilang'
  );
  const routing = read('../src/utils/routingIdentity.ts');
  assert.match(routing, /sealAtRest\(userId\)/, 'nilai kolom = seal deterministik');
  assert.match(
    routing,
    /userHiddenConversation\.deleteMany/,
    'tanpa FK, pembersihan saat akun dihapus wajib eksplisit (purgeSealedUserRows)'
  );
  for (const file of ['../src/network/realtimeHandlers.ts', '../src/routes/messages.ts', '../src/routes/conversations.ts']) {
    assert.doesNotMatch(read(file), /userHiddenConversation\.upsert\(/, `${file}: penulisan keanggotaan harus lewat upsertMembership`);
  }
});

test('D3/D4: secret otoritas disimpan sebagai hash (token) atau sealed (nilai yang perlu dibaca)', () => {
  const conversations = read('../src/routes/conversations.ts');
  // [PQ-only 2026-10-23] Perbandingan token grup pindah ke `groupAccess.ts`
  // setelah endpoint credential dihapus.
  const groupAccess = read('../src/utils/groupAccess.ts');
  const handlers = read('../src/network/realtimeHandlers.ts');

  assert.match(conversations, /authSecret: hashCredentialToken\(authSecret\)/, 'authSecret grup = hash SHA-256');
  assert.match(handlers, /deleteSecret: deleteSecret \? hashCredentialToken\(deleteSecret\) : null/, 'deleteSecret pesan = hash SHA-256');
  assert.doesNotMatch(conversations, /safeEqualStrings\(conversation\.authSecret/, 'perbandingan token lewat helper dual-mode timing-safe');
  assert.match(groupAccess, /credentialTokenMatches\(conversation\.authSecret/, 'authSecret dibandingkan via credentialTokenMatches');
  assert.doesNotMatch(read('../src/routes/messages.ts'), /safeEqualStrings\(message\.deleteSecret/, 'deleteSecret lewat helper dual-mode');

  const tenantAuth = read('../src/middleware/tenantAuth.ts');
  assert.match(tenantAuth, /sealedLookupCandidates\(apiKey\)/, 'Tenant.apiKey di-lookup dalam bentuk sealed');
  assert.match(read('../src/routes/admin.ts'), /apiKey: await sealAtRest\(apiKey\)/, 'Tenant.apiKey disimpan sealed');
});

test('D5: sesi tidak lagi menyimpan IP atau userAgent', () => {
  const schema = read('../prisma/schema.prisma');
  const refreshToken = modelBody(schema, 'RefreshToken');

  // Regex kolom (baris `nama  Tipe`), bukan sekadar kemunculan kata — komentar
  // dokumentasi di schema boleh menyebut penjelasan penghapusannya.
  assert.doesNotMatch(refreshToken, /^\s*ipAddress\s+\S/m, 'kolom ipAddress dihapus (hash tanpa kunci = enumerable)');
  assert.doesNotMatch(refreshToken, /^\s*userAgent\s+\S/m, 'kolom userAgent dihapus (sidik jari perangkat/browser)');
  assert.doesNotMatch(refreshToken, /crypto_generichash\(32, Buffer\.from\(rawIp\)/, 'tidak ada lagi hash IP tanpa kunci');

  for (const file of ['../src/routes/auth.ts', '../src/routes/engine.ts']) {
    assert.doesNotMatch(read(file), /data:\s*\{[^}]*ipAddress/, `${file}: tidak menulis ipAddress ke RefreshToken`);
  }
});

test('D6/D7: identifier ber-entropi rendah di-index dengan pepper env', () => {
  const secrets = read('../src/utils/atRestSecrets.ts');
  assert.match(secrets, /NYX_AT_REST_PEPPER/, 'pepper dari env, bukan dari DB');
  assert.doesNotMatch(secrets, /prisma/i, 'helper tidak boleh menyentuh DB (kalau tidak, pepper bocor lewat dump)');

  assert.match(read('../src/routes/auth.ts'), /usernameHash: pepperedIdentifier\(usernameHash\)/, 'blind index username ter-pepper');
  assert.match(read('../src/routes/users.ts'), /pepperedIdentifier\(_fp\)/, 'fingerprint device ter-index');

  const envExample = read('../.env.example');
  assert.match(envExample, /NYX_AT_REST_PEPPER=/, 'server/.env.example mendokumentasikan pepper');
});

test('D4/D9/D10 residual: identitas B2B, label device, anchor instalasi & endpoint push ter-seal', () => {
  const schema = read('../prisma/schema.prisma');

  // D4: identitas pelanggan B2B (dari tenant) tidak lagi plaintext.
  const user = modelBody(schema, 'User');
  assert.doesNotMatch(user, /^\s*externalId\s+\S/m, 'kolom externalId plaintext dihapus');
  assert.match(user, /^\s*externalIdSealed\s+String\?/m, 'externalId disimpan ter-seal');
  assert.match(user, /@@unique\(\[tenantId, externalIdSealed\]\)/, 'uniqueness tetap (tenant, identity)');

  // D9 residual: label platform yang di-set klien ("Chrome on macOS").
  const device = modelBody(schema, 'Device');
  assert.doesNotMatch(device, /^\s*name\s+\S/m, 'kolom Device.name plaintext dihapus');
  assert.match(device, /^\s*nameSealed\s+String\?/m, 'Device.name disimpan ter-seal');

  // D9 residual: anchor instalasi persisten dari IndexedDB.
  assert.doesNotMatch(device, /^\s*installationId\s+\S/m, 'installationId mentah dihapus');
  assert.match(device, /^\s*installationTag\s+String\?/m, 'anchor instalasi jadi tag HMAC');
  assert.match(read('../src/utils/atRestSecrets.ts'), /function deviceInstallationTag/, 'tag instalasi terpusat');

  // D10: endpoint FCM/APNs = identifier perangkat + korelasi lintas akun.
  const push = modelBody(schema, 'PushSubscription');
  assert.doesNotMatch(push, /^\s*endpoint\s+\S/m, 'kolom endpoint plaintext dihapus');
  assert.match(push, /^\s*endpointSealed\s+String\s+@unique/m, 'endpoint ter-seal + tetap unik');
  // [docs/37 §37.4 P6] Setelah rotasi key ring, endpoint lama dan baru memakai
  // kunci berbeda → baca/hapus WAJIB lewat kandidat, bukan satu nilai seal.
  assert.match(read('../src/routes/auth.ts'), /endpointSealed: \{ in: await sealedLookupCandidates\(endpoint\) \}/, 'logout menghapus push via kandidat nilai ter-seal');
  assert.match(read('../src/network/realtimeHandlers.ts'), /sealedLookupCandidates\(endpoint\)/, 'subscribe mencari endpoint dengan kandidat kunci seal');
  assert.match(read('../src/network/realtimeHandlers.ts'), /endpointSealed: endpointCandidates\[0\]!/, 'baris baru memakai nilai kunci aktif');
  assert.match(read('../src/utils/sendPushNotification.ts'), /openAtRest\(sub\.endpointSealed\)/, 'endpoint dibuka HANYA saat mengirim push');

  // Jalur B2B menulis identitas ter-seal (bukan plaintext).
  assert.match(read('../src/routes/engine.ts'), /externalIdSealed/, 'engine menyimpan identitas B2B ter-seal');
});

test('D11 residual: metadata bebas tenant tidak lagi dipersist', () => {
  const schema = read('../prisma/schema.prisma');
  const conversation = modelBody(schema, 'Conversation');

  // `Conversation.metadata` dulu JSON bebas dari tenant (write-only: tak pernah
  // dibaca server) → apa pun yang dititipkan tenant tersimpan apa adanya.
  assert.doesNotMatch(conversation, /^\s*metadata\s+Json/m, 'kolom metadata Json dihapus');
  const engine = read('../src/routes/engine.ts');
  assert.doesNotMatch(engine, /metadata:\s*[^,\n]*req\.body/, 'engine tidak lagi menulis metadata tenant ke DB');

  // D11: tak ada PK ber-default `cuid()` (time-ordered → membocorkan waktu buat).
  assert.doesNotMatch(schema, /@default\(cuid\(\)\)/, 'semua PK ber-default memakai uuid()');
});

