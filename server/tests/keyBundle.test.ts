// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4)] Pemetaan perangkat → bundle (dulu disalin 3× di keys.ts).
 * Bentuk yang dikunci di sini adalah kontrak yang dibaca klien: nilai biner jadi
 * base64url, `null` tetap `null`, dan bundle publik tidak membawa signed pre-key.
 *
 * Ditambah jalur OTPK (residual WS-G(4) "keys.ts prekey-bundle/OTPK"):
 * baris OTPK → `oneTimePreKey`, bundle tanpa OTPK yang tetap sah, pemilihan
 * perangkat beserta kode errornya, dan urutan **kuota sebelum konsumsi** di rute
 * (kalau terbalik, satu permintaan over-quota membakar OTPK korban).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseOtpkMode,
  requireBundleDevice,
  toBase64Url,
  toDeviceTemplate,
  toOneTimePreKey,
  toOptionalBase64Url,
  toPreKeyBundle,
  toPublicDeviceBundle,
} from '../src/utils/keyBundle.js';

const B = (s: string) => Buffer.from(s, 'utf8');

test('toBase64Url menerima Buffer, Uint8Array, dan string', () => {
  const expected = B('hello').toString('base64url');
  assert.equal(toBase64Url(B('hello')), expected);
  assert.equal(toBase64Url(new Uint8Array(B('hello'))), expected);
  // String = sudah base64url (bukan di-encode ulang).
  assert.equal(toBase64Url('abc-_'), 'abc-_');
});

test('toOptionalBase64Url: null/undefined → null, nilai → base64url', () => {
  assert.equal(toOptionalBase64Url(null), null);
  assert.equal(toOptionalBase64Url(undefined), null);
  assert.equal(toOptionalBase64Url(B('x')), B('x').toString('base64url'));
});

test('toDeviceTemplate memetakan seluruh field termasuk signed pre-key', () => {
  const template = toDeviceTemplate({
    id: 'dev-1',
    publicKey: B('pk'),
    pqPublicKey: B('pqpk'),
    signingKey: B('sk'),
    preKeyBundle: {
      key: B('spk'),
      pqKey: B('pqspk'),
      signature: B('sig'),
      pqSignature: B('pqsig'),
    },
  });

  assert.deepEqual(template, {
    id: 'dev-1',
    identityKey: B('pk').toString('base64url'),
    pqIdentityKey: B('pqpk').toString('base64url'),
    signingKey: B('sk').toString('base64url'),
    signingKeyV2: null,
    signedPreKey: {
      key: B('spk').toString('base64url'),
      pqKey: B('pqspk').toString('base64url'),
      signature: B('sig').toString('base64url'),
      pqSignature: B('pqsig').toString('base64url'),
    },
  });
});

test('toDeviceTemplate: pq opsional null & preKeyBundle null → null', () => {
  const template = toDeviceTemplate({
    id: 'dev-2',
    publicKey: 'pk-b64',
    pqPublicKey: null,
    signingKey: 'sk-b64',
    preKeyBundle: null,
  });

  assert.equal(template.pqIdentityKey, null);
  assert.equal(template.signedPreKey, null);
  assert.equal(template.identityKey, 'pk-b64');
});

const TEMPLATE = {
  id: 'dev-9',
  identityKey: 'idk',
  pqIdentityKey: 'pqidk',
  signingKey: 'sk',
  signedPreKey: { key: 'spk', pqKey: 'pqspk', signature: 'sig', pqSignature: 'pqsig' },
};

test('toOneTimePreKey: biner → base64url, string apa adanya, pq null tetap null', () => {
  const mapped = toOneTimePreKey({
    id: 'otpk-1',
    keyId: 7,
    publicKey: B('otpk-key'),
    pqPublicKey: new Uint8Array(B('otpk-pq')),
  });
  assert.deepEqual(mapped, {
    keyId: 7,
    key: B('otpk-key').toString('base64url'),
    pqKey: B('otpk-pq').toString('base64url'),
  });

  // Baris yang sudah base64url (string) tidak di-encode ulang.
  assert.equal(toOneTimePreKey({ id: 'x', keyId: 1, publicKey: 'abc-_', pqPublicKey: null }).key, 'abc-_');
  assert.equal(toOneTimePreKey({ id: 'x', keyId: 1, publicKey: B('k'), pqPublicKey: null }).pqKey, null);
  assert.equal(toOneTimePreKey({ id: 'x', keyId: 1, publicKey: B('k'), pqPublicKey: undefined }).pqKey, null);
  // Perilaku lama dipertahankan apa adanya (cek falsy): string kosong → `null`,
  // sedangkan `Buffer(0)` tetap truthy → base64url dari nol byte = `''`.
  assert.equal(toOneTimePreKey({ id: 'x', keyId: 1, publicKey: B('k'), pqPublicKey: '' }).pqKey, null);
  assert.equal(toOneTimePreKey({ id: 'x', keyId: 1, publicKey: B('k'), pqPublicKey: Buffer.alloc(0) }).pqKey, '');
});

test('toPreKeyBundle: OTPK disertakan bila ada, field-nya hilang bila habis', () => {
  const withOtpk = toPreKeyBundle(TEMPLATE, {
    id: 'otpk-1',
    keyId: 3,
    publicKey: B('otpk'),
    pqPublicKey: null,
  });
  assert.deepEqual(withOtpk.oneTimePreKey, { keyId: 3, key: B('otpk').toString('base64url'), pqKey: null });
  assert.equal(withOtpk.deviceId, 'dev-9');
  assert.equal(withOtpk.signedPreKey?.key, 'spk');

  // Habis (null/undefined) → bundle tetap sah TANPA field `oneTimePreKey`,
  // bukan `null` (klien memeriksa keberadaan field-nya).
  for (const empty of [null, undefined]) {
    const bundle = toPreKeyBundle(TEMPLATE, empty);
    assert.ok(!('oneTimePreKey' in bundle), 'field tidak boleh muncul saat OTPK habis');
    assert.equal(bundle.identityKey, 'idk');
  }
});

