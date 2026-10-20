// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
  ML_DSA_65_PUBLIC_KEY_BYTES,
  ML_DSA_65_SECRET_KEY_BYTES,
  ML_DSA_65_SIGNATURE_BYTES,
} from './cryptoSuite.js';

export interface MlDsaKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

const contextEncoder = new TextEncoder();

export const ML_DSA_65_LENGTHS = {
  seed: 32,
  publicKey: ML_DSA_65_PUBLIC_KEY_BYTES,
  secretKey: ML_DSA_65_SECRET_KEY_BYTES,
  signature: ML_DSA_65_SIGNATURE_BYTES,
} as const;

export function mlDsaContext(domain: string): Uint8Array {
  const bytes = contextEncoder.encode(domain);
  if (bytes.length > 255) {
    throw new Error('ml-dsa: context melebihi 255 byte');
  }
  return bytes;
}

export function mlDsaKeygen(seed?: Uint8Array): MlDsaKeyPair {
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey, secretKey };
}

export function mlDsaGetPublicKey(secretKey: Uint8Array): Uint8Array {
  return ml_dsa65.getPublicKey(secretKey);
}

export function mlDsaSign(message: Uint8Array, secretKey: Uint8Array, domain?: string): Uint8Array {
  return domain
    ? ml_dsa65.sign(message, secretKey, { context: mlDsaContext(domain) })
    : ml_dsa65.sign(message, secretKey);
}

export function mlDsaVerify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
  domain?: string,
): boolean {
  return domain
    ? ml_dsa65.verify(signature, message, publicKey, { context: mlDsaContext(domain) })
    : ml_dsa65.verify(signature, message, publicKey);
}
