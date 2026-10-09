// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0.7 / 1.5 — D14] Redis sebagai artefak setara dump.
 *
 * Redis persisten (AOF) memuat banyak kolom yang dulu berupa **userId asli**:
 * `online_users`, `active_device:*`, `is_migrating:*`, `cache:keys:*`, key
 * rate-limit, nilai `linking_token:*`, dan member `burner:room:*` /
 * `migration:room:*`. Test ini mengunci dua janji:
 *
 *  (a) helper identitas — tag satu-arah untuk yang hanya dibandingkan, seal
 *      deterministik untuk yang harus dipulihkan, plus toleransi baris legacy;
 *  (b) wiring — tidak ada jalur tulis Redis yang kembali memakai userId asli.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  clearAtRestSecretCacheForTests,
  pepperedIdentifier,
  sealAtRest,
} from '../src/utils/atRestSecrets.js';
import {
  identityKey,
  identityMatches,
  identityTag,
  openIdentity,
  openIdentityMembers,
  openIdentityOrRaw,
  sealIdentity,
} from '../src/utils/redisIdentity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

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

test('identityTag: deterministik, domain-separated, tidak memuat userId', async () => {
  await withPepper('p-redis', () => {
    const tag = identityTag('user-123');
    assert.equal(tag, identityTag('user-123'), 'nilai sama → tag sama (SET membership bekerja)');
    assert.notEqual(tag, identityTag('user-124'), 'nilai beda → tag beda');
    assert.equal(tag, pepperedIdentifier('redis:v1:user-123'), 'domain terpisah dari blind index lain');
    assert.doesNotMatch(tag, /user-123/, 'userId asli tidak muncul di tag');
  });
});

test('identityKey: sufiks key adalah tag, bukan userId', async () => {
  await withPepper('p-redis', () => {
    const key = identityKey('active_device', 'user-9');
    assert.equal(key, `active_device:${identityTag('user-9')}`);
    assert.doesNotMatch(key, /user-9/, 'dump Redis tidak bisa memetakan key ke user');
    assert.notEqual(identityKey('active_device', 'user-9'), identityKey('is_migrating', 'user-9'), 'base beda → key beda');
  });
});

test('sealIdentity/openIdentity: roundtrip + toleransi legacy', async () => {
  await withPepper('p-redis', async () => {
    const sealed = await sealIdentity('user-42');
    assert.equal(await openIdentity(sealed), 'user-42', 'member ter-seal bisa dibuka (routing)');
    assert.notEqual(sealed, 'user-42', 'member tidak plaintext');

    assert.equal(await openIdentity('user-legacy'), null, 'plaintext legacy → null (bukan nilai palsu)');
    assert.equal(await openIdentityOrRaw('user-legacy'), 'user-legacy', 'toleransi legacy: nilai apa adanya');
    assert.equal(await openIdentity(null), null);
  });
});

test('openIdentityMembers: buka ter-seal, lewati legacy, buang kosong', async () => {
  await withPepper('p-redis', async () => {
    const sealedA = await sealIdentity('a');
    const sealedB = await sealIdentity('b');
    const resolved = await openIdentityMembers([sealedA, 'legacy', sealedB, '']);
    assert.deepEqual(resolved, ['a', 'legacy', 'b']);
  });
});

test('identityMatches: cocokkan ter-seal, baris legacy, dan tolak yang lain', async () => {
  await withPepper('p-redis', async () => {
    const sealed = await sealIdentity('owner-1');
    assert.equal(await identityMatches(sealed, 'owner-1'), true, 'nilai ter-seal cocok');
    assert.equal(await identityMatches('owner-1', 'owner-1'), true, 'baris legacy plaintext cocok');
    assert.equal(await identityMatches(sealed, 'owner-2'), false, 'user lain ditolak');
    assert.equal(await identityMatches(null, 'owner-1'), false, 'kosong → tidak cocok');
  });
});

test('sealIdentity tidak terbaca tanpa pepper yang benar (attacker A1)', async () => {
  const sealed = await withPepper('pepper-produksi', () => sealAtRest('victim-user'));
  await withPepper('pepper-attacker', async () => {
    assert.equal(await openIdentity(sealed), null, 'tanpa pepper yang benar, member tidak bisa dipetakan');
  });
});

test('D14 wiring: tidak ada jalur tulis Redis yang memakai userId asli', () => {
  const files = [
    '../src/network/redisBridge.ts',
    '../src/network/realtimeHandlers.ts',
    '../src/routes/auth.ts',
    '../src/routes/keys.ts',
    '../src/routes/users.ts',
    '../src/utils/redisResilience.ts',
  ];

  const joined = files.map((f) => read(f)).join('\n');

  // Key berbasis identitas harus lewat helper, bukan template literal userId.
  assert.doesNotMatch(joined, /active_device:\$\{/, 'active_device memakai identityKey');
  assert.doesNotMatch(joined, /is_migrating:\$\{/, 'is_migrating memakai identityKey');
  assert.doesNotMatch(joined, /cache:keys:[a-z]+:\$\{/, 'cache:keys memakai identityKey');
  assert.doesNotMatch(joined, /rate_limit:[^`'"]*\$\{userId\}/, 'rate_limit memakai identityKey');

  for (const f of files) {
    const src = read(f);
    if (/active_device|is_migrating/.test(src)) {
      assert.match(src, /identityKey\(/, `${f}: key identitas via identityKey`);
    }
    assert.doesNotMatch(src, /sAdd\('online_users', userId\)/, `${f}: online_users memakai tag`);
  }

  const bridge = read('../src/network/redisBridge.ts');
  const handlers = read('../src/network/realtimeHandlers.ts');

  // Member SET yang dipakai sebagai target kirim = seal deterministik.
  assert.match(handlers, /sAdd\(`burner:room:\$\{roomId\}`, await sealIdentity\(userId\)\)/, 'burner:room memakai member ter-seal');
  assert.match(handlers, /sAdd\(`migration:room:\$\{data\}`, await sealIdentity\(userId\)\)/, 'migration:room memakai member ter-seal');
  assert.match(handlers, /`migration_owner:\$\{roomId\}`, await sealIdentity\(userId\)/, 'migration_owner ter-seal');
  assert.match(bridge, /sealIdentity\(userId\)/, 'cleanup disconnect menyamakan member ter-seal');

  // Nilai linking_token memuat identitas → disimpan sebagai ciphertext.
  assert.match(
    handlers,
    /await sealAtRest\(JSON\.stringify\(\{ userId, deviceId \}\)\)/,
    'linking_token memuat identitas ter-seal'
  );
  // Pembaca harus bisa membuka (dengan toleransi legacy).
  assert.match(handlers, /openIdentityMembers\(/, 'redeem burner/migration membuka member ter-seal');
  assert.match(handlers, /identityMatches\(/, 'migration_owner dibandingkan via helper');
});
