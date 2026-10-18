// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi bug 2026-10-18: "internal server error" saat verify/biometric.
 *
 * `GET /api/auth/webauthn/register/options` mengoper `excludeCredentials[].id`
 * sebagai Buffer. `@simplewebauthn/server` v13 memvalidasi id dengan
 * `isBase64URL(id)` → `trimPadding()` → `input.replace(...)`; Buffer tidak
 * punya `.replace` → TypeError → 500. Akibatnya akun yang sudah punya
 * authenticator (kredensial attestation saat daftar) tidak pernah bisa
 * menyelesaikan verifikasi perangkat, sehingga `isVerified` tetap false dan
 * unggah backup ke awan ditolak (`SANDBOX_UPLOAD_RESTRICTION`).
 *
 * Test ini memanggil `generateRegistrationOptions` yang SEBENARNYA, tanpa
 * stub, sehingga hanya lulus kalau bentuk id yang dikirim memang diterima
 * library — bukan sekadar "tidak melempar" pada helper buatan sendiri.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  parseCredentialTransports,
  toBase64UrlCredentialId
} from '../src/utils/webauthnCredentials.js';

const CREDENTIAL_ID = randomBytes(32); // 32 byte, seperti authenticator nyata
const CREDENTIAL_ID_B64URL = isoBase64URL.fromBuffer(CREDENTIAL_ID);

function registrationArgs(excludeCredentials: unknown[]) {
  return {
    rpName: 'NYX',
    rpID: 'localhost',
    userID: new Uint8Array(randomBytes(16)),
    userName: 'user-tag',
    attestationType: 'none' as const,
    excludeCredentials: excludeCredentials as never,
    authenticatorSelection: {
      residentKey: 'preferred' as const,
      userVerification: 'required' as const,
      authenticatorAttachment: 'platform' as const
    }
  };
}

test('bentuk LAMA (Buffer) memang penyebab 500 — dikunci sebagai bukti akar masalah', async () => {
  await assert.rejects(
    () => generateRegistrationOptions(registrationArgs([{ id: Buffer.from(CREDENTIAL_ID) }])),
    (err: unknown) => {
      // Pesan asli library: "input.replace is not a function".
      assert.ok(err instanceof TypeError, `expected TypeError, got ${String(err)}`);
      assert.match(String((err as Error).message), /replace/i);
      return true;
    }
  );
});

test('bentuk BARU (Base64URLString + transports) diterima library dan id-nya utuh', async () => {
  const options = await generateRegistrationOptions(
    registrationArgs([
      {
        id: toBase64UrlCredentialId(CREDENTIAL_ID_B64URL),
        transports: parseCredentialTransports('internal,hybrid')
      }
    ])
  );

  assert.equal(options.rp.id, 'localhost');
  assert.equal(options.excludeCredentials?.length, 1);
  const entry = options.excludeCredentials![0]!;
  assert.equal(entry.id, CREDENTIAL_ID_B64URL);
  // Id yang dikirim client harus byte-identik dengan credential yang tersimpan,
  // kalau tidak browser akan membuat passkey duplikat alih-alih melewatinya.
  assert.deepEqual(
    Buffer.from(isoBase64URL.toBuffer(entry.id)),
    CREDENTIAL_ID
  );
  assert.deepEqual(entry.transports, ['internal', 'hybrid']);
  assert.ok(options.challenge.length > 0);
});

test('credentialID base64 standar (baris lama) dinormalkan ke base64url', () => {
  const standard = Buffer.from(CREDENTIAL_ID).toString('base64'); // memuat + / =
  const normalized = toBase64UrlCredentialId(standard);
  assert.equal(normalized, CREDENTIAL_ID_B64URL);
  assert.equal(toBase64UrlCredentialId(`  ${standard}  `), CREDENTIAL_ID_B64URL);
});

test('nilai tak terpakai tidak menjatuhkan seluruh daftar exclude', () => {
  assert.equal(toBase64UrlCredentialId(null), null);
  assert.equal(toBase64UrlCredentialId(undefined), null);
  assert.equal(toBase64UrlCredentialId(''), null);
  assert.equal(toBase64UrlCredentialId('   '), null);
  assert.equal(toBase64UrlCredentialId(123 as unknown), null);
  assert.equal(toBase64UrlCredentialId('==='), null);
  assert.equal(parseCredentialTransports(null), undefined);
  assert.equal(parseCredentialTransports(''), undefined);
  assert.equal(parseCredentialTransports(' , '), undefined);
  assert.deepEqual(parseCredentialTransports(' usb , nfc '), ['usb', 'nfc']);
});

test('dua credential tersimpan → keduanya ikut di exclude (tanpa melempar)', async () => {
  const second = isoBase64URL.fromBuffer(randomBytes(32));
  const options = await generateRegistrationOptions(
    registrationArgs([
      { id: toBase64UrlCredentialId(CREDENTIAL_ID_B64URL) },
      { id: toBase64UrlCredentialId(second) }
    ])
  );
  assert.deepEqual(
    options.excludeCredentials?.map((c) => c.id),
    [CREDENTIAL_ID_B64URL, second]
  );
});
