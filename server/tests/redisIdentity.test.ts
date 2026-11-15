// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 0.7 / 1.5 — D14] Redis sebagai artefak setara dump.
 *
 * Redis persisten (AOF) memuat banyak kolom yang dulu berupa **userId asli**:
 * `online_users`, `active_device:*`, `cache:keys:*`, key rate-limit, nilai
 * `linking_token:*`, dan member `burner:room:*`. Test ini mengunci dua janji:
 *
 *  (a) helper identitas — tag satu-arah untuk yang hanya dibandingkan, seal
 *      deterministik untuk yang harus dipulihkan (tanpa toleransi plaintext);
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
import { handleKeySync, type RealtimeContext } from '../src/network/realtimeHandlers.js';
import {
  identityKey,
  identityMatches,
  identityTag,
  openIdentity,
  openIdentityMembers,
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
    assert.notEqual(identityKey('active_device', 'user-9'), identityKey('rate_limit:chat', 'user-9'), 'base beda → key beda');
  });
});

test('sealIdentity/openIdentity: roundtrip; plaintext tidak pernah dikenali', async () => {
  await withPepper('p-redis', async () => {
    const sealed = await sealIdentity('user-42');
    assert.equal(await openIdentity(sealed), 'user-42', 'member ter-seal bisa dibuka (routing)');
    assert.notEqual(sealed, 'user-42', 'member tidak plaintext');

    assert.equal(await openIdentity('user-plaintext'), null, 'nilai plaintext → null (tidak dikenali)');
    assert.equal(await openIdentity(null), null);
  });
});

test('openIdentityMembers: buka ter-seal, buang plaintext & kosong', async () => {
  await withPepper('p-redis', async () => {
    const sealedA = await sealIdentity('a');
    const sealedB = await sealIdentity('b');
    const resolved = await openIdentityMembers([sealedA, 'plaintext', sealedB, '']);
    assert.deepEqual(resolved, ['a', 'b']);
  });
});

test('identityMatches: hanya cocok dengan nilai ter-seal yang sama', async () => {
  await withPepper('p-redis', async () => {
    const sealed = await sealIdentity('owner-1');
    assert.equal(await identityMatches(sealed, 'owner-1'), true, 'nilai ter-seal cocok');
    assert.equal(await identityMatches('owner-1', 'owner-1'), false, 'plaintext tidak lagi cocok');
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

// ============================================================================
// [D6 2026-10-27] Wiring yang diuji lewat PERILAKU, bukan teks sumber
// ============================================================================
//
// Dulu bagian ini mencocokkan literal seperti
// ``sealedMember: await sealIdentity(userId)`` dan `sAdd(\`burner:room:${roomId}\`)`
// di dalam sumber. Dua kelemahannya: refactor setara (mis. mengekstrak helper)
// memerahkan test tanpa perubahan perilaku, dan perubahan perilaku lolos selama
// potongan teks itu masih ada di suatu tempat. Sekarang jalur tulis yang nyata
// dijalankan dengan Redis palsu yang mencatat setiap perintah, lalu nilai yang
// ditulis dibuka kembali — buktinya bukan "kodenya berbunyi begini", melainkan
// "dump Redis berisi ciphertext yang hanya bisa dipetakan dengan pepper".

interface RedisWrite {
  op: string;
  key: string;
  value?: string;
  opts?: unknown;
}

/** RealtimeContext minimal + Redis yang mencatat semua tulis. */
function makeRecordingCtx(): { ctx: RealtimeContext; writes: RedisWrite[] } {
  const writes: RedisWrite[] = [];
  const sets = new Map<string, Set<string>>();

  const ctx = {
    sendToUser: async () => {},
    sendToDevice: async () => {},
    broadcastToUsers: async () => {},
    sendJsonToUser: async () => {},
    checkRateLimit: async () => true,
    isActiveDeviceAllowed: async () => true,
    prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => ({}) }) }),
    redisClient: new Proxy({}, {
      get: (_t, method: string) => {
        if (method === 'set') {
          return async (key: string, value: string, opts?: unknown) => {
            writes.push({ op: 'set', key, value, opts });
            return 'OK';
          };
        }
        if (method === 'setEx') {
          return async (key: string, ttl: number, value: string) => {
            writes.push({ op: 'setEx', key, value, opts: ttl });
            return 'OK';
          };
        }
        if (method === 'exists') return async () => 0;
        if (method === 'get') return async () => null;
        if (method === 'del') return async () => 1;
        return async () => undefined;
      },
    }),
    pubClient: new Proxy({}, {
      get: (_t, method: string) => {
        if (method === 'sAdd') {
          return async (key: string, member: string) => {
            writes.push({ op: 'sAdd', key, value: member });
            const set = sets.get(key) ?? new Set<string>();
            set.add(member);
            sets.set(key, set);
            return 1;
          };
        }
        if (method === 'sMembers') return async (key: string) => [...(sets.get(key) ?? [])];
        if (method === 'expire') {
          return async (key: string, seconds: number) => {
            writes.push({ op: 'expire', key, value: String(seconds) });
            return true;
          };
        }
        if (method === 'sRem') return async () => 1;
        if (method === 'del') return async () => 1;
        return async () => undefined;
      },
    }),
  } as unknown as RealtimeContext;

  return { ctx, writes };
}

