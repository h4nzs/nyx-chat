// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ML_DSA_65_LENGTHS,
  PQ_V2_DOMAINS,
  mlDsaGetPublicKey,
  mlDsaKeygen,
  mlDsaSign,
  mlDsaVerify,
} from '@nyx/shared';
import { verifyMlDsaSignature } from '../src/utils/mlDsa.js';

const seed = new Uint8Array(32).fill(0x42);
const message = new TextEncoder().encode('nyx pq v2 server verify');

test('ml-dsa: keypair deterministik dari seed dengan panjang FIPS 204', () => {
  const a = mlDsaKeygen(seed);
  const b = mlDsaKeygen(seed);

  assert.equal(a.publicKey.length, ML_DSA_65_LENGTHS.publicKey);
  assert.equal(a.secretKey.length, ML_DSA_65_LENGTHS.secretKey);
  assert.deepEqual(Array.from(a.publicKey), Array.from(b.publicKey));
  assert.deepEqual(Array.from(mlDsaGetPublicKey(a.secretKey)), Array.from(a.publicKey));
});

test('ml-dsa: tanda tangan roundtrip dan context domain terpisah', () => {
  const { publicKey, secretKey } = mlDsaKeygen(seed);
  const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.BUNDLE);

  assert.equal(signature.length, ML_DSA_65_LENGTHS.signature);
  assert.equal(mlDsaVerify(signature, message, publicKey, PQ_V2_DOMAINS.BUNDLE), true);
  assert.equal(mlDsaVerify(signature, message, publicKey, PQ_V2_DOMAINS.HANDSHAKE), false);
});

test('ml-dsa: verifier server menolak panjang salah dan tanda tangan palsu', () => {
  const { publicKey, secretKey } = mlDsaKeygen(seed);
  const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.BUNDLE);

  assert.equal(
    verifyMlDsaSignature({ signature, message, publicKey, domain: PQ_V2_DOMAINS.BUNDLE }),
    true,
  );

  const shortSignature = signature.subarray(0, signature.length - 1);
  assert.equal(
    verifyMlDsaSignature({ signature: shortSignature, message, publicKey, domain: PQ_V2_DOMAINS.BUNDLE }),
    false,
  );

  const tampered = Uint8Array.from(signature);
  tampered[0] ^= 0x01;
  assert.equal(
    verifyMlDsaSignature({ signature: tampered, message, publicKey, domain: PQ_V2_DOMAINS.BUNDLE }),
    false,
  );
});
