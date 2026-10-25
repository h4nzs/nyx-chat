// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.5] Kontrak presentasi credential: parser biner + binding +
 * allowlist + fail-closed. Tidak ada issuer: test hanya membuktikan bahwa
 * verifier MENOLAK semua yang tidak memenuhi kontrak, termasuk saat tidak ada
 * modul verifikasi terpasang.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_MAGIC,
  clearCredentialVerifiersForTests,
  parseCredentialPresentation,
  parseSuiteAllowlist,
  registerCredentialVerifier,
  verifyCredentialPresentation,
} from '../src/utils/credentialPresentation.js';

function encode (opts: {
  suite?: number;
  keyVersion?: number;
  epoch?: number;
  groupId?: string;
  expiresAt?: number;
  signature?: Uint8Array;
  magic?: string;
} = {}): Uint8Array {
  const suite = opts.suite ?? 1;
  const keyVersion = opts.keyVersion ?? 1;
  const epoch = opts.epoch ?? 0;
  const groupId = opts.groupId ?? 'conv-1';
  const expiresAt = opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600;
  const signature = opts.signature ?? new Uint8Array([1, 2, 3, 4]);
  const magic = opts.magic ?? CREDENTIAL_MAGIC;

  const size = 4 + 1 + 2 + 8 + 1 + groupId.length + 8 + 2 + signature.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let offset = 0;
  for (const ch of magic) buf[offset++] = ch.charCodeAt(0);
  view.setUint8(offset, suite); offset += 1;
  view.setUint16(offset, keyVersion); offset += 2;
  view.setBigUint64(offset, BigInt(epoch)); offset += 8;
  view.setUint8(offset, groupId.length); offset += 1;
  for (const ch of groupId) buf[offset++] = ch.charCodeAt(0);
  view.setBigUint64(offset, BigInt(expiresAt)); offset += 8;
  view.setUint16(offset, signature.length); offset += 2;
  buf.set(signature, offset);
  return buf;
}

test('parser: bentuk sah terbaca lengkap (suite, keyVersion, epoch, group, expiry)', () => {
  const parsed = parseCredentialPresentation(encode({ suite: 7, keyVersion: 3, epoch: 12 }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.presentation.suite, 7);
  assert.equal(parsed.presentation.keyVersion, 3);
  assert.equal(parsed.presentation.epoch, 12);
  assert.equal(parsed.presentation.groupId, 'conv-1');
  assert.deepEqual([...parsed.presentation.signature], [1, 2, 3, 4]);
});

test('parser: magic salah, terpotong, panjang tidak konsisten, body kebesaran', () => {
  assert.equal(parseCredentialPresentation(encode({ magic: 'NYXD' })).ok, false);
  assert.equal(parseCredentialPresentation(new Uint8Array(8)).ok, false);

  const valid = encode();
  const truncated = valid.subarray(0, valid.length - 1);
  assert.deepEqual(parseCredentialPresentation(truncated), { ok: false, reason: 'bad_lengths' });

  const withExtra = new Uint8Array(valid.length + 1);
  withExtra.set(valid);
  assert.deepEqual(parseCredentialPresentation(withExtra), { ok: false, reason: 'bad_lengths' });

  assert.deepEqual(parseCredentialPresentation(new Uint8Array(9000)), { ok: false, reason: 'body_too_large' });
});

test('verifier: binding group/epoch/expiry ditegakkan sebelum kripto', async () => {
  clearCredentialVerifiersForTests();
  const body = encode({ epoch: 2 });

  assert.equal((await verifyCredentialPresentation(body, { groupId: 'conv-2', epoch: 2 })).ok, false);
  assert.equal((await verifyCredentialPresentation(body, { groupId: 'conv-1', epoch: 3 })).ok, false);
  assert.equal(
    (await verifyCredentialPresentation(body, { groupId: 'conv-1', epoch: 2, now: new Date(Date.now() + 2 * 3600_000) })).ok,
    false
  );
});

test('verifier: suite tidak di allowlist = tolak, walau verifier terpasang', async () => {
  clearCredentialVerifiersForTests();
  let called = 0;
  registerCredentialVerifier({ suite: 9, verify: async () => { called += 1; return true } });
  const body = encode({ suite: 9 });

  const denied = await verifyCredentialPresentation(body, { groupId: 'conv-1', epoch: 0, allowlist: [1] });
  assert.deepEqual(denied, { ok: false, reason: 'suite_not_allowed' });
  assert.equal(called, 0, 'suite terlarang tidak boleh menyentuh verifier');
});

test('verifier: allowlist kosong (default) menolak semua suite', async () => {
  clearCredentialVerifiersForTests();
  registerCredentialVerifier({ suite: 1, verify: async () => true });
  const result = await verifyCredentialPresentation(encode({ suite: 1 }), { groupId: 'conv-1', epoch: 0 });
  assert.deepEqual(result, { ok: false, reason: 'suite_not_allowed' });
});

test('verifier: tanpa modul verifikasi tetap gagal-closed', async () => {
  clearCredentialVerifiersForTests();
  const result = await verifyCredentialPresentation(encode({ suite: 2 }), {
    groupId: 'conv-1',
    epoch: 0,
    allowlist: [2],
  });
  assert.deepEqual(result, { ok: false, reason: 'no_verifier' });
});

test('verifier: modul yang menolak signature tidak pernah menghasilkan ok', async () => {
  clearCredentialVerifiersForTests();
  registerCredentialVerifier({ suite: 2, verify: async () => false });
  const result = await verifyCredentialPresentation(encode({ suite: 2 }), {
    groupId: 'conv-1',
    epoch: 0,
    allowlist: [2],
  });
  assert.equal(result.ok, false);
});

test('verifier: jalur sah hanya bila semua binding cocok + modul menerima', async () => {
  clearCredentialVerifiersForTests();
  registerCredentialVerifier({ suite: 2, verify: async () => true });
  const result = await verifyCredentialPresentation(encode({ suite: 2, epoch: 5 }), {
    groupId: 'conv-1',
    epoch: 5,
    allowlist: [2],
  });
  assert.equal(result.ok, true);
});

test('parseSuiteAllowlist: CSV → angka valid, default kosong', () => {
  assert.deepEqual(parseSuiteAllowlist(undefined), []);
  assert.deepEqual(parseSuiteAllowlist(''), []);
  assert.deepEqual(parseSuiteAllowlist('1, 2,abc,0,999'), [1, 2]);
});
