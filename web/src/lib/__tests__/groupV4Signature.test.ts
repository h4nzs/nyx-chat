// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import { PQ_V2_DOMAINS, mlDsaKeygen, mlDsaSign, mlDsaVerify } from '@nyx/shared';

// [PQ v4 Fase 1.5] Mengunci framing persis yang dipakai `crypto.worker.ts`
// untuk `group_ratchet_encrypt`/`group_ratchet_decrypt`/`group_decrypt_skipped`:
// data tanda tangan = u32(n) big-endian || (nonce(24) || ciphertext).
// Test ini tidak memanggil worker (butuh WebWorker) — ia meniru byte yang sama
// agar perubahan framing/domain terdeteksi.

const SEED = new Uint8Array(32).fill(0x17);

function frame(n: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, n, false);
  out.set(body, 4);
  return out;
}

function nonceCiphertext(): Uint8Array {
  const nonce = new Uint8Array(24).fill(0x5a);
  const ct = new Uint8Array(32).fill(0x9c);
  const combined = new Uint8Array(nonce.length + ct.length);
  combined.set(nonce, 0);
  combined.set(ct, nonce.length);
  return combined;
}

describe('group v4 (ML-DSA-65) message signature framing', () => {
  it('menandatangani dan memverifikasi dengan framing u32(n)||nonce||ct', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const dataToSign = frame(0, nonceCiphertext());
    const signature = mlDsaSign(dataToSign, secretKey, PQ_V2_DOMAINS.GROUP);

    expect(mlDsaVerify(signature, dataToSign, publicKey, PQ_V2_DOMAINS.GROUP)).toBe(true);
  });

  it('menolak bila nilai n (counter) berubah', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const body = nonceCiphertext();
    const signature = mlDsaSign(frame(3, body), secretKey, PQ_V2_DOMAINS.GROUP);

    expect(mlDsaVerify(signature, frame(4, body), publicKey, PQ_V2_DOMAINS.GROUP)).toBe(false);
  });

  it('menolak bila ciphertext berubah', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const signature = mlDsaSign(frame(1, nonceCiphertext()), secretKey, PQ_V2_DOMAINS.GROUP);
    const tampered = nonceCiphertext();
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;

    expect(mlDsaVerify(signature, frame(1, tampered), publicKey, PQ_V2_DOMAINS.GROUP)).toBe(false);
  });

  it('domain GROUP terpisah dari domain lain', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const data = frame(0, nonceCiphertext());
    const signature = mlDsaSign(data, secretKey, PQ_V2_DOMAINS.GROUP);

    expect(mlDsaVerify(signature, data, publicKey, PQ_V2_DOMAINS.HANDSHAKE)).toBe(false);
    expect(mlDsaVerify(signature, data, publicKey, PQ_V2_DOMAINS.BUNDLE)).toBe(false);
  });
});
