// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import { PQ_V2_DOMAINS, mlDsaKeygen, mlDsaSign, mlDsaVerify } from '@nyx/shared';

// [PQ v2 Fase 1.5 langkah 9] Mengunci kontrak tanda tangan pemulihan akun:
// worker menandatangani `messageString` yang SAMA dengan jalur v1
// (identifier:timestamp:nonce:newPassword:keys:pubEnc:pubPq:pubSign), tetapi
// dengan ML-DSA-65 dan context `PQ_V2_DOMAINS.RECOVERY`. Server memverifikasi
// terhadap `Device.signingKeyV2`. Test ini meniru byte yang sama tanpa worker.

const SEED = new Uint8Array(32).fill(0x2b);

function recoveryMessage(identifier = 'userhash', timestamp = 1_700_000_000_000): Uint8Array {
  const messageString =
    `${identifier}:${timestamp}:nonce-abc:NewPassword123:enc-priv:pub-enc:pub-pq:pub-sign`;
  return new TextEncoder().encode(messageString);
}

describe('recovery v2 (ML-DSA-65) signature contract', () => {
  it('menandatangani dan memverifikasi messageString pemulihan', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const message = recoveryMessage();
    const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.RECOVERY);

    expect(mlDsaVerify(signature, message, publicKey, PQ_V2_DOMAINS.RECOVERY)).toBe(true);
  });

  it('menolak tanda tangan bila satu field payload berubah', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const signature = mlDsaSign(recoveryMessage(), secretKey, PQ_V2_DOMAINS.RECOVERY);

    expect(mlDsaVerify(signature, recoveryMessage('userhash-lain'), publicKey, PQ_V2_DOMAINS.RECOVERY)).toBe(false);
    expect(mlDsaVerify(signature, recoveryMessage('userhash', 1_700_000_000_001), publicKey, PQ_V2_DOMAINS.RECOVERY)).toBe(false);
  });

  it('domain separation: context lain tidak memverifikasi tanda tangan pemulihan', () => {
    const { publicKey, secretKey } = mlDsaKeygen(SEED);
    const message = recoveryMessage();
    const signature = mlDsaSign(message, secretKey, PQ_V2_DOMAINS.RECOVERY);

    expect(mlDsaVerify(signature, message, publicKey, PQ_V2_DOMAINS.BUNDLE)).toBe(false);
    expect(mlDsaVerify(signature, message, publicKey)).toBe(false);
  });

  it('kunci pemulihan deterministik: seed yang sama menghasilkan kunci verifikasi yang sama', () => {
    const first = mlDsaKeygen(SEED);
    const second = mlDsaKeygen(SEED);
    expect(Buffer.from(first.publicKey).equals(Buffer.from(second.publicKey))).toBe(true);
  });
});
