// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — residual 2.2 / 2.3 / 2.4]
 *
 *  2.2 `Message.repliedToId` disimpan TER-SEAL, dibuka saat read; mapper tidak
 *      pernah mengirim nilai ter-seal ke klien.
 *  2.3 `Authenticator.counter` SENGAJA dipertahankan (deteksi kloning WebAuthn) —
 *      keputusan sadar, bukan kelalaian.
 *  2.4 `OneTimePreKey.createdAt` dihapus (tak ada riwayat waktu); urutan pakai
 *      `keyId`; baris dihapus atomik saat dipakai.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { clearAtRestSecretCacheForTests, sealAtRest } from '../src/utils/atRestSecrets.js';
import { resolveRepliedToId, toRawServerMessage, type PrismaMessageInput } from '../src/utils/mappers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

function modelBody(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `model ${model} harus ada`);
  return match[1]!;
}

async function withPepper<T>(pepper: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.NYX_AT_REST_PEPPER;
  process.env.NYX_AT_REST_PEPPER = pepper;
  clearAtRestSecretCacheForTests();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NYX_AT_REST_PEPPER;
    else process.env.NYX_AT_REST_PEPPER = prev;
    clearAtRestSecretCacheForTests();
  }
}

test('2.2: repliedToId round-trip ter-seal; legacy plaintext tetap lolos', async () => {
  await withPepper('test-pepper-reply', async () => {
    const original = 'msg_abc123';
    const sealed = await sealAtRest(original);
    assert.notEqual(sealed, original, 'nilai tersimpan bukan id asli');
    assert.equal(await resolveRepliedToId(sealed), original, 'server membuka kembali ke id asli');
    // Baris legacy (plaintext) → openAtRest null → nilai apa adanya.
    assert.equal(await resolveRepliedToId('msg_legacy_plain'), 'msg_legacy_plain');
    assert.equal(await resolveRepliedToId(null), null);
    assert.equal(await resolveRepliedToId(undefined), null);
  });
});

test('2.2: mapper TIDAK pernah mengirim nilai repliedToId tersimpan ke klien', () => {
  const base: PrismaMessageInput = {
    id: 'm1',
    conversationId: 'c1',
    senderId: null,
    content: 'x',
    createdAt: '2026-10-08T00:00:00.000Z',
  };
  // Walau DB berisi nilai ter-seal, mapper mengosongkannya (pemanggil read yang
  // mengisi ulang setelah unseal) — mencegah kebocoran tag ter-seal.
  assert.equal(toRawServerMessage({ ...base, repliedToId: 'SEALED_VALUE' }).repliedToId, undefined);
});

test('2.2 wiring: write menyegel, read membuka', () => {
  const wt = read('../src/network/realtimeHandlers.ts');
  assert.match(wt, /repliedToId: repliedToId \? await sealAtRest\(repliedToId\) : null/, 'write WS menyegel');

  const rest = read('../src/routes/messages.ts');
  assert.match(rest, /resolveRepliedToId\(msg\.repliedToId\)/, 'read REST membuka');

  const mappers = read('../src/utils/mappers.ts');
  assert.match(mappers, /export async function resolveRepliedToId/, 'helper resolve ada');
});

test('2.4: OneTimePreKey.createdAt dihapus, urutan pakai keyId', () => {
  const otpk = modelBody(read('../prisma/schema.prisma'), 'OneTimePreKey');
  assert.doesNotMatch(otpk, /^\s*createdAt\s+\S/m, 'kolom waktu dihapus');

  const keys = read('../src/routes/keys.ts');
  assert.match(keys, /ORDER BY "keyId" ASC/, 'urutan konsumsi pakai keyId');
  assert.doesNotMatch(keys, /ORDER BY "createdAt" ASC[\s\S]{0,80}FOR UPDATE/, 'tidak lagi mengurut by createdAt');
  assert.match(keys, /DELETE FROM "OneTimePreKey"/, 'baris OTPK dihapus atomik saat dipakai');
});

test('2.3: Authenticator.counter SENGAJA dipertahankan (deteksi kloning WebAuthn)', () => {
  // Keputusan sadar: counter dibutuhkan verifikasi WebAuthn (clone detection).
  // Test ini mengunci keberadaannya supaya penghapusan tak sengaja tertangkap.
  const auth = modelBody(read('../prisma/schema.prisma'), 'Authenticator');
  assert.match(auth, /counter\s+BigInt/, 'counter tetap ada');
});
