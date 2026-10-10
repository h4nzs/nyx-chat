// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0] At-rest secrets — kontrak helper.
 *
 * Yang dikunci di sini adalah janji privasi terhadap dump DB (adversary A1):
 *  - identifier ber-entropi rendah wajib di-index dengan pepper dari env
 *    (bukan hash tanpa kunci yang bisa dienumerasi),
 *  - token yang dipegang klien hanya boleh tersimpan sebagai hash (pola
 *    adminSecretHash) — tidak ada lagi cabang plaintext,
 *  - nilai yang server harus bisa baca (routing/API key) disimpan sealed
 *    deterministik (AEAD) — tak terbaca dari dump, tetap bisa di-lookup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  clearAtRestSecretCacheForTests,
  credentialTokenMatches,
  getAtRestPepper,
  hashCredentialToken,
  identifierLookupCandidates,
  isHashedToken,
  openAtRest,
  pepperedIdentifier,
  sealAtRest,
  sealedLookupCandidates,
} from '../src/utils/atRestSecrets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

/** Set pepper untuk durasi callback (sync ATAU async) lalu pulihkan cache/env. */
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

test('pepper: identifier deterministik tapi berubah saat pepper berubah', async () => {
  const raw = '203.0.113.7';
  const a = await withPepper('pepper-satu', () => pepperedIdentifier(raw));
  const aAgain = await withPepper('pepper-satu', () => pepperedIdentifier(raw));
  const b = await withPepper('pepper-dua', () => pepperedIdentifier(raw));

  assert.equal(a, aAgain, 'nilai sama + pepper sama → hash sama (lookup by equality tetap jalan)');
  assert.notEqual(a, b, 'pepper berbeda → hash berbeda (rainbow table global tidak berlaku)');
  assert.notEqual(a, raw, 'nilai mentah tidak pernah tersimpan');
  assert.match(a, /^[a-f0-9]{64}$/, 'bentuk 64-hex');
});

test('pepper: dump DB tanpa pepper tidak bisa membalik IP/fingerprint', async () => {
  // Simulasi attacker A1: ia punya hash dari dump, tapi tidak punya pepper.
  const dumped = await withPepper('pepper-produksi', () => pepperedIdentifier('1.2.3.4'));
  const attackerGuess = await withPepper('tebakan-attacker', () => pepperedIdentifier('1.2.3.4'));
  assert.notEqual(dumped, attackerGuess, 'menebak IP tanpa pepper tidak menghasilkan hash yang sama');
});

test('identifierLookupCandidates: [ter-pepper, nilai kiriman] untuk echo klien', async () => {
  const candidates = await withPepper('p', () => identifierLookupCandidates('user-hash-abc'));
  assert.equal(candidates.length, 2, 'tidak ada kandidat lain (query tetap minimal)');
  assert.equal(candidates[0], await withPepper('p', () => pepperedIdentifier('user-hash-abc')));
  assert.equal(candidates[1], 'user-hash-abc', 'kandidat kedua = nilai kiriman apa adanya (echo hash-ID dari share link)');
});

test('hashCredentialToken: SHA-256 hex (pola adminSecretHash)', () => {
  const token = 'a'.repeat(64); // authSecret legacy = 64 hex, sama panjang dengan hash-nya
  const expected = createHash('sha256').update(token).digest('hex');
  assert.equal(hashCredentialToken(token), expected);
  assert.equal(isHashedToken(expected), true);
  assert.equal(isHashedToken(token), true, 'token 64-hex juga terlihat seperti hash');
  assert.equal(isHashedToken('pendek'), false);
});

test('credentialTokenMatches: hanya nilai tersimpan ber-hash yang diterima', () => {
  const token = 'b'.repeat(64);
  const storedHashed = hashCredentialToken(token);

  assert.equal(credentialTokenMatches(storedHashed, token), true, 'token benar melawan nilai tersimpan (hash)');
  assert.equal(credentialTokenMatches(token, token), false, 'plaintext (pra-hash) TIDAK lagi mengotorisasi');
  assert.equal(credentialTokenMatches(storedHashed, 'c'.repeat(64)), false, 'token salah ditolak');
  assert.equal(credentialTokenMatches(null, token), false, 'tanpa secret tersimpan → tidak ada akses');
  assert.equal(credentialTokenMatches(storedHashed, ''), false, 'presentasi kosong ditolak');
});

test('sealAtRest: deterministik (lookup by equality) + tidak terbaca tanpa pepper', async () => {
  const value = 'tenant-api-key-rahasia';

  await withPepper('p-seal', async () => {
    const sealedA = await sealAtRest(value);
    const sealedB = await sealAtRest(value);
    assert.equal(sealedA, sealedB, 'plaintext sama → sealed sama (kolom tetap bisa di-lookup)');

    const other = await sealAtRest(`${value}-lain`);
    assert.notEqual(sealedA, other, 'plaintext beda → sealed beda');

    assert.equal(await openAtRest(sealedA), value, 'roundtrip dengan pepper yang sama');

    // Tamper: satu karakter diubah → AEAD menolak (null, bukan throw).
    const tampered = `${sealedA.slice(0, -1)}${sealedA.slice(-1) === 'A' ? 'B' : 'A'}`;
    assert.equal(await openAtRest(tampered), null, 'ciphertext diubah → null');
    assert.equal(await openAtRest('plaintext-legacy'), null, 'nilai legacy (bukan sealed) → null');
    assert.equal(await openAtRest(null), null);
  });

  // Pepper lain (attacker tanpa key) tidak bisa membuka.
  const sealedProduksi = await withPepper('p-seal', () => sealAtRest(value));
  await withPepper('pepper-attacker', async () => {
    assert.equal(await openAtRest(sealedProduksi), null, 'tanpa pepper yang benar, sealed tidak terbaca');
  });
});

test('sealedLookupCandidates: hanya bentuk sealed (tanpa kandidat plaintext)', async () => {
  const key = 'api-key-abc';
  const candidates = await withPepper('p', () => sealedLookupCandidates(key));
  assert.equal(candidates.length, 1, 'tidak ada kandidat plaintext (baris legacy sudah tidak ada)');
  assert.notEqual(candidates[0], key, 'nilai tersimpan ter-seal, bukan API key asli');
  // Open harus di dalam pepper yang sama (di luar itu = attacker tanpa pepper).
  const opened = await withPepper('p', () => openAtRest(candidates[0]!));
  assert.equal(opened, key);
});

test('contract: pepper produksi wajib env, bukan turunan DB', () => {
  const src = read('../src/utils/atRestSecrets.ts');
  assert.match(src, /NYX_AT_REST_PEPPER/, 'nama env pepper terkunci');
  assert.match(src, /env\.nodeEnv === 'production'[\s\S]*throw new Error/, 'production tanpa pepper = fail-closed');
  assert.doesNotMatch(src, /prisma/i, 'helper ini TIDAK boleh menyentuh DB (kalau tidak, pepper bocor lewat dump)');

  // Provider yang di-assert: nilai default dev hanya untuk non-production.
  const prev = process.env.NYX_AT_REST_PEPPER;
  delete process.env.NYX_AT_REST_PEPPER;
  clearAtRestSecretCacheForTests();
  try {
    assert.equal(typeof getAtRestPepper(), 'string');
  } finally {
    if (prev !== undefined) process.env.NYX_AT_REST_PEPPER = prev;
    clearAtRestSecretCacheForTests();
  }
});