test('requireBundleDevice: pilih yang pertama, dua kondisi 404 dibedakan', () => {
  const device = { id: 'dev-1', publicKey: B('pk'), signingKey: B('sk') };
  // Prisma sudah mengurutkan (lastActiveAt desc, createdAt desc) — util hanya
  // mengambil yang pertama, jadi urutan itu yang menentukan.
  assert.equal(requireBundleDevice([device]), device);

  assert.throws(
    () => requireBundleDevice([]),
    (error: unknown) => {
      const apiError = error as { status?: number; message?: string };
      return apiError.status === 404 && apiError.message === 'User does not have any active devices.';
    }
  );
  assert.throws(
    () => requireBundleDevice([{ id: 'dev-2', publicKey: null, signingKey: B('sk') }]),
    (error: unknown) => {
      const apiError = error as { status?: number; message?: string };
      return apiError.status === 404 && apiError.message === 'Device identity not fully initialized.';
    }
  );
  assert.throws(
    () => requireBundleDevice([{ id: 'dev-3', publicKey: B('pk'), signingKey: null }]),
    (error: unknown) => (error as { status?: number }).status === 404
  );
});

/**
 * Urutan gate kuota vs konsumsi OTPK di rute — properti keamanan, bukan gaya.
 * Rutenya tidak bisa diimpor tanpa Prisma/Redis, jadi yang diuji adalah kode
 * sumbernya: `consumeOtpkQuota` harus muncul SEBELUM `DELETE FROM "OneTimePreKey"`
 * di kedua jalur yang mengonsumsi OTPK.
 */
test('wiring keys.ts: kuota dicek sebelum OTPK dikonsumsi (fail-closed)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, '../src/routes/keys.ts'), 'utf8');

  const consumeQuery = 'DELETE FROM "OneTimePreKey"';
  assert.ok(source.includes(consumeQuery), 'rute harus mengonsumsi OTPK lewat query hapus atomik');

  // Dua jalur: bundle tunggal dan bulk.
  const quotaCalls = source.split('consumeOtpkQuota(').length - 1;
  assert.ok(quotaCalls >= 2, `kuota harus dicek di kedua jalur, ditemukan ${quotaCalls}`);

  const firstQuota = source.indexOf('consumeOtpkQuota(');
  const firstConsume = source.indexOf(consumeQuery);
  assert.ok(firstQuota > -1 && firstConsume > -1 && firstQuota < firstConsume, 'kuota sebelum konsumsi OTPK');

  // Jalur bulk memeriksa kuota untuk SEMUA target di depan (satu request gagal
  // sebelum satu pun OTPK terbuang).
  assert.match(source, /consumeOtpkQuota\(\(req\.user as AuthJwtPayload\)\.id, userIds\)/);

  // Pemetaan OTPK tidak lagi disalin: dua jalur memakai util bersama, dan tidak
  // ada lagi blok inline `bundle.oneTimePreKey = { … }` di rute.
  const utilCalls = source.split('toPreKeyBundle(').length - 1;
  assert.ok(utilCalls >= 2, `kedua jalur harus memakai toPreKeyBundle, ditemukan ${utilCalls}`);
  assert.ok(!source.includes('bundle.oneTimePreKey ='), 'pemetaan OTPK inline harus dihapus dari rute');
  assert.ok(!source.includes('Buffer.isBuffer(otpk.publicKey)'), 'ekspresi biner inline harus dihapus dari rute');
});

test('[docs/35 Fase 4] parseOtpkMode: default consume, hanya `read` yang melewati konsumsi', () => {
  assert.equal(parseOtpkMode(undefined), 'consume', 'klien lama tidak berubah');
  assert.equal(parseOtpkMode('consume'), 'consume');
  assert.equal(parseOtpkMode('read'), 'read');
  assert.equal(parseOtpkMode('READ'), 'consume', 'nilai tak dikenal = perilaku aman (konsumsi)');
  assert.equal(parseOtpkMode(['read']), 'consume', 'array query tidak lolos');
  assert.equal(parseOtpkMode(1), 'consume');
});

test('[docs/35 Fase 4] wiring keys.ts: mode read kembali TANPA menghapus OTPK', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/keys.ts'), 'utf8');
  const guard = source.indexOf("if (otpkMode === 'read')");
  const removal = source.indexOf('DELETE FROM "OneTimePreKey"');
  assert.ok(guard > 0, 'ada cabang read eksplisit');
  assert.ok(removal > guard, 'cabang read berada SEBELUM penghapusan OTPK');
  assert.match(source, /toPreKeyBundle\(deviceTemplate, null\)/, 'mode read tidak mengirim oneTimePreKey');
});

test('toPublicDeviceBundle memakai deviceId dan tanpa signed pre-key', () => {
  const bundle = toPublicDeviceBundle({
    id: 'dev-3',
    publicKey: B('pk'),
    pqPublicKey: null,
    signingKey: B('sk'),
  });

  assert.deepEqual(bundle, {
    deviceId: 'dev-3',
    identityKey: B('pk').toString('base64url'),
    pqIdentityKey: null,
    signingKey: B('sk').toString('base64url'),
    signingKeyV2: null,
  });
  assert.ok(!('signedPreKey' in bundle));
  assert.ok(!('id' in bundle));
});
