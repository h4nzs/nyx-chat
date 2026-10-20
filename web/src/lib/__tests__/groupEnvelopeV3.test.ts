// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import {
  GROUP_ENVELOPE_V2_BYTES,
  GROUP_ENVELOPE_V3_BYTES,
  GROUP_ENVELOPE_V4_BYTES,
  constantTimeEqual,
  deriveGroupSenderKeyId,
  packGroupEnvelope,
  parseGroupEnvelope,
} from '@nyx/shared';

const chainId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const chainKey = new Uint8Array(32).fill(0xaa);
const metadataKey = new Uint8Array(32).fill(0xbb);
const senderKeyId = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
const signingKeyV2 = new Uint8Array(1952).fill(0x5a);

describe('group envelope v3', () => {
  it('round-trip v2 tetap 77 byte dan format beku', () => {
    const packed = packGroupEnvelope({ version: 2, chainId, iteration: 7, chainKey, metadataKey });
    expect(packed.length).toBe(GROUP_ENVELOPE_V2_BYTES);
    expect(packed.length).toBe(77);
    expect(packed[0]).toBe(0x02);
    expect(new DataView(packed.buffer).getUint32(9, false)).toBe(7);

    const parsed = parseGroupEnvelope(packed);
    expect(parsed.version).toBe(2);
    expect(parsed.chainId).toEqual(chainId);
    expect(parsed.iteration).toBe(7);
    expect(parsed.chainKey).toEqual(chainKey);
    expect(parsed.metadataKey).toEqual(metadataKey);
    expect('senderKeyId' in parsed).toBe(false);
  });

  it('round-trip v3 = 85 byte dengan senderKeyId di akhir', () => {
    const packed = packGroupEnvelope({ version: 3, chainId, iteration: 0xdeadbeef, chainKey, metadataKey, senderKeyId });
    expect(packed.length).toBe(GROUP_ENVELOPE_V3_BYTES);
    expect(packed.length).toBe(85);
    expect(packed[0]).toBe(0x03);
    expect(packed.slice(77)).toEqual(senderKeyId);

    const parsed = parseGroupEnvelope(packed);
    expect(parsed.version).toBe(3);
    expect(parsed.iteration).toBe(0xdeadbeef);
    if (parsed.version !== 3) throw new Error('unreachable');
    expect(parsed.senderKeyId).toEqual(senderKeyId);
    expect(parsed.chainKey).toEqual(chainKey);
  });

  it('menolak versi dan panjang yang tidak dikenal', () => {
    const packed = packGroupEnvelope({ version: 2, chainId, iteration: 1, chainKey, metadataKey });
    const wrongVersion = packed.slice();
    wrongVersion[0] = 0x05;
    expect(() => parseGroupEnvelope(wrongVersion)).toThrow(/versi/);
    expect(() => parseGroupEnvelope(packed.slice(0, 76))).toThrow(/panjang/);
    expect(() => parseGroupEnvelope(new Uint8Array(0))).toThrow(/kosong/);
    const truncatedV3 = packGroupEnvelope({ version: 3, chainId, iteration: 1, chainKey, metadataKey, senderKeyId }).slice(0, 84);
    expect(() => parseGroupEnvelope(truncatedV3)).toThrow(/panjang v3/);
  });

  it('round-trip v4 = 2037 byte membawa signingKeyV2 setelah senderKeyId', () => {
    const derivedId = deriveGroupSenderKeyId(signingKeyV2);
    const packed = packGroupEnvelope({
      version: 4,
      chainId,
      iteration: 3,
      chainKey,
      metadataKey,
      senderKeyId: derivedId,
      signingKeyV2,
    });
    expect(packed.length).toBe(GROUP_ENVELOPE_V4_BYTES);
    expect(packed.length).toBe(2037);
    expect(packed[0]).toBe(0x04);
    expect(packed.slice(77, 85)).toEqual(derivedId);
    expect(packed.slice(85)).toEqual(signingKeyV2);

    const parsed = parseGroupEnvelope(packed);
    expect(parsed.version).toBe(4);
    if (parsed.version !== 4) throw new Error('unreachable');
    expect(parsed.iteration).toBe(3);
    expect(parsed.senderKeyId).toEqual(derivedId);
    expect(parsed.signingKeyV2).toEqual(signingKeyV2);
    expect(parsed.chainKey).toEqual(chainKey);
    expect(parsed.metadataKey).toEqual(metadataKey);

    expect(() => parseGroupEnvelope(packed.slice(0, 2036))).toThrow(/panjang v4/);
  });

  it('v4 menolak signingKeyV2 dengan panjang salah dan senderKeyId yang tidak cocok', () => {
    expect(() =>
      packGroupEnvelope({
        version: 4,
        chainId,
        iteration: 0,
        chainKey,
        metadataKey,
        senderKeyId: deriveGroupSenderKeyId(signingKeyV2),
        signingKeyV2: new Uint8Array(1951).fill(1),
      })
    ).toThrow(/signingKeyV2/);

    expect(() =>
      packGroupEnvelope({
        version: 4,
        chainId,
        iteration: 0,
        chainKey,
        metadataKey,
        senderKeyId: deriveGroupSenderKeyId(new Uint8Array(1952).fill(9)),
        signingKeyV2,
      })
    ).toThrow(/senderKeyId/);
  });

  it('menolak iteration di luar u32 dan panjang field salah', () => {
    expect(() => packGroupEnvelope({ version: 2, chainId, iteration: -1, chainKey, metadataKey })).toThrow(/u32/);
    expect(() => packGroupEnvelope({ version: 2, chainId, iteration: 0x1_0000_0000, chainKey, metadataKey })).toThrow(/u32/);
    expect(() => packGroupEnvelope({ version: 3, chainId, iteration: 1, chainKey, metadataKey, senderKeyId: new Uint8Array(7) })).toThrow(/senderKeyId/);
  });

  it('deriveGroupSenderKeyId deterministik, 8 byte, dan domain-separated', () => {
    const a = new Uint8Array(1952).fill(0x11);
    const b = new Uint8Array(1952).fill(0x12);
    const idA1 = deriveGroupSenderKeyId(a);
    const idA2 = deriveGroupSenderKeyId(a);
    expect(idA1.length).toBe(8);
    expect(idA1).toEqual(idA2);
    expect(idA1).not.toEqual(deriveGroupSenderKeyId(b));
  });

  it('constantTimeEqual', () => {
    expect(constantTimeEqual(chainId, chainId.slice())).toBe(true);
    const other = chainId.slice();
    other[0] = 0xff;
    expect(constantTimeEqual(chainId, other)).toBe(false);
    expect(constantTimeEqual(chainId, chainId.slice(0, 4))).toBe(false);
  });
});
