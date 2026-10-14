// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(1)] Kredensial coturn — diuji sebagai **perilaku**
 * (klok disuntik), bukan regex atas source.
 *
 * Properti yang dikunci:
 *   1. Username mengikuti konvensi coturn `<unixExpiry>:<userid>` dan credential
 *      = base64(HMAC-SHA1(secret, username)) — bisa diverifikasi ulang seperti
 *      yang dilakukan coturn.
 *   2. TTL dijepit ke rentang sah; nilai tak sah tidak melemahkan/memanjangkan.
 *   3. `TURN_URLS` hanya meloloskan skema `turn:`/`turns:` dan dideduplikasi.
 *   4. Identitas di username adalah tag yang diberikan (identityTag), sehingga
 *      userId mentah tidak pernah muncul.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  DEFAULT_TURN_TTL_SECONDS,
  MAX_TURN_TTL_SECONDS,
  MIN_TURN_TTL_SECONDS,
  buildTurnIceServers,
  clampTurnTtl,
  isCoturnConfigured,
  mintTurnCredential,
  parseTurnUrls,
} from '../src/utils/turnCredentials.js';

const SECRET = 'coturn-static-auth-secret-yang-panjang';

/** Verifikasi ulang seperti coturn: base64(HMAC-SHA1(secret, username)). */
function coturnExpectedCredential(secret: string, username: string): string {
  return createHmac('sha1', secret).update(username).digest('base64');
}

test('mintTurnCredential: username <expiry>:<tag> & credential HMAC-SHA1 base64', () => {
  const cred = mintTurnCredential({
    secret: SECRET,
    identityTag: 'tag-abc123',
    ttlSeconds: 600,
    nowSeconds: 1_700_000_000,
  });

  assert.equal(cred.expiresAt, 1_700_000_600);
  assert.equal(cred.username, '1700000600:tag-abc123');
  assert.equal(cred.credential, coturnExpectedCredential(SECRET, cred.username));
  assert.equal(cred.ttlSeconds, 600);
});

test('mintTurnCredential: userId mentah tidak pernah masuk username', () => {
  const userId = 'user-uuid-yang-harusnya-tidak-muncul';
  const cred = mintTurnCredential({ secret: SECRET, identityTag: 'HASHED_TAG', nowSeconds: 1 });
  assert.ok(!cred.username.includes(userId));
  assert.ok(cred.username.endsWith(':HASHED_TAG'));
});

test('mintTurnCredential: secret/tag kosong ditolak (fail-closed)', () => {
  assert.throws(() => mintTurnCredential({ secret: '', identityTag: 'tag' }));
  assert.throws(() => mintTurnCredential({ secret: SECRET, identityTag: '' }));
});

test('clampTurnTtl menjepit ke rentang sah dan default untuk nilai tak sah', () => {
  assert.equal(clampTurnTtl(undefined), DEFAULT_TURN_TTL_SECONDS);
  assert.equal(clampTurnTtl(null), DEFAULT_TURN_TTL_SECONDS);
  assert.equal(clampTurnTtl(Number.NaN), DEFAULT_TURN_TTL_SECONDS);
  assert.equal(clampTurnTtl(10), MIN_TURN_TTL_SECONDS);
  assert.equal(clampTurnTtl(600), 600);
  assert.equal(clampTurnTtl(10 * MAX_TURN_TTL_SECONDS), MAX_TURN_TTL_SECONDS);
  // TTL hasil jepitan inilah yang dipakai username.
  const cred = mintTurnCredential({ secret: SECRET, identityTag: 't', ttlSeconds: 5, nowSeconds: 0 });
  assert.equal(cred.expiresAt, MIN_TURN_TTL_SECONDS);
});

test('parseTurnUrls: hanya turn/turns, trim, dedup, buang sampah', () => {
  const urls = parseTurnUrls(
    'turn:turn.nyx-app.my.id:3478?transport=udp, turns:turn.nyx-app.my.id:5349\n' +
      'turn:turn.nyx-app.my.id:3478?transport=udp, https://salah.tempel, stun:stun.nyx-app.my.id:3478'
  );
  assert.deepEqual(urls, [
    'turn:turn.nyx-app.my.id:3478?transport=udp',
    'turns:turn.nyx-app.my.id:5349',
  ]);
  assert.deepEqual(parseTurnUrls(undefined), []);
  assert.deepEqual(parseTurnUrls(''), []);
});

test('isCoturnConfigured butuh secret DAN minimal satu URL', () => {
  assert.equal(isCoturnConfigured(SECRET, ['turn:x:3478']), true);
  assert.equal(isCoturnConfigured(undefined, ['turn:x:3478']), false);
  assert.equal(isCoturnConfigured('', ['turn:x:3478']), false);
  assert.equal(isCoturnConfigured(SECRET, []), false);
});

test('buildTurnIceServers: satu entri multi-URL, urls kosong → tanpa entri', () => {
  const cred = mintTurnCredential({ secret: SECRET, identityTag: 't', ttlSeconds: 600, nowSeconds: 100 });
  const servers = buildTurnIceServers(['turn:a:3478', 'turns:a:5349'], cred);
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0]!.urls, ['turn:a:3478', 'turns:a:5349']);
  assert.equal(servers[0]!.username, cred.username);
  assert.equal(servers[0]!.credential, cred.credential);
  assert.deepEqual(buildTurnIceServers([], cred), []);
});
