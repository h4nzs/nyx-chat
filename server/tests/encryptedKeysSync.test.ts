import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENCRYPTED_KEYS_MAX_LENGTH,
  validateEncryptedPrivateKeysPayload,
  toEncryptedPrivateKeyPatch
} from '../src/utils/encryptedKeysSync.js';

test('payload valid (base64 bundle) diterima apa adanya', () => {
  const bundle = 'eyJ2IjoxfQ=='; // bentuk bebas — validasi hanya cek tipe & panjang
  assert.equal(validateEncryptedPrivateKeysPayload(bundle), bundle);
});

test('field tidak dikirim (client lama) → undefined, kompatibel mundur', () => {
  assert.equal(validateEncryptedPrivateKeysPayload(undefined), undefined);
  assert.equal(validateEncryptedPrivateKeysPayload(null), undefined);
});

test('payload kosong ditolak (400)', () => {
  assert.throws(() => validateEncryptedPrivateKeysPayload(''), (e: unknown) => {
    const err = e as { status?: number; message?: string };
    return err instanceof Error && err.status === 400;
  });
});

test('payload melebihi batas panjang ditolak (400)', () => {
  const tooBig = 'a'.repeat(ENCRYPTED_KEYS_MAX_LENGTH + 1);
  assert.throws(() => validateEncryptedPrivateKeysPayload(tooBig), (e: unknown) => {
    const err = e as { status?: number };
    return err instanceof Error && err.status === 400;
  });
});

test('payload non-string ditolak (400)', () => {
  assert.throws(() => validateEncryptedPrivateKeysPayload(123), (e: unknown) => {
    const err = e as { status?: number };
    return err instanceof Error && err.status === 400;
  });
  assert.throws(() => validateEncryptedPrivateKeysPayload({}), (e: unknown) => {
    const err = e as { status?: number };
    return err instanceof Error && err.status === 400;
  });
});

test('patch Prisma meng-encode UTF-8 ke Buffer bytes (bukan base64url)', () => {
  const bundle = 'encrypted-bundle-payload';
  const patch = toEncryptedPrivateKeyPatch(bundle);
  assert.deepEqual(patch, {
    encryptedPrivateKey: Buffer.from(bundle, 'utf8')
  });
  assert.equal(patch.encryptedPrivateKey.toString('utf8'), bundle);
});
