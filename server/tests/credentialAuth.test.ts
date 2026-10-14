// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/29 §7.1 + §5.8; docs/30 WS-G] Otorisasi issuance credential — diuji
 * sebagai **perilaku**, bukan regex atas source.
 *
 * Temuan HIGH §7.1 dulu: endpoint issuance menandatangani blinded message apa
 * pun (hanya butuh user terautentikasi + tahu UUID conversation), sehingga akun
 * luar bisa menerbitkan credential untuk grup yang bukan miliknya lalu
 * memakainya di `/sync`. Perbaikan QW1 menambahkan gate keanggotaan; test ini
 * mengunci **matriks keputusannya** dengan klien Prisma palsu, jadi regresi
 * (mis. gate dilepas lagi, atau token asal diterima) langsung gagal di sini —
 * bukan hanya terlihat sebagai perubahan teks.
 *
 * Tidak butuh Postgres/Redis (aturan `AGENTS.md`): semua query dilayani fake
 * in-memory dengan bentuk minimal `CredentialAuthDb`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeCredentialIssuance,
  requireAdminCapability,
  MAX_DELIVERY_TOKENS,
  type CredentialAuthDb,
} from '../src/utils/credentialAuth.js';
import { hashAdminToken } from '../src/utils/adminCapability.js';
import { hashCredentialToken } from '../src/utils/atRestSecrets.js';

const GROUP_TOKEN = 'group-secret-token-yang-panjang';
const ADMIN_TOKEN = 'admin-secret-token-yang-panjang';
const CONVERSATION_ID = 'conv-1';
const OTHER_CONVERSATION_ID = 'conv-2';

/** Fake in-memory: conversation + baris keanggotaan token-first (tanpa userId). */
function fakeDb(options?: { conversationExists?: boolean; issuedTokens?: string[] }): {
  db: CredentialAuthDb;
  membershipQueries: Array<Record<string, unknown>>;
} {
  const conversationExists = options?.conversationExists ?? true;
  const membership = options?.issuedTokens ?? ['tok_aaaaaaaaaaaaaaaaaa' /* 22 char */];
  const membershipQueries: Array<Record<string, unknown>> = [];

  const db: CredentialAuthDb = {
    conversation: {
      async findUnique({ where }) {
        if (!conversationExists) return null;
        if (where.id !== CONVERSATION_ID && where.id !== OTHER_CONVERSATION_ID) return null;
        // Kontrak kolom: kedua nilai adalah SHA-256(token), bukan token mentah
        // (`authSecret` ditulis di routes/conversations.ts:384).
        return {
          authSecret: hashCredentialToken(GROUP_TOKEN),
          adminSecretHash: hashAdminToken(ADMIN_TOKEN),
        };
      },
    },
    userHiddenConversation: {
      async findFirst({ where }) {
        membershipQueries.push(where);
        const requested = (where.deliveryToken as { in?: string[] } | undefined)?.in ?? [];
        const conversationId = where.conversationId as string;
        const found = requested.some((token) => membership.includes(token));
        return conversationId === CONVERSATION_ID && found ? { id: 'uhc-1' } : null;
      },
    },
  };

  return { db, membershipQueries };
}

