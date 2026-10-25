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
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { env } from '../src/config.js';
import {
  AT_REST_ENVELOPE_V2,
  LEGACY_SEAL_KEY_ID,
  atRestStatus,
  clearAtRestSecretCacheForTests,
  credentialTokenMatches,
  getAtRestKeyring,
  getAtRestPepper,
  generateShareId,
  hashCredentialToken,
  identifierLookupCandidates,
  isHashedToken,
  isSearchableIdentifier,
  isShareId,
  openAtRest,
  pepperedIdentifier,
  sealAtRest,
  sealedKeyId,
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

test('[docs/35 Fase 4 — R5] identifierLookupCandidates: hanya bentuk hash, tidak pernah nilai mentah', async () => {
  const clientHash = 'A'.repeat(43);
  const candidates = await withPepper('p', () => identifierLookupCandidates(clientHash));
  assert.equal(candidates.length, 1, 'hash klien → satu kandidat (ter-pepper)');
  assert.equal(candidates[0], await withPepper('p', () => pepperedIdentifier(clientHash)));

  // R5: nilai mentah (username/email) tidak boleh menjadi kandidat lookup.
  const rawCandidates = await withPepper('p', () => identifierLookupCandidates('alice@example.com'));
  assert.deepEqual(rawCandidates, [await withPepper('p', () => pepperedIdentifier('alice@example.com'))]);
  assert.equal(rawCandidates.includes('alice@example.com'), false, 'nilai mentah tidak pernah dikirim ke DB');
});

test('identifierLookupCandidates: 64-hex (echo server) dipakai apa adanya sebagai satu-satunya kandidat', async () => {
  const pepperedEcho = await withPepper('p', () => pepperedIdentifier('A'.repeat(43)));
  const candidates = await withPepper('p', () => identifierLookupCandidates(pepperedEcho));
  assert.deepEqual(candidates, [pepperedEcho]);
  assert.deepEqual(
    await withPepper('p', () => identifierLookupCandidates(pepperedEcho.toUpperCase())),
    [pepperedEcho],
    'hex dinormalisasi ke lowercase',
  );
});

test('isSearchableIdentifier: 43-char base64url, 64-hex, atau shareId `s1_`', async () => {
  assert.equal(isSearchableIdentifier('A'.repeat(43)), true);
  assert.equal(isSearchableIdentifier('a'.repeat(64)), true);
  assert.equal(isSearchableIdentifier(generateShareId()), true);
  assert.equal(isSearchableIdentifier('alice'), false);
  assert.equal(isSearchableIdentifier('alice@example.com'), false);
  assert.equal(isSearchableIdentifier('A'.repeat(42)), false);
  assert.equal(isSearchableIdentifier('z'.repeat(64)), false);
  assert.equal(isSearchableIdentifier('s1_' + 'A'.repeat(42)), false, 'shareId harus 43 char setelah prefiks');
});

test('[docs/28 §R5] generateShareId: acak, berprefiks, dan tidak memakai pepper', async () => {
  const ids = Array.from({ length: 50 }, () => generateShareId());
  assert.equal(new Set(ids).size, ids.length, 'setiap shareId unik');
  for (const id of ids) {
    assert.match(id, /^s1_[A-Za-z0-9_-]{43}$/);
    assert.equal(isShareId(id), true);
  }
  assert.equal(isShareId('A'.repeat(43)), false, 'hash lama bukan shareId');
  assert.equal(isShareId('s1_' + 'A'.repeat(44)), false);
  assert.equal(isShareId(undefined), false);

  // ShareId adalah nilai acak: nilai sama dengan pepper berbeda tetap identik
  // (route search mem-branch ke kolom shareId, bukan ke blind index).
  const id = generateShareId();
  const a = await withPepper('p-satu', () => isShareId(id));
  const b = await withPepper('p-dua', () => isShareId(id));
  assert.equal(a, b);
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

/**
 * [docs/37 §37.4 P6] Jalankan callback dengan key ring tertentu. `undefined` =
 * tanpa key ring (perilaku legacy). Materi kunci sengaja pendek & berbeda per
 * tes supaya salah-kunci terlihat sebagai kegagalan baca, bukan lolos.
 */
async function withKeyring<T>(keyring: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prevKeyring = process.env.NYX_AT_REST_KEYRING;
  const prevFile = process.env.NYX_AT_REST_KEYRING_FILE;
  delete process.env.NYX_AT_REST_KEYRING_FILE;
  if (keyring === undefined) delete process.env.NYX_AT_REST_KEYRING;
  else process.env.NYX_AT_REST_KEYRING = keyring;
  clearAtRestSecretCacheForTests();
  try {
    return await fn();
  } finally {
    if (prevKeyring === undefined) delete process.env.NYX_AT_REST_KEYRING;
    else process.env.NYX_AT_REST_KEYRING = prevKeyring;
    if (prevFile === undefined) delete process.env.NYX_AT_REST_KEYRING_FILE;
    else process.env.NYX_AT_REST_KEYRING_FILE = prevFile;
    clearAtRestSecretCacheForTests();
  }
}

const KEYRING_2026_11 = JSON.stringify({
  active: 'k2026-11',
  keys: { 'k2026-11': 'materi-kunci-rotasi-november-2026', 'k2026-10': 'materi-kunci-rotasi-oktober-2026' },
});

test('[P6] tanpa key ring: envelope tetap format legacy (rollback aman)', async () => {
  await withPepper('p-legacy', () => withKeyring(undefined, async () => {
    const sealed = await sealAtRest('nilai-legacy');
    assert.equal(sealed.startsWith(`${AT_REST_ENVELOPE_V2}:`), false, 'tanpa key ring tidak ada prefiks ENC2');
    assert.equal(sealedKeyId(sealed), LEGACY_SEAL_KEY_ID, 'format lama = kunci id 0');
    assert.equal(atRestStatus().activeKeyId, LEGACY_SEAL_KEY_ID);
    assert.equal(atRestStatus().custody.provider, 'none');
  }));
});

test('[P6] key ring aktif: tulisan ENC2, roundtrip, deterministik', async () => {
  await withPepper('p-rotasi', () => withKeyring(KEYRING_2026_11, async () => {
    const sealedA = await sealAtRest('tenant-api-key');
    const sealedB = await sealAtRest('tenant-api-key');

    assert.match(sealedA, new RegExp(`^${AT_REST_ENVELOPE_V2}:k2026-11:`), 'prefiks memuat id kunci aktif');
    assert.equal(sealedA, sealedB, 'deterministik per kunci → kolom tetap bisa di-lookup');
    assert.equal(sealedKeyId(sealedA), 'k2026-11');
    assert.equal(await openAtRest(sealedA), 'tenant-api-key');
    assert.notEqual(await sealAtRest('tenant-api-key-lain'), sealedA);

    const status = atRestStatus();
    assert.equal(status.activeKeyId, 'k2026-11');
    assert.equal(status.keyCount, 3, 'dua kunci operator + kunci legacy id 0');
    assert.equal(status.custody.provider, 'env');
    assert.equal(status.legacyReadable, true);
    assert.doesNotMatch(JSON.stringify(status), /materi-kunci/, 'status tidak boleh memuat materi kunci');
  }));
});

test('[P6] baris legacy tetap terbaca setelah key ring aktif', async () => {
  const legacySealed = await withPepper('p-migrasi', () => withKeyring(undefined, () => sealAtRest('routing-user-1')));

  await withPepper('p-migrasi', () => withKeyring(KEYRING_2026_11, async () => {
    assert.equal(await openAtRest(legacySealed), 'routing-user-1', 'kunci id 0 selalu dimuat');
    assert.equal(atRestStatus().legacyReadable, true);
  }));
});

test('[P6] sealedLookupCandidates: kandidat semua kunci ring, semuanya membuka nilai sama', async () => {
  const KEYRING_2026_10 = JSON.stringify({
    active: 'k2026-10',
    keys: { 'k2026-11': 'materi-kunci-rotasi-november-2026', 'k2026-10': 'materi-kunci-rotasi-oktober-2026' },
  });
  const sealedByOldKey = await withPepper('p-lookup', () =>
    withKeyring(KEYRING_2026_10, () => sealAtRest('user-abc'))
  );

  await withPepper('p-lookup', () => withKeyring(KEYRING_2026_11, async () => {
    const candidates = await sealedLookupCandidates('user-abc');
    assert.equal(candidates.length, 3, 'satu kandidat per kunci ring (2 operator + legacy)');
    assert.equal(candidates[0], await sealAtRest('user-abc'), 'kandidat pertama = tulisan baru');
    assert.ok(candidates.includes(sealedByOldKey), 'baris era kunci sebelumnya tetap ditemukan');
    assert.equal(new Set(candidates).size, candidates.length, 'tidak ada duplikat');
    assert.deepEqual(
      await Promise.all(candidates.map((candidate) => openAtRest(candidate))),
      ['user-abc', 'user-abc', 'user-abc'],
      'baris lama dan baru sama-sama menemukan user yang sama'
    );
  }));

  await withPepper('p-lookup', () => withKeyring(undefined, async () => {
    const candidates = await sealedLookupCandidates('user-abc');
    assert.equal(candidates.length, 1, 'tanpa key ring hanya satu kandidat (perilaku lama)');
  }));
});

test('[P6] fail-closed: key id tak dikenal / key ring rusak', async () => {
  await withPepper('p-fail', () => withKeyring(KEYRING_2026_11, async () => {
    // Envelope dari kunci yang tidak ada di ring (mis. operator menghapus kunci
    // lama sebelum re-seal) → null, bukan tebakan/plaintext.
    const orphan = `${AT_REST_ENVELOPE_V2}:k-hilang:${Buffer.from('x'.repeat(40)).toString('base64url')}`;
    assert.equal(sealedKeyId(orphan), 'k-hilang');
    assert.equal(await openAtRest(orphan), null, 'key id tak dikenal = gagal baca terlihat');
    assert.equal(await openAtRest(`${AT_REST_ENVELOPE_V2}:k2026-11:!!bukan-base64!!`), null);
  }));

  const broken = [
    'bukan-json',
    JSON.stringify({ active: 'k1' }),
    JSON.stringify({ active: 'k1', keys: {} }),
    JSON.stringify({ active: 'k2', keys: { k1: 'materi-kunci-yang-cukup-panjang' } }),
    JSON.stringify({ active: '0', keys: { k1: 'materi-kunci-yang-cukup-panjang' } }),
    JSON.stringify({ active: 'k1', keys: { '0': 'materi-kunci-yang-cukup-panjang' } }),
    JSON.stringify({ active: 'k1', keys: { k1: 'pendek' } }),
  ];
  for (const keyring of broken) {
    await withPepper('p-fail', () => withKeyring(keyring, async () => {
      assert.throws(() => getAtRestKeyring(), /NYX_AT_REST_KEYRING/, `harus menolak: ${keyring}`);
    }));
  }
});

test('[P6] key ring dari file custody (NYX_AT_REST_KEYRING_FILE)', async () => {
  const file = path.join(here, 'tmp-keyring-at-rest.json');
  writeFileSync(file, KEYRING_2026_11, { mode: 0o600 });
  try {
    await withPepper('p-file', async () => {
      const prev = process.env.NYX_AT_REST_KEYRING;
      delete process.env.NYX_AT_REST_KEYRING;
      process.env.NYX_AT_REST_KEYRING_FILE = file;
      clearAtRestSecretCacheForTests();
      try {
        const sealed = await sealAtRest('nilai-dari-file');
        assert.match(sealed, /^ENC2:k2026-11:/);
        assert.equal(await openAtRest(sealed), 'nilai-dari-file');
        assert.equal(atRestStatus().custody.provider, 'file');
        assert.equal(atRestStatus().custody.source, file);
      } finally {
        if (prev === undefined) delete process.env.NYX_AT_REST_KEYRING;
        else process.env.NYX_AT_REST_KEYRING = prev;
        delete process.env.NYX_AT_REST_KEYRING_FILE;
        clearAtRestSecretCacheForTests();
      }
    });
  } finally {
    unlinkSync(file);
  }
});

test('contract: pepper produksi wajib env, bukan turunan DB', () => {
  const src = read('../src/utils/atRestSecrets.ts');
  assert.match(src, /NYX_AT_REST_PEPPER/, 'nama env pepper terkunci');
  assert.match(src, /env\.nodeEnv === 'production'[\s\S]*throw new Error/, 'production tanpa pepper = fail-closed');
  assert.doesNotMatch(src, /prisma/i, 'helper ini TIDAK boleh menyentuh DB (kalau tidak, pepper bocor lewat dump)');

  // Provider yang di-assert bergantung mode proses — dan mode itu datang dari
  // `.env` yang di-load `config.ts` (mesin dev self-host bisa memakai
  // NODE_ENV=production yang terisi). Meng-assert cabang dev di lingkungan
  // produksi hanyalah test yang bohong; yang dikunci adalah **cabang yang benar
  // untuk mode yang sedang berjalan**.
  const prev = process.env.NYX_AT_REST_PEPPER;
  delete process.env.NYX_AT_REST_PEPPER;
  clearAtRestSecretCacheForTests();
  try {
    if (env.nodeEnv === 'production') {
      assert.throws(
        () => getAtRestPepper(),
        /NYX_AT_REST_PEPPER/,
        'production tanpa pepper = fail-closed (bukan pepper turunan dev)'
      );
    } else {
      assert.equal(typeof getAtRestPepper(), 'string', 'non-production: fallback dev agar onboarding tidak putus');
    }
  } finally {
    if (prev !== undefined) process.env.NYX_AT_REST_PEPPER = prev;
    clearAtRestSecretCacheForTests();
  }
});
