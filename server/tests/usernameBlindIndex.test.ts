// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0 — D6] Blind index username.
 *
 * Masalah lama: `User.usernameHash` = Argon2id(username, salt STATIS
 * "NYX_BLIND_IDX_V1") dengan parameter yang ada di bundel klien (publik).
 * Dump DB + kamus username → deanonymisasi (satu rainbow table berlaku global).
 *
 * Solusi: nilai klien di-index lagi dengan HMAC pepper dari env
 * (`pepperedIdentifier`) sebelum disimpan, dan semua lookup memakai kandidat
 * [ter-pepper, apa adanya] supaya baris legacy + nilai yang di-echo klien tetap
 * bekerja. Test ini mengunci (a) properti privasinya, (b) wiring-nya.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  clearAtRestSecretCacheForTests,
  identifierLookupCandidates,
  pepperedIdentifier,
} from '../src/utils/atRestSecrets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

/** Tiruan blind index klien: Argon2id dengan salt statis (deterministik). */
const clientArgon = (username: string) =>
  createHash('sha256').update(`NYX_BLIND_IDX_V1:${username.toLowerCase()}`).digest('base64url');

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

test('D6: dump DB tanpa pepper tidak bisa dienumerasi dengan kamus username', async () => {
  const dictionary = ['alice', 'bob', 'carol', 'han', 'ken', 'admin'];

  // Simulasi server: menyimpan index ter-pepper untuk satu akun.
  const stored = await withPepper('pepper-produksi-rahasia', () =>
    pepperedIdentifier(clientArgon('han'))
  );

  // Simulasi attacker A1: punya dump (stored) + kamus + semua parameter Argon2
  // klien (publik), tapi TIDAK punya pepper.
  const attackerTable = await withPepper('pepper-tebakan', async () => {
    const map = new Map<string, string>();
    for (const candidate of dictionary) {
      map.set(pepperedIdentifier(clientArgon(candidate)), candidate);
    }
    return map;
  });

  assert.equal(attackerTable.get(stored), undefined, 'kamus tanpa pepper tidak menemukan username');
  assert.notEqual(stored, clientArgon('han'), 'nilai mentah klien tidak pernah tersimpan');
});

test('D6: lookup tetap deterministik dengan pepper yang sama (login tidak rusak)', async () => {
  const clientValue = clientArgon('Han'); // klien meng-lowercase sebelum hash
  const a = await withPepper('p', () => pepperedIdentifier(clientValue));
  const b = await withPepper('p', () => pepperedIdentifier(clientValue));
  assert.equal(a, b, 'identifier sama → index sama → lookup by equality tetap jalan');
});

test('D6: baris legacy & echo klien tetap ketemu lewat kandidat lookup', async () => {
  const clientValue = clientArgon('legacy-user');
  const candidates = await withPepper('p', () => identifierLookupCandidates(clientValue));

  assert.equal(candidates[0], await withPepper('p', () => pepperedIdentifier(clientValue)));
  assert.equal(candidates[1], clientValue, 'kandidat kedua = nilai Argon2id mentah (baris legacy / echo)');
  assert.equal(candidates.length, 2, 'tidak ada kandidat lain (query tetap minimal)');
});

test('D6 wiring: register menyimpan ter-pepper, login/recovery/search pakai kandidat', () => {
  const auth = read('../src/routes/auth.ts');
  const users = read('../src/routes/users.ts');
  const engine = read('../src/routes/engine.ts');

  assert.match(auth, /usernameHash: pepperedIdentifier\(usernameHash\)/, 'register menyimpan index ter-pepper');
  assert.equal(
    (auth.match(/where: \{ usernameHash: \{ in: identifierLookupCandidates\(usernameHash\) \} \}/g) || []).length,
    3,
    'login + recovery-verify + existence-check register memakai kandidat (3 situs)'
  );
  assert.doesNotMatch(
    auth,
    /where: \{ usernameHash \}/,
    'tidak boleh ada lookup langsung dengan identifier mentah (regresi D6)'
  );

  assert.match(auth, /recover_nonce:\$\{pepperedIdentifier\(identifier\)\}/, 'nonce recovery di-key oleh index ter-pepper');
  assert.match(auth, /for \(const candidate of identifierLookupCandidates\(usernameHash\)\)/, 'verify menerima bentuk legacy/echo');

  assert.match(users, /where: \{ usernameHash: \{ in: identifierLookupCandidates\(q\) \} \}/, 'pencarian user memakai kandidat');
  assert.match(users, /q\.length === 64 && \/\^\[a-f0-9\]\{64\}\$\//, 'isExactHash menerima bentuk 64-hex ter-index');
  assert.match(engine, /const usernameHash = pepperedIdentifier\(/, 'user B2B (engine) ikut ter-pepper');
});

test('D6 wiring: client tetap mengirim Argon2id (server yang men-pepper) — tanpa perubahan klien', () => {
  const register = read('../../web/src/pages/Register.tsx');
  const login = read('../../web/src/pages/Login.tsx');
  assert.match(register, /const usernameHash = await hashUsername\(username\)/, 'klien masih meng-hash username lokal');
  assert.match(login, /const usernameHash = await hashUsername\(data\.a\)/, 'login klien tidak berubah');
  assert.doesNotMatch(register, /pepper|HMAC/i, 'klien TIDAK pernah memegang pepper (server-side only)');
});
