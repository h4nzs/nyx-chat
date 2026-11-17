// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.2 T4–T7] Disiplin transit P1.
 *
 * Aturannya sumber-level karena yang dijaga adalah KONFIGURASI, bukan hasil
 * satu request: header fingerprint yang tidak dipasang, log yang tidak memuat
 * userId, kompresi yang tidak menyentuh /api, dan urutan transport TURN.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(path.join(here, ...parts), 'utf8');

const app = () => read('../src/app.ts');

test('T4: header fingerprint stack tidak dipasang Express maupun nginx', () => {
  const server = app();
  for (const header of ['X-Edge-Relay', 'X-Sec-Protocol', 'X-Powered-By']) {
    assert.doesNotMatch(
      server,
      new RegExp(`res\\.setHeader\\('${header}'`),
      `${header} tidak boleh diset Express`
    );
  }
  assert.match(server, /app\.disable\('x-powered-by'\)/, 'Express tetap mematikan default');

  const nginx = read('../../ops/nginx/nyx.conf');
  for (const header of ['X-Edge-Relay', 'X-Sec-Protocol', 'X-Powered-By']) {
    assert.doesNotMatch(
      nginx,
      new RegExp(`add_header ${header}`),
      `${header} tidak boleh diset nginx`
    );
  }
});

test('T5: log gateway & Redis memakai identityTag, bukan userId mentah', () => {
  const gateway = read('../src/realtime/gateway.ts');
  assert.match(gateway, /Handler \$\{event\} gagal untuk user \$\{identityTag\(userId\)\}/);
  assert.doesNotMatch(gateway, /console\.error\([^\n]*user \$\{userId\}/, 'tidak ada userId mentah');

  const bridge = read('../src/network/redisBridge.ts');
  assert.doesNotMatch(
    bridge,
    /console\.(?:warn|error)\([^\n]*\$\{userId\}/,
    'semua log yang menyebut user memakai tag'
  );
  assert.doesNotMatch(
    bridge,
    /Error processing upstream message:', error/,
    'objek error dari payload upstream tidak dicetak'
  );
  assert.match(bridge, /Upstream message gagal diproses \(op \$\{relayOpLabel\(channel\)\}\)/);
  assert.match(bridge, /console\.(?:warn|error)\([^\n]*identityTag\(userId\)/);

  const subscriptions = read('../src/routes/subscriptions.ts');
  assert.doesNotMatch(subscriptions, /console\.log\([^\n]*\$\{userId\}/);
  assert.match(subscriptions, /identityTag\(userId\)/);

  const users = read('../src/routes/users.ts');
  assert.match(users, /Subscription expired for user \$\{identityTag\(userId\)\}/);
});

test('T6: /api tidak dikompres (BREACH), aset statis tetap', () => {
  const server = app();
  assert.doesNotMatch(server, /app\.use\(compression\(\)\)/, 'tidak ada kompresi global tanpa filter');
  assert.match(server, /compression\(\{/, 'kompresi memakai filter');
  assert.match(server, /!req\.path\.startsWith\('\/api'\)\s*&&\s*compression\.filter\(req, res\)/);
});

test('T7: contoh TURN mendahulukan turns: dan mencatat residual coturn', () => {
  const envExample = read('../../.env.example');
  const line = envExample.match(/^TURN_URLS=(.*)$/m)?.[1] ?? '';
  assert.ok(line.startsWith('turns:'), 'TLS didahulukan');
  assert.ok(
    line.indexOf('turns:') < line.indexOf('turn:'),
    'UDP plaintext tidak boleh lebih dulu'
  );
  assert.match(envExample, /Coturn tetap melihat IP peer/, 'residual didokumentasikan');
});
