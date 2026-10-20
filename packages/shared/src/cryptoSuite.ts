// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

export const PQ_V2_SUITE = 'nyx-pq-v2';
export const CRYPTO_VERSION_V1 = 1;
export const CRYPTO_VERSION_V2 = 2;

export const ML_DSA_65_ALGORITHM = 'ML-DSA-65';
export const ML_DSA_65_PUBLIC_KEY_BYTES = 1952;
export const ML_DSA_65_SECRET_KEY_BYTES = 4032;
export const ML_DSA_65_SIGNATURE_BYTES = 3309;
export const ML_DSA_65_SEED_BYTES = 32;

export const X25519_PUBLIC_KEY_BYTES = 32;

export const XWING_ALGORITHM = 'X-Wing';
export const XWING_PUBLIC_KEY_BYTES = 1216;
export const XWING_CIPHERTEXT_BYTES = 1120;
export const XWING_SHARED_SECRET_BYTES = 32;
export const XWING_SEED_BYTES = 32;

export const PQ_V2_DOMAINS = {
  BUNDLE: 'NYX-PQ-BUNDLE-V2',
  HANDSHAKE: 'NYX-PQ-HANDSHAKE-V2',
  SEAL: 'NYX-PQ-SEAL-V2',
  GROUP: 'NYX-PQ-GROUP-V4',
  KT_VALUE: 'NYX-KT-VALUE-V2',
  CREDENTIAL: 'NYX-CRED-V2',
  RECOVERY: 'NYX-PQ-RECOVERY-V2',
  LINK: 'NYX-PQ-LINK-V2',
} as const;

export type PqV2Domain = (typeof PQ_V2_DOMAINS)[keyof typeof PQ_V2_DOMAINS];

export const PQ_V2_PRIMITIVES = {
  suite: PQ_V2_SUITE,
  cryptoVersion: CRYPTO_VERSION_V2,
  kem: XWING_ALGORITHM,
  signature: ML_DSA_65_ALGORITHM,
  aead: 'XChaCha20-Poly1305',
  hash: 'BLAKE2b-256',
} as const;

export interface CryptoSuiteDescriptor {
  suite: string;
  cryptoVersion: number;
  kem: string;
  signature: string;
}

export function describeCryptoSuite(cryptoVersion: number): CryptoSuiteDescriptor {
  if (cryptoVersion === CRYPTO_VERSION_V2) {
    return {
      suite: PQ_V2_SUITE,
      cryptoVersion: CRYPTO_VERSION_V2,
      kem: XWING_ALGORITHM,
      signature: ML_DSA_65_ALGORITHM,
    };
  }
  return {
    suite: 'nyx-v1',
    cryptoVersion: CRYPTO_VERSION_V1,
    kem: 'X25519+X-Wing',
    signature: 'Ed25519',
  };
}
