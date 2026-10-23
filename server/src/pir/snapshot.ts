// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4b] Bentuk snapshot PIR v1.
 *
 * Snapshot adalah input offline untuk sidecar ChalametPIR. Setiap entri
 * memetakan OPRF index 32 byte ke record profil berukuran tetap. Record diberi
 * padding spasi di belakang JSON supaya ukurannya seragam tanpa memotong
 * ciphertext.
 */

export const PIR_MIN_RECORD_BYTES = 256;
export const PIR_MAX_RECORD_BYTES = 16 * 1024;
export const PIR_DEFAULT_RECORD_BYTES = 2048;
const INDEX_HEX = /^[0-9a-f]{64}$/;

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

export interface PirSnapshotEntry {
  oprf: string;
  value: string;
}

export interface PirSnapshot {
  epoch: number;
  recordBytes: number;
  entries: PirSnapshotEntry[];
}

function parseInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`PIR: ${label} harus bilangan bulat positif`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PIR: ${label} harus bilangan bulat positif`);
  }
  return value;
}

export function parsePirRecordBytes(raw: string | undefined): number {
  const value = parseInteger(raw, PIR_DEFAULT_RECORD_BYTES, 'PIR_RECORD_BYTES');
  if (value < PIR_MIN_RECORD_BYTES || value > PIR_MAX_RECORD_BYTES) {
    throw new Error(
      `PIR: PIR_RECORD_BYTES harus ${PIR_MIN_RECORD_BYTES}..${PIR_MAX_RECORD_BYTES}`,
    );
  }
  return value;
}

export function parsePirEpoch(raw: string | undefined, now = Date.now()): number {
  return parseInteger(raw, now, 'PIR_EPOCH');
}

function base64url(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes) return null;
  return Buffer.from(bytes).toString('base64url');
}

function encodeRecord(source: PirRecordSource, recordBytes: number): string {
  const record = {
    id: source.id,
    encryptedProfile: source.encryptedProfile,
    isVerified: source.isVerified,
    hasCompletedOnboarding: source.hasCompletedOnboarding,
    publicKey: base64url(source.device?.publicKey),
    pqPublicKey: base64url(source.device?.pqPublicKey),
    signingKey: base64url(source.device?.signingKey),
  };
  const json = Buffer.from(JSON.stringify(record), 'utf8');
  if (json.length > recordBytes) {
    throw new Error(
      `PIR: record user ${source.id} berukuran ${json.length} byte, melebihi ${recordBytes}`,
    );
  }
  const padded = Buffer.alloc(recordBytes, 0x20);
  json.copy(padded);
  return padded.toString('base64url');
}

export function buildPirSnapshot(
  sources: readonly PirRecordSource[],
  recordBytes: number,
  epoch: number,
): PirSnapshot {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error('PIR: epoch harus bilangan bulat positif');
  }
  if (recordBytes < PIR_MIN_RECORD_BYTES || recordBytes > PIR_MAX_RECORD_BYTES) {
    throw new Error(`PIR: recordBytes harus ${PIR_MIN_RECORD_BYTES}..${PIR_MAX_RECORD_BYTES}`);
  }
  if (sources.length === 0) {
    throw new Error('PIR: snapshot kosong; minimal satu user dengan oprfIndex');
  }

  const seen = new Set<string>();
  const entries: PirSnapshotEntry[] = [];
  for (const source of sources) {
    const oprfHex = source.oprfIndex;
    if (!oprfHex || !INDEX_HEX.test(oprfHex)) {
      throw new Error(`PIR: oprfIndex user ${source.id} bukan 32 byte hex huruf kecil`);
    }
    if (seen.has(oprfHex)) {
      throw new Error(`PIR: oprfIndex duplikat untuk user ${source.id}`);
    }
    seen.add(oprfHex);
    entries.push({
      oprf: Buffer.from(oprfHex, 'hex').toString('base64url'),
      value: encodeRecord(source, recordBytes),
    });
  }
  return { epoch, recordBytes, entries };
}
