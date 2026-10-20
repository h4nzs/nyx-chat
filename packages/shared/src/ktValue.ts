// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { ML_DSA_65_PUBLIC_KEY_BYTES, X25519_PUBLIC_KEY_BYTES, XWING_PUBLIC_KEY_BYTES } from './cryptoSuite.js';

export const KT_VALUE_VERSION_V1 = 1;
export const KT_VALUE_VERSION_V2 = 2;

export const KT_ED25519_SIGNING_KEY_BYTES = 32;

export const KT_VALUE_V1_BYTES =
  1 +
  1 +
  X25519_PUBLIC_KEY_BYTES +
  XWING_PUBLIC_KEY_BYTES +
  KT_ED25519_SIGNING_KEY_BYTES +
  4;

export const KT_VALUE_V2_BYTES = KT_VALUE_V1_BYTES + ML_DSA_65_PUBLIC_KEY_BYTES;

export interface ParsedKtValue {
  version: number;
  keyVersion: number;
  identityKey: Uint8Array;
  pqIdentityKey: Uint8Array;
  signingKey: Uint8Array;
  signingKeyV2?: Uint8Array;
  updatedAtDay: number;
}

const V1_OFFSET_PQ = 2 + X25519_PUBLIC_KEY_BYTES;
const V1_OFFSET_SIGN = V1_OFFSET_PQ + XWING_PUBLIC_KEY_BYTES;
const V1_OFFSET_DAY = V1_OFFSET_SIGN + KT_ED25519_SIGNING_KEY_BYTES;
const V2_OFFSET_SIGN_V2 = V1_OFFSET_DAY;
const V2_OFFSET_DAY = V2_OFFSET_SIGN_V2 + ML_DSA_65_PUBLIC_KEY_BYTES;

export function parseKtValueBytes(value: Uint8Array): ParsedKtValue {
  if (value.length < 2) {
    throw new Error(`kt: nilai log terlalu pendek (${value.length})`);
  }
  const version = value[0]!;
  const keyVersion = value[1]!;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);

  if (version === KT_VALUE_VERSION_V1) {
    if (value.length < KT_VALUE_V1_BYTES) {
      throw new Error(`kt: nilai log v1 terlalu pendek (${value.length} < ${KT_VALUE_V1_BYTES})`);
    }
    return {
      version,
      keyVersion,
      identityKey: value.subarray(2, V1_OFFSET_PQ).slice(),
      pqIdentityKey: value.subarray(V1_OFFSET_PQ, V1_OFFSET_SIGN).slice(),
      signingKey: value.subarray(V1_OFFSET_SIGN, V1_OFFSET_DAY).slice(),
      updatedAtDay: view.getUint32(V1_OFFSET_DAY, false),
    };
  }

  if (version === KT_VALUE_VERSION_V2) {
    if (value.length < KT_VALUE_V2_BYTES) {
      throw new Error(`kt: nilai log v2 terlalu pendek (${value.length} < ${KT_VALUE_V2_BYTES})`);
    }
    return {
      version,
      keyVersion,
      identityKey: value.subarray(2, V1_OFFSET_PQ).slice(),
      pqIdentityKey: value.subarray(V1_OFFSET_PQ, V1_OFFSET_SIGN).slice(),
      signingKey: value.subarray(V1_OFFSET_SIGN, V1_OFFSET_DAY).slice(),
      signingKeyV2: value.subarray(V2_OFFSET_SIGN_V2, V2_OFFSET_DAY).slice(),
      updatedAtDay: view.getUint32(V2_OFFSET_DAY, false),
    };
  }

  throw new Error(`kt: versi nilai log tidak dikenal (${version})`);
}

export function encodeKtValueV2(entry: {
  identityKey: Uint8Array;
  pqIdentityKey: Uint8Array;
  signingKey: Uint8Array;
  signingKeyV2: Uint8Array;
  keyVersion: number;
  updatedAtDay: number;
}): Uint8Array {
  if (entry.identityKey.length !== X25519_PUBLIC_KEY_BYTES) throw new Error('kt: identityKey tidak sah');
  if (entry.pqIdentityKey.length !== XWING_PUBLIC_KEY_BYTES) throw new Error('kt: pqIdentityKey tidak sah');
  if (entry.signingKey.length !== KT_ED25519_SIGNING_KEY_BYTES) throw new Error('kt: signingKey tidak sah');
  if (entry.signingKeyV2.length !== ML_DSA_65_PUBLIC_KEY_BYTES) throw new Error('kt: signingKeyV2 tidak sah');

  const value = new Uint8Array(KT_VALUE_V2_BYTES);
  let offset = 0;
  value[offset++] = KT_VALUE_VERSION_V2;
  value[offset++] = entry.keyVersion & 0xff;
  value.set(entry.identityKey, offset);
  offset += X25519_PUBLIC_KEY_BYTES;
  value.set(entry.pqIdentityKey, offset);
  offset += XWING_PUBLIC_KEY_BYTES;
  value.set(entry.signingKey, offset);
  offset += KT_ED25519_SIGNING_KEY_BYTES;
  value.set(entry.signingKeyV2, offset);
  offset += ML_DSA_65_PUBLIC_KEY_BYTES;
  new DataView(value.buffer).setUint32(offset, entry.updatedAtDay >>> 0, false);
  return value;
}
