// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.7 — Fase 6] Bank token + jalur redeem anonim.
 *
 * Yang dikunci:
 *  - bentuk token/ticket + prefiksnya berbeda (klien bisa membedakan tanpa
 *    menebak), dan token tidak pernah disimpan plaintext (key = SHA-256);
 *  - kuota harian bank token (1 token = 1 issuance);
 *  - router anonim TIDAK memakai requireAuth global, sementara bank token
 *    terautentikasi;
 *  - konsumsi memakai Lua GET+DEL (replay kalah), bukan GET lalu DEL terpisah;
 *  - CSRF hanya dikecualikan untuk dua path redeem, bukan seluruh `/api/credentials`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  COMMIT_TICKET_PREFIX,
  CREDENTIAL_CONSUME_LUA,
  CREDENTIAL_INCRBY_LUA,
  CREDENTIAL_TOKENS_PER_DAY_MAX,
  CREDENTIAL_TOKEN_PREFIX,
  commitTicketKey,
  credentialTokenHash,
  credentialTokenKey,
  credentialTokenQuotaKey,
  exceedsTokenQuota,
  generateCommitTicket,
  generateCredentialToken,
  isCommitTicket,
  isCredentialToken,
} from '../src/utils/credentialTokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

test('[docs/35 Fase 6] token & ticket: bentuk, prefiks, dan unik', () => {
  const tokens = Array.from({ length: 50 }, () => generateCredentialToken());
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^nct1_[A-Za-z0-9_-]{43}$/);
    assert.equal(isCredentialToken(token), true);
    assert.equal(isCommitTicket(token), false, 'prefiks membedakan token vs ticket');
  }

  const ticket = generateCommitTicket();
  assert.match(ticket, /^cct1_[A-Za-z0-9_-]{43}$/);
  assert.equal(isCommitTicket(ticket), true);
  assert.equal(isCredentialToken(ticket), false);

  assert.equal(isCredentialToken(`${CREDENTIAL_TOKEN_PREFIX}${'A'.repeat(42)}`), false);
  assert.equal(isCredentialToken(`${CREDENTIAL_TOKEN_PREFIX}${'A'.repeat(44)}`), false);
  assert.equal(isCredentialToken('nct1_' + 'A'.repeat(42) + '!'), false);
  assert.equal(isCredentialToken(undefined), false);
  assert.equal(isCommitTicket(null), false);
});

test('[docs/35 Fase 6] token tidak pernah disimpan plaintext (key = SHA-256)', () => {
  const token = generateCredentialToken();
  const hash = credentialTokenHash(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(credentialTokenKey(token), `cred:token:${hash}`);
  assert.equal(credentialTokenKey(token).includes(token), false, 'token asli tidak boleh muncul di key Redis');
  assert.equal(commitTicketKey(generateCommitTicket()).startsWith('cred:ticket:'), true);
});

test('[docs/35 Fase 6] kuota bank token: maksimum 5/hari, NaN fail-open', () => {
  assert.equal(exceedsTokenQuota(CREDENTIAL_TOKENS_PER_DAY_MAX), false);
  assert.equal(exceedsTokenQuota(CREDENTIAL_TOKENS_PER_DAY_MAX + 1), true);
  assert.equal(exceedsTokenQuota(Number.NaN), false, 'infra error tidak boleh memblokir semua user');
});

test('[docs/35 Fase 6] key kuota memakai identityTag, bukan userId mentah', () => {
  const key = credentialTokenQuotaKey('user-123', '2026-10-21');
  assert.equal(key.startsWith('cred:tokens:'), true);
  assert.equal(key.endsWith(':2026-10-21'), true);
  assert.equal(key.includes('user-123'), false);
});

test('[docs/35 Fase 6] Lua konsumsi = GET+DEL atomik (bukan dua perintah terpisah)', () => {
  assert.match(CREDENTIAL_CONSUME_LUA, /redis\.call\('GET', KEYS\[1\]\)/);
  assert.match(CREDENTIAL_CONSUME_LUA, /redis\.call\('DEL', KEYS\[1\]\)/);
  assert.match(CREDENTIAL_INCRBY_LUA, /INCRBY/);
  assert.match(CREDENTIAL_INCRBY_LUA, /EXPIRE/);
});

test('[docs/35 Fase 6] wiring: redeem anonim tanpa requireAuth, bank tetap terautentikasi', () => {
  const routes = read('../src/routes/credentials.ts');
  assert.doesNotMatch(routes, /^router\.use\(requireAuth\)/m, 'router anonim tidak boleh requireAuth global');
  assert.match(routes, /router\.post\('\/tokens', requireAuth/, 'bank token tetap butuh sesi');
  assert.match(routes, /router\.post\('\/issuance', anonCredentialLimiter/, 'redeem memakai limiter per IP');
  assert.match(routes, /router\.post\('\/commit', anonCredentialLimiter/);
  assert.match(routes, /CREDENTIAL_CONSUME_LUA/, 'token/ticket dikonsumsi atomik');
  assert.match(routes, /X-Group-Token/, 'bukti keanggotaan grup-level');
  assert.doesNotMatch(routes, /x-delivery-tokens/i, 'delivery token pseudonim TIDAK dipakai jalur anonim');
  assert.match(routes, /boundConversation/, 'commit ticket terikat conversation');
});

test('[docs/35 Fase 6] wiring: CSRF hanya dikecualikan untuk dua path redeem', () => {
  const app = read('../src/app.ts');
  assert.match(app, /req\.path === '\/api\/credentials\/issuance'/);
  assert.match(app, /req\.path === '\/api\/credentials\/commit'/);
  assert.doesNotMatch(app, /req\.path\.startsWith\('\/api\/credentials'\)/, 'bank token harus tetap di bawah CSRF');
  assert.match(app, /app\.use\("\/api\/credentials", credentialsRouter\)/);
});