test('§7.1 gate keanggotaan: tanpa bukti apa pun → DITOLAK (bukan fail-open)', async () => {
  const { db, membershipQueries } = fakeDb();
  assert.equal(await authorizeCredentialIssuance(db, CONVERSATION_ID, {}), false);
  assert.equal(await authorizeCredentialIssuance(db, CONVERSATION_ID, {}, ''), false);
  assert.equal(await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-group-token': '' }), false);
  // Tanpa token sama sekali: TIDAK boleh ada query DB sama sekali.
  assert.equal(membershipQueries.length, 0, 'request tanpa token tidak boleh menyentuh tabel keanggotaan');
});

test('§7.1 gate keanggotaan: token grup salah → ditolak, token grup benar → diterima', async () => {
  const { db } = fakeDb();
  assert.equal(
    await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-group-token': 'token-yang-salah' }),
    false
  );
  assert.equal(await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-group-token': GROUP_TOKEN }), true);
});

test('§7.1 gate keanggotaan: conversation tidak dikenal → ditolak (tanpa query keanggotaan)', async () => {
  const { db, membershipQueries } = fakeDb({ conversationExists: false });
  assert.equal(
    await authorizeCredentialIssuance(db, 'conv-tidak-ada', { 'x-group-token': GROUP_TOKEN }),
    false
  );
  assert.equal(membershipQueries.length, 0);
});

test('§7.1 gate keanggotaan: token undangan harus TERDAFTAR di conversation yang diklaim', async () => {
  const { db } = fakeDb({ issuedTokens: ['tok_aaaaaaaaaaaaaaaaaa'] });
  // Terdaftar → boleh.
  assert.equal(
    await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-delivery-tokens': 'tok_aaaaaaaaaaaaaaaaaa' }),
    true
  );
  // Tidak terdaftar (tetap berbentuk sah) → ditolak.
  assert.equal(
    await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-delivery-tokens': 'tok_zzzzzzzzzzzzzzzzzz' }),
    false
  );
  // Token milik conversation LAIN tidak boleh dipakai silang.
  assert.equal(
    await authorizeCredentialIssuance(db, OTHER_CONVERSATION_ID, { 'x-delivery-tokens': 'tok_aaaaaaaaaaaaaaaaaa' }),
    false
  );
});

test('§7.1 gate keanggotaan: token lewat body & format tak sah, header array, dan daftar gabungan', async () => {
  const { db } = fakeDb({ issuedTokens: ['tok_aaaaaaaaaaaaaaaaaa'] });
  // Body sebagai alternatif header.
  assert.equal(
    await authorizeCredentialIssuance(db, CONVERSATION_ID, {}, 'tok_aaaaaaaaaaaaaaaaaa'),
    true
  );
  // Body berformat tak sah diabaikan (bukan diperlakukan sebagai token).
  assert.equal(await authorizeCredentialIssuance(db, CONVERSATION_ID, {}, 'terlalu-pendek'), false);
  // Header berbentuk array (Express bisa memberi array untuk header berulang).
  assert.equal(
    await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-delivery-tokens': ['tok_aaaaaaaaaaaaaaaaaa'] }),
    true
  );
  // Daftar gabungan: token sah + sampah → sampah dibuang, satu token sah cukup.
  assert.equal(
    await authorizeCredentialIssuance(db, CONVERSATION_ID, {
      'x-delivery-tokens': 'bukan-token, tok_aaaaaaaaaaaaaaaaaa , ,',
    }),
    true
  );
});

test('§7.1 gate keanggotaan: jumlah token dibatasi & dideduplikasi (anti-amplifikasi)', async () => {
  const { db, membershipQueries } = fakeDb({ issuedTokens: ['tok_aaaaaaaaaaaaaaaaaa'] });
  // 22 char persis (`^[A-Za-z0-9_-]{22}$`) supaya benar-benar lolos filter format.
  const flood = Array.from({ length: MAX_DELIVERY_TOKENS + 300 }, (_, i) => `tok_${String(i).padStart(18, '0')}`);
  flood.push('tok_aaaaaaaaaaaaaaaaaa', 'tok_aaaaaaaaaaaaaaaaaa');

  await authorizeCredentialIssuance(db, CONVERSATION_ID, { 'x-delivery-tokens': flood.join(',') });

  assert.equal(membershipQueries.length, 1, 'satu query saja');
  const asked = (membershipQueries[0]!.deliveryToken as { in: string[] }).in;
  assert.equal(asked.length, MAX_DELIVERY_TOKENS, `maksimum ${MAX_DELIVERY_TOKENS} token di-query`);
  assert.equal(new Set(asked).size, asked.length, 'token duplikat harus dibuang');
});

test('capability admin: hash token salah/tidak ada → 403, conversation hilang → 404, benar → ok', async () => {
  const { db } = fakeDb();
  assert.deepEqual(await requireAdminCapability(db, CONVERSATION_ID, {}), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
  assert.deepEqual(await requireAdminCapability(db, CONVERSATION_ID, { 'x-admin-token': 'salah' }), {
    ok: false,
    status: 403,
    error: 'ADMIN_AUTH_REQUIRED: Invalid or missing X-Admin-Token',
  });
  assert.deepEqual(await requireAdminCapability(db, 'conv-tidak-ada', { 'x-admin-token': ADMIN_TOKEN }), {
    ok: false,
    status: 404,
    error: 'Not found',
  });
  assert.deepEqual(await requireAdminCapability(db, CONVERSATION_ID, { 'x-admin-token': ADMIN_TOKEN }), { ok: true });
});
