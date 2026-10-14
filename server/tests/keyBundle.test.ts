// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4)] Pemetaan perangkat → bundle (dulu disalin 3× di keys.ts).
 * Bentuk yang dikunci di sini adalah kontrak yang dibaca klien: nilai biner jadi
 * base64url, `null` tetap `null`, dan bundle publik tidak membawa signed pre-key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';

import {
  toBase64Url,
  toDeviceTemplate,
  toOptionalBase64Url,
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
  });
  assert.ok(!('signedPreKey' in bundle));
  assert.ok(!('id' in bundle));
});