test('D14 perilaku: join burner menulis member TER-SEAL, index memakai TAG', async () => {
  await withPepper('p-redis', async () => {
    const { ctx, writes } = makeRecordingCtx();

    await handleKeySync(ctx, 'user-77', 'dev-1', { event: 'burner:join', msgId: 'b', data: { roomId: 'burner_abc' } });

    const memberWrites = writes.filter(
      (w) => w.op === 'sAdd' && w.key.startsWith('burner:room:')
    );
    assert.equal(memberWrites.length, 1, 'satu join burner');
    for (const write of memberWrites) {
      assert.notEqual(write.value, 'user-77', 'member harus ciphertext, bukan userId');
      assert.equal(await openIdentity(write.value ?? null), 'user-77', 'routing masih bisa memetakan member');
    }

    const indexWrites = writes.filter((w) => w.op === 'sAdd' && w.key.startsWith('room:member:'));
    assert.equal(indexWrites.length, 1, 'index per-user dicatat untuk pembersihan disconnect');
    for (const write of indexWrites) {
      assert.doesNotMatch(write.key, /user-77/, 'index di-key TAG, bukan userId');
      assert.equal(write.key, `room:member:${identityTag('user-77')}`);
    }
  });
});

test('D14 perilaku: linking_token menyimpan {userId, deviceId} TER-SEAL', async () => {
  await withPepper('p-redis', async () => {
    const { ctx, writes } = makeRecordingCtx();

    await handleKeySync(ctx, 'user-99', 'dev-3', { event: 'auth:request_linking_qr', msgId: 'q', data: {} });

    const token = writes.find((w) => w.op === 'setEx' && w.key.startsWith('linking_token:'));
    assert.ok(token, 'token dilahirkan');
    assert.doesNotMatch(token!.key, /user-99/);
    assert.notEqual(token!.opts, undefined, 'memakai TTL');
    assert.doesNotMatch(token!.value ?? '', /user-99/, 'nilai tidak plaintext');
    assert.deepEqual(
      JSON.parse((await openIdentity(token!.value ?? null)) ?? 'null'),
      { userId: 'user-99', deviceId: 'dev-3' },
      'redeemer bisa memulihkan identitas dari ciphertext'
    );
  });
});

// ============================================================================
// [statis] Invariant yang tidak bisa diamati dari perilaku
// ============================================================================
//
// Tiga kelas di bawah ini tetap dipindai dari sumber, dan itu disengaja:
//   • "tidak ada template literal userId di key identitas" — properti tentang
//     SELURUH berkas, termasuk jalur yang tidak bisa dipanggil unit test (butuh
//     Postgres/Redis nyata);
//   • satu bug sejarah (`identityKey` tertutup oleh destructuring req.body)
//     yang bentuk regresinya hanya terlihat di teks;
//   • "disconnect tidak memindai keyspace" — properti absen.
// Perilaku jalur tulisnya sendiri sudah diuji di atas dan di roomMembership.test.ts.

test('D14 statis: key identitas memakai helper, bukan template literal userId', () => {
  const files = [
    '../src/network/redisBridge.ts',
    '../src/network/realtimeHandlers.ts',
    '../src/routes/auth.ts',
    '../src/routes/keys.ts',
    '../src/routes/users.ts',
    '../src/utils/redisResilience.ts',
  ];

  const joined = files.map((f) => read(f)).join('\n');

  assert.doesNotMatch(joined, /active_device:\$\{/, 'active_device memakai identityKey');
  assert.doesNotMatch(joined, /cache:keys:[a-z]+:\$\{/, 'cache:keys memakai identityKey');
  assert.doesNotMatch(joined, /rate_limit:[^`'"]*\$\{userId\}/, 'rate_limit memakai identityKey');

  for (const f of files) {
    const src = read(f);
    if (/active_device/.test(src)) {
      assert.match(src, /identityKey\(/, `${f}: key identitas via identityKey`);
    }
    assert.doesNotMatch(src, /sAdd\('online_users', userId\)/, `${f}: online_users memakai tag`);
  }
});

test('D14 statis: routes/keys.ts tidak menutupi helper identityKey + invalidasi memakai helper', () => {
  // [BUGFIX 2026-10-09] `routes/keys.ts` pernah men-destructure `identityKey`
  // dari `req.body` → MENUTUPI helper → `identityKey('cache:keys:…', userId)`
  // melempar "identityKey is not a function" (tertangkap try/catch, hanya
  // console.error) sehingga cache pre-key TIDAK pernah di-invalidate: peer
  // menerima bundle basi sampai TTL 1 jam habis.
  const keys = read('../src/routes/keys.ts');
  assert.doesNotMatch(
    keys,
    /const\s*\{[^}]*\bidentityKey\s*[,}][^}]*\}\s*=\s*req\.body/,
    'routes/keys.ts: jangan mengikat nama `identityKey` langsung dari req.body (menutupi helper)'
  );
  assert.match(keys, /identityKey: identityKeyB64/, 'field body identityKey di-alias agar tidak menutupi helper');
  assert.equal(
    (keys.match(/redisClient\.del\(identityKey\(/g) || []).length,
    2,
    'invalidate cache pre-key memakai helper identityKey() (bundle + public)'
  );
});

test('D14 statis: disconnect memakai index per-user, bukan SCAN keyspace', () => {
  const bridge = read('../src/network/redisBridge.ts');
  assert.match(bridge, /sealIdentity\(userId\)/, 'cleanup disconnect menyamakan member ter-seal');
  assert.match(bridge, /leaveAllRooms\(/, 'cleanup disconnect memakai index per-user');
  assert.doesNotMatch(bridge, /SCAN.*burner:room/, 'cleanup disconnect tidak lagi memindai keyspace');
});
