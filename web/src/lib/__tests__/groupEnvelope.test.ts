// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { describe, expect, it } from 'vitest';
import {
  GROUP_ENVELOPE_V4_BYTES,
  constantTimeEqual,
  deriveGroupSenderKeyId,
  packGroupEnvelope,
  parseGroupEnvelope,
} from '@nyx/shared';

const chainId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const chainKey = new Uint8Array(32).fill(0xaa);
const metadataKey = new Uint8Array(32).fill(0xbb);
const signingKeyV2 = new Uint8Array(1952).fill(0x5a);
const senderKeyId = deriveGroupSenderKeyId(signingKeyV2);

describe('group envelope v4', () => {
  it('round-trip 2037 byte: senderKeyId lalu signingKeyV2', () => {
    const packed = packGroupEnvelope({
      version: 4,
      chainId,
      iteration: 3,
      chainKey,
      metadataKey,
      senderKeyId,
      signingKeyV2,
    });
    expect(packed.length).toBe(GROUP_ENVELOPE_V4_BYTES);
    expect(packed.length).toBe(2037);
    expect(packed[0]).toBe(0x04);
    expect(new DataView(packed.buffer).getUint32(9, false)).toBe(3);
    expect(packed.slice(77, 85)).toEqual(senderKeyId);
    expect(packed.slice(85)).toEqual(signingKeyV2);

    const parsed = parseGroupEnvelope(packed);
    expect(parsed.version).toBe(4);
    expect(parsed.iteration).toBe(3);
    expect(parsed.chainId).toEqual(chainId);
    expect(parsed.chainKey).toEqual(chainKey);
    expect(parsed.metadataKey).toEqual(metadataKey);
    expect(parsed.senderKeyId).toEqual(senderKeyId);
    expect(parsed.signingKeyV2).toEqual(signingKeyV2);
  });

  it('menerima iteration batas u32', () => {
    const packed = packGroupEnvelope({
      version: 4,
      chainId,
      iteration: 0xdeadbeef,
      chainKey,
      metadataKey,
      senderKeyId,
      signingKeyV2,
    });
    expect(parseGroupEnvelope(packed).iteration).toBe(0xdeadbeef);
  });

  it('menolak versi lama (v2/v3) — tidak ada pembaca kedua', () => {
    const packed = packGroupEnvelope({
      version: 4,
      chainId,
      iteration: 1,
      chainKey,
      metadataKey,
      senderKeyId,
      signingKeyV2,
    });
    for (const version of [0x02, 0x03, 0x05]) {
      const wrong = packed.slice();
      wrong[0] = version;
      expect(() => parseGroupEnvelope(wrong)).toThrow(/hanya v4/);
    }
    expect(() => parseGroupEnvelope(new Uint8Array(0))).toThrow(/kosong/);
  });

  it('menolak panjang yang salah (termasuk envelope v2 77 byte)', () => {
    const packed = packGroupEnvelope({
      version: 4,
      chainId,
      iteration: 1,
      chainKey,
      metadataKey,
      senderKeyId,
      signingKeyV2,
    });
    expect(() => parseGroupEnvelope(packed.slice(0, 2036))).toThrow(/panjang v4/);
    expect(() => parseGroupEnvelope(packed.slice(0, 85))).toThrow(/panjang v4/);

    const legacyV2 = new Uint8Array(77);
    legacyV2[0] = 0x02;
    expect(() => parseGroupEnvelope(legacyV2)).toThrow(/hanya v4/);
  });

  it('menolak signingKeyV2 dengan panjang salah dan senderKeyId yang tidak cocok', () => {
    expect(() =>
      packGroupEnvelope({
        version: 4,
        chainId,
        iteration: 0,
        chainKey,
        metadataKey,
        senderKeyId,
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

    expect(() =>
      packGroupEnvelope({
        version: 4,
        chainId,
        iteration: 0,
        chainKey,
        metadataKey,
        senderKeyId: new Uint8Array(7),
        signingKeyV2,
      })
    ).toThrow(/senderKeyId/);
  });

  it('menolak iteration di luar u32 dan panjang field salah', () => {
    const base = { version: 4 as const, chainId, chainKey, metadataKey, senderKeyId, signingKeyV2 };
    expect(() => packGroupEnvelope({ ...base, iteration: -1 })).toThrow(/u32/);
    expect(() => packGroupEnvelope({ ...base, iteration: 0x1_0000_0000 })).toThrow(/u32/);
    expect(() => packGroupEnvelope({ ...base, iteration: 1, chainId: new Uint8Array(7) })).toThrow(/chainId/);
    expect(() => packGroupEnvelope({ ...base, iteration: 1, chainKey: new Uint8Array(31) })).toThrow(/chainKey/);
    expect(() => packGroupEnvelope({ ...base, iteration: 1, metadataKey: new Uint8Array(33) })).toThrow(/metadataKey/);
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
