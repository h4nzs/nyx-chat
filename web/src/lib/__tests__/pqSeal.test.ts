// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, it, expect } from 'vitest';
import {
  PQ_SEAL_V2_CT_BYTES,
  PQ_SEAL_V2_HEADER_BYTES,
  PQ_SEAL_V2_MAGIC,
  PQ_SEAL_V2_MIN_BYTES,
  PQ_SEAL_V2_NONCE_BYTES,
  deserializePqSealV2,
  isPqSealV2,
  serializePqSealV2,
} from '@nyx/shared';

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('pqSeal v2 (X-Wing-only sealed box)', () => {
  it('round-trip serialize/deserialize tanpa kehilangan byte', () => {
    const ciphertext = bytes(PQ_SEAL_V2_CT_BYTES, 0x11);
    const nonce = bytes(PQ_SEAL_V2_NONCE_BYTES, 0x22);
    const sealed = bytes(48, 0x33);

    const envelope = serializePqSealV2({ ciphertext, nonce, sealed });

    expect(envelope.length).toBe(PQ_SEAL_V2_HEADER_BYTES + PQ_SEAL_V2_CT_BYTES + PQ_SEAL_V2_NONCE_BYTES + sealed.length);
    expect(new DataView(envelope.buffer).getUint32(0, false)).toBe(PQ_SEAL_V2_MAGIC);

    const parsed = deserializePqSealV2(envelope);
    expect(parsed.ciphertext).toEqual(ciphertext);
    expect(parsed.nonce).toEqual(nonce);
    expect(parsed.sealed).toEqual(sealed);
  });

  it('isPqSealV2 menerima envelope v2 dan menolak buffer pendek/non-magic', () => {
    const envelope = serializePqSealV2({
      ciphertext: bytes(PQ_SEAL_V2_CT_BYTES, 0x01),
      nonce: bytes(PQ_SEAL_V2_NONCE_BYTES, 0x02),
      sealed: bytes(16, 0x03),
    });
    expect(isPqSealV2(envelope)).toBe(true);
    expect(envelope.length).toBe(PQ_SEAL_V2_MIN_BYTES);

    // Bentuk v1 (32B ephemeral pub + 1120B ct + 24B nonce + ct) yang bukan magic.
    const v1Shaped = new Uint8Array(32 + 1120 + 24 + 16);
    expect(isPqSealV2(v1Shaped)).toBe(false);

    expect(isPqSealV2(new Uint8Array(PQ_SEAL_V2_MIN_BYTES - 1))).toBe(false);
  });

  it('menolak ciphertext/nonce dengan panjang salah saat serialisasi', () => {
    expect(() =>
      serializePqSealV2({ ciphertext: bytes(PQ_SEAL_V2_CT_BYTES - 1, 0), nonce: bytes(24, 0), sealed: bytes(16, 0) })
    ).toThrow();
    expect(() =>
      serializePqSealV2({ ciphertext: bytes(PQ_SEAL_V2_CT_BYTES, 0), nonce: bytes(20, 0), sealed: bytes(16, 0) })
    ).toThrow();
    expect(() =>
      serializePqSealV2({ ciphertext: bytes(PQ_SEAL_V2_CT_BYTES, 0), nonce: bytes(24, 0), sealed: bytes(8, 0) })
    ).toThrow();
  });

  it('deserializePqSealV2 menolak buffer pendek dan magic salah', () => {
    expect(() => deserializePqSealV2(new Uint8Array(PQ_SEAL_V2_MIN_BYTES - 1))).toThrow();
    const wrongMagic = serializePqSealV2({
      ciphertext: bytes(PQ_SEAL_V2_CT_BYTES, 0),
      nonce: bytes(PQ_SEAL_V2_NONCE_BYTES, 0),
      sealed: bytes(16, 0),
    });
    wrongMagic[0] = 0x00;
    expect(() => deserializePqSealV2(wrongMagic)).toThrow();
  });
});
