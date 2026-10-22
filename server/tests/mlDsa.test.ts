// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
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

test('ml-dsa: KAT ACVP FIPS 204 ML-DSA-65 (keygen + deterministic siggen)', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/mlDsaAcvp65.json', import.meta.url), 'utf8')
  ) as {
    keyGen: { tcId: number; seed: string; pk: string; sk: string };
    sigGen: {
      tcId: number;
      message: string;
      pk: string;
      sk: string;
      context: string;
      signature: string;
    };
  };
  const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
  const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

  const keypair = ml_dsa65.keygen(bytes(fixture.keyGen.seed));
  assert.equal(hex(keypair.publicKey), fixture.keyGen.pk.toLowerCase(), `ACVP tcId ${fixture.keyGen.tcId}: public key`);
  assert.equal(hex(keypair.secretKey), fixture.keyGen.sk.toLowerCase(), `ACVP tcId ${fixture.keyGen.tcId}: secret key`);

  const message = bytes(fixture.sigGen.message);
  const context = bytes(fixture.sigGen.context);
  const signature = ml_dsa65.sign(message, bytes(fixture.sigGen.sk), {
    context,
    extraEntropy: false,
  });
  assert.equal(hex(signature), fixture.sigGen.signature.toLowerCase(), `ACVP tcId ${fixture.sigGen.tcId}: deterministic signature`);
  assert.equal(ml_dsa65.verify(signature, message, bytes(fixture.sigGen.pk), { context }), true, 'signature ACVP terverifikasi');
});
