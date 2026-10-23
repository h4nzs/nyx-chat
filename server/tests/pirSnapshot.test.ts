import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIR_DEFAULT_RECORD_BYTES,
  PIR_MAX_RECORD_BYTES,
  buildPirSnapshot,
  parsePirEpoch,
  parsePirRecordBytes,
  type PirRecordSource,
} from '../src/pir/snapshot.js';

const OPRF = 'a'.repeat(64);

function source(overrides: Partial<PirRecordSource> = {}): PirRecordSource {
  return {
    id: 'user-1',
    encryptedProfile: 'ciphertext',
    isVerified: true,
    hasCompletedOnboarding: true,
    oprfIndex: OPRF,
    device: {
      publicKey: Uint8Array.from([1, 2, 3]),
      pqPublicKey: null,
      signingKey: Uint8Array.from([4, 5]),
    },
    ...overrides,
  };
}

test('PIR snapshot: record dipad ke ukuran tetap dan bisa di-parse', () => {
  const snapshot = buildPirSnapshot([source()], 256, 123);
  assert.equal(snapshot.epoch, 123);
  assert.equal(snapshot.recordBytes, 256);
  assert.equal(snapshot.entries.length, 1);
  const entry = snapshot.entries[0]!;
  assert.equal(entry.oprf, Buffer.from(OPRF, 'hex').toString('base64url'));
  const value = Buffer.from(entry.value, 'base64url');
  assert.equal(value.length, 256);
  assert.equal(value.subarray(value.length - 1).toString(), ' ');
  const record = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(record, {
    id: 'user-1',
    encryptedProfile: 'ciphertext',
    isVerified: true,
    hasCompletedOnboarding: true,
    publicKey: 'AQID',
    pqPublicKey: null,
    signingKey: 'BAU',
  });
});

test('PIR snapshot: menolak record kebesaran, OPRF duplikat, dan hex invalid', () => {
  assert.throws(
    () => buildPirSnapshot([source({ encryptedProfile: 'x'.repeat(300) })], 256, 1),
    /melebihi 256/,
  );
  assert.throws(
    () =>
      buildPirSnapshot(
        [source(), source({ id: 'user-2' })],
        256,
        1,
      ),
    /duplikat/,
  );
  assert.throws(
    () => buildPirSnapshot([source({ oprfIndex: 'z'.repeat(64) })], 256, 1),
    /oprfIndex/,
  );
  assert.throws(() => buildPirSnapshot([], 256, 1), /kosong/);
});

test('PIR snapshot: env recordBytes dan epoch divalidasi', () => {
  assert.equal(parsePirRecordBytes(undefined), PIR_DEFAULT_RECORD_BYTES);
  assert.equal(parsePirRecordBytes('4096'), 4096);
  assert.throws(() => parsePirRecordBytes('255'), /256/);
  assert.throws(() => parsePirRecordBytes(String(PIR_MAX_RECORD_BYTES + 1)), /16384/);
  assert.throws(() => parsePirRecordBytes('2kb'), /bulat/);
  assert.equal(parsePirEpoch('42'), 42);
  assert.equal(parsePirEpoch(undefined, 999), 999);
  assert.throws(() => parsePirEpoch('0'), /positif/);
  assert.throws(() => parsePirEpoch('-1'), /positif/);
});
