// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42] Sumber record PIR: satu baris `User` + perangkat utamanya, dan
 * body JSON yang masuk ke slot. Ukuran record, padding, `ix`, dan checksum
 * diurus `@nyx/shared` (`encodePirRecord`).
 */

import { PIR_MAX_RECORD_BYTES, PIR_MIN_RECORD_BYTES } from '@nyx/shared';

/** Ukuran record default; sama dengan `PIR_RECORD_BYTES` bawaan. */
export const PIR_DEFAULT_RECORD_BYTES = 2048;

export interface PirRecordSource {
  id: string;
  encryptedProfile: string | null;
  isVerified: boolean;
  hasCompletedOnboarding: boolean;
  oprfIndex: string | null;
  device?: {
    publicKey: Uint8Array | null;
    pqPublicKey: Uint8Array | null;
    signingKey: Uint8Array | null;
  } | null;
}

function base64url(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes) return null;
  return Buffer.from(bytes).toString('base64url');
}

/** Body record (JSON) tanpa padding; dipakai builder shard (`docs/42`). */
export function pirRecordBody(source: PirRecordSource): Uint8Array {
  const record = {
    id: source.id,
    encryptedProfile: source.encryptedProfile,
    isVerified: source.isVerified,
    hasCompletedOnboarding: source.hasCompletedOnboarding,
    publicKey: base64url(source.device?.publicKey),
    pqPublicKey: base64url(source.device?.pqPublicKey),
    signingKey: base64url(source.device?.signingKey),
  };
  return new Uint8Array(Buffer.from(JSON.stringify(record), 'utf8'));
}

export function parsePirRecordBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return PIR_DEFAULT_RECORD_BYTES;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error('PIR: PIR_RECORD_BYTES harus bilangan bulat positif');
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < PIR_MIN_RECORD_BYTES || value > PIR_MAX_RECORD_BYTES) {
    throw new Error(
      `PIR: PIR_RECORD_BYTES harus ${PIR_MIN_RECORD_BYTES}..${PIR_MAX_RECORD_BYTES}`,
    );
  }
  return value;
}
