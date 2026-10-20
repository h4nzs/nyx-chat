// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
//
// [docs/35 Fase 1.3] Bundle v2 — encode kanonik + verifikasi ML-DSA-65.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBundleV2Message,
  ML_DSA_65_LENGTHS,
  mlDsaKeygen,
  mlDsaSign,
  PQ_V2_DOMAINS,
  X25519_PUBLIC_KEY_BYTES,
  XWING_PUBLIC_KEY_BYTES,
} from '@nyx/shared';
import { verifyMlDsaSignature } from '../src/utils/mlDsa.js';

const seed = new Uint8Array(32).fill(7);
const { publicKey, secretKey } = mlDsaKeygen(seed);

function fields() {
  return {
    identityKey: new Uint8Array(X25519_PUBLIC_KEY_BYTES).fill(1),
    pqIdentityKey: new Uint8Array(XWING_PUBLIC_KEY_BYTES).fill(2),
    signedPreKey: new Uint8Array(X25519_PUBLIC_KEY_BYTES).fill(3),
    pqSignedPreKey: new Uint8Array(XWING_PUBLIC_KEY_BYTES).fill(4),
    signingKeyV2: publicKey,
  };
}

test('bundle v2: pesan kanonik deterministik dan terpengaruh setiap field', () => {
  const a = buildBundleV2Message(fields());
  const b = buildBundleV2Message(fields());
  assert.deepEqual(a, b);

  const changed = fields();
  changed.identityKey = new Uint8Array(X25519_PUBLIC_KEY_BYTES).fill(9);
  assert.notDeepEqual(buildBundleV2Message(changed), a);
});

test('bundle v2: tanda tangan ML-DSA-65 terverifikasi dengan domain yang benar', () => {
  const message = buildBundleV2Message(fields());
  const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.BUNDLE);
  assert.equal(signature.length, ML_DSA_65_LENGTHS.signature);
  assert.equal(
    verifyMlDsaSignature({ signature, message, publicKey, domain: PQ_V2_DOMAINS.BUNDLE }),
    true
  );
});

test('bundle v2: domain lain / pesan lain / kunci lain ditolak', () => {
  const message = buildBundleV2Message(fields());
  const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.BUNDLE);
  assert.equal(
    verifyMlDsaSignature({ signature, message, publicKey, domain: PQ_V2_DOMAINS.HANDSHAKE }),
    false
  );
  const otherMessage = buildBundleV2Message({ ...fields(), signedPreKey: new Uint8Array(32).fill(8) });
  assert.equal(
    verifyMlDsaSignature({ signature, message: otherMessage, publicKey, domain: PQ_V2_DOMAINS.BUNDLE }),
    false
  );
  const otherKey = mlDsaKeygen(new Uint8Array(32).fill(8)).publicKey;
  assert.equal(
    verifyMlDsaSignature({ signature, message, publicKey: otherKey, domain: PQ_V2_DOMAINS.BUNDLE }),
    false
  );
});

test('bundle v2: panjang tanda tangan salah langsung ditolak', () => {
  const message = buildBundleV2Message(fields());
  const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.BUNDLE);
  assert.equal(
    verifyMlDsaSignature({
      signature: signature.slice(0, 100),
      message,
      publicKey,
      domain: PQ_V2_DOMAINS.BUNDLE,
    }),
    false
  );
});
