// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// packages/shared/src/pqBundle.ts
//
// [docs/35 Fase 1.2-1.3] Kanonik pesan pre-key bundle v2 yang ditandatangani
// ML-DSA-65. Dipakai KLIENT (menandatangani) dan SERVER (memverifikasi), jadi
// urutan/encode field wajib identik. Setiap field diawali prefix panjang u32 BE
// agar tidak ambigu bila ukuran kunci berubah di masa depan. Domain separation
// dilakukan lewat ML-DSA context `PQ_V2_DOMAINS.BUNDLE`, bukan di sini.
import {
  ML_DSA_65_PUBLIC_KEY_BYTES,
  X25519_PUBLIC_KEY_BYTES,
  XWING_PUBLIC_KEY_BYTES,
} from './cryptoSuite.js';

export interface BundleV2SigningFields {
  identityKey: Uint8Array;
  pqIdentityKey: Uint8Array;
  signedPreKey: Uint8Array;
  pqSignedPreKey: Uint8Array;
  signingKeyV2: Uint8Array;
}

export const BUNDLE_V2_FIELD_LENGTHS = {
  identityKey: X25519_PUBLIC_KEY_BYTES,
  pqIdentityKey: XWING_PUBLIC_KEY_BYTES,
  signedPreKey: X25519_PUBLIC_KEY_BYTES,
  pqSignedPreKey: XWING_PUBLIC_KEY_BYTES,
  signingKeyV2: ML_DSA_65_PUBLIC_KEY_BYTES,
} as const;

function pushField(out: number[], bytes: Uint8Array): void {
  const len = bytes.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  for (let i = 0; i < len; i += 1) out.push(bytes[i] ?? 0);
}

export function buildBundleV2Message(fields: BundleV2SigningFields): Uint8Array {
  const out: number[] = [];
  pushField(out, fields.identityKey);
  pushField(out, fields.pqIdentityKey);
  pushField(out, fields.signedPreKey);
  pushField(out, fields.pqSignedPreKey);
  pushField(out, fields.signingKeyV2);
  return Uint8Array.from(out);
}
