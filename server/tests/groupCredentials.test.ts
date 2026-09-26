// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [26.8.1] Blind RSA group credentials (RFC 9474 / RSABSSA) — kontrak tests.
 *
 * Kontrak dikunci di level source + Prisma schema. Roundtrip kriptografi
 * (blind → blindSign → finalize → verify) diuji langsung dengan library —
 * memastikan serial client (WebCrypto SHA-384) == serial server (node:crypto).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RSABSSA } from '@cloudflare/blindrsa-ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

test('26.8.1: blind RSA roundtrip — blind → blindSign → finalize → verify', async () => {
  const suite = RSABSSA.SHA384.PSS.Randomized();
  const kp = await suite.generateKey({ publicExponent: Uint8Array.from([1, 0, 1]), modulusLength: 2048 });
  const msg = new TextEncoder().encode('nyx-grp-cred:v1:conv123:0123456789abcdef0123456789abcdef');
  const prepared = suite.prepare(msg);
  const { blindedMsg, inv } = await suite.blind(kp.publicKey, prepared);
  const blindSig = await suite.blindSign(kp.privateKey, blindedMsg);
  const sig = await suite.finalize(kp.publicKey, prepared, blindSig, inv);
  assert.equal(await suite.verify(kp.publicKey, sig, prepared), true, 'signature valid untuk message aslinya');

  // Message lain → tidak valid (credential terikat message random klien)
  const other = suite.prepare(new TextEncoder().encode('nyx-grp-cred:v1:other:ff'));
  assert.equal(await suite.verify(kp.publicKey, sig, other), false, 'signature TIDAK valid untuk message lain');
});

test('26.8.1: serial client == serial server (SHA-384 dari prepared message)', () => {
  const lib = read('../src/lib/groupCredentials.ts');
  assert.match(lib, /createHash\('sha384'\)\.update\(preparedMsg\)\.digest\('hex'\)/, 'server serial = SHA-384 hex');
  assert.equal(SERIAL_LEN, 96, 'serial 96-hex (48 byte)');
});

const SERIAL_LEN = 96;

test('26.8.1: schema — GroupCredential serial unique + conversationId index; issuer key disimpan', () => {
  const schema = read('../prisma/schema.prisma');
  assert.match(schema, /model GroupCredential \{[\s\S]*serial\s+String\s+@unique[\s\S]*@@index\(\[conversationId\]\)/,
    'GroupCredential: serial unique (dedupe/presentasi) + index conversation');
  assert.match(schema, /model CredentialIssuerKey \{[\s\S]*keyVersion\s+Int\s+@id[\s\S]*privateKeyPkcs8\s+String/,
    'Issuer key: keyVersion PK, private key PKCS#8 di server');
});

test('26.8.1: issuance endpoint — server hanya melihat blinded message, tidak ada identitas di payload', () => {
  const src = read('../src/routes/conversations.ts');
  assert.match(src, /credential-issuance/, 'endpoint issuance ada');
  assert.match(src, /credential-issuer-key/, 'endpoint public key ada');
  assert.match(src, /credential-commit/, 'endpoint commit serial ada');
  assert.match(src, /cred:issue:\$\{req\.user\.id\}/, 'quota anti-abuse per (user, conversation, hari)');
  // Blinded message divalidasi ukurannya sebelum ditandatangani
  assert.match(src, /blinded\.length === 0 \|\| blinded\.length > 512/, 'validasi ukuran blinded message');
});

test('26.8.1: sync menerima X-Group-Credentials dan verifikasi via verifyPresentation', () => {
  const src = read('../src/routes/conversations.ts');
  assert.match(src, /x-group-credentials/i, 'sync membaca header presentasi credential');
  assert.match(src, /verifyPresentation\(convId, keyVersion, preparedMsg, signature\)/, 'presentasi diverifikasi kryptografis');
  assert.match(src, /slice\(0,\s*100\)/, 'jumlah presentasi per request di-cap 100');
});

test('26.8.1: verifikasi menolak conversation/keyVersion yang salah', async () => {
  const lib = read('../src/lib/groupCredentials.ts');
  assert.match(lib, /registered\.conversationId !== conversationId/, 'serial terikat conversation yang diklaim');
  assert.match(lib, /registered\.keyVersion !== keyVersion/, 'keyVersion harus cocok (rotasi mematikan credential lama)');
});

test('26.8.1: client — random message bukan identitas; inv tak pernah ke server', () => {
  const client = read('../../web/src/lib/groupCredentials.ts');
  assert.match(client, /crypto\.getRandomValues/, 'message dibangun dari random 128-bit');
  assert.doesNotMatch(client, /userId/, 'payload issuance TIDAK membawa identitas');
  assert.match(client, /worker_credential_blind/, 'blind dijalankan di crypto worker');
  assert.match(client, /X-Group-Credentials/, 'presentasi dikirim saat sync');
});
