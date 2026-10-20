// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import {
  ML_DSA_65_LENGTHS,
  PQ_V2_DOMAINS,
  mlDsaGetPublicKey,
  mlDsaKeygen,
  mlDsaSign,
  mlDsaVerify,
} from '@nyx/shared';

const SEED = new Uint8Array(32).fill(0x42);
const MESSAGE = new TextEncoder().encode('nyx pq v2 message');

describe('mlDsa (ML-DSA-65)', () => {
  it('menghasilkan keypair deterministik dari seed', () => {
    const a = mlDsaKeygen(SEED);
    const b = mlDsaKeygen(SEED);

    expect(a.publicKey.length).toBe(ML_DSA_65_LENGTHS.publicKey);
    expect(a.secretKey.length).toBe(ML_DSA_65_LENGTHS.secretKey);
    expect(Array.from(a.publicKey)).toEqual(Array.from(b.publicKey));
    expect(Array.from(a.secretKey)).toEqual(Array.from(b.secretKey));
    expect(Array.from(mlDsaGetPublicKey(a.secretKey))).toEqual(Array.from(a.publicKey));
  });

  it('menandatangani dan memverifikasi tanpa context', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const signature = mlDsaSign(MESSAGE, secretKey);

    expect(signature.length).toBe(ML_DSA_65_LENGTHS.signature);
    expect(mlDsaVerify(signature, MESSAGE, publicKey)).toBe(true);
  });

  it('memverifikasi dengan context domain dan menolak context yang salah', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const signature = mlDsaSign(MESSAGE, secretKey, PQ_V2_DOMAINS.BUNDLE);

    expect(mlDsaVerify(signature, MESSAGE, publicKey, PQ_V2_DOMAINS.BUNDLE)).toBe(true);
    expect(mlDsaVerify(signature, MESSAGE, publicKey, PQ_V2_DOMAINS.HANDSHAKE)).toBe(false);
    expect(mlDsaVerify(signature, MESSAGE, publicKey)).toBe(false);
  });

  it('menolak pesan, kunci, dan tanda tangan yang dimodifikasi', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const other = mlDsaKeygen(new Uint8Array(32).fill(0x43));
    const signature = mlDsaSign(MESSAGE, secretKey);

    const tamperedMessage = Uint8Array.from(MESSAGE);
    tamperedMessage[0] = (tamperedMessage[0] ?? 0) ^ 0x01;
    const tamperedSignature = Uint8Array.from(signature);
    tamperedSignature[0] = (tamperedSignature[0] ?? 0) ^ 0x01;

    expect(mlDsaVerify(signature, tamperedMessage, publicKey)).toBe(false);
    expect(mlDsaVerify(tamperedSignature, MESSAGE, publicKey)).toBe(false);
    expect(mlDsaVerify(signature, MESSAGE, other.publicKey)).toBe(false);
  });
});
