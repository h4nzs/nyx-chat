// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP2] Manifest shard PIR + kunci penanda tangan ML-DSA-65.
 *
 * Manifest adalah satu-satunya hal yang membuat dua server PIR bisa
 * dibandingkan: klien menolak (`PIR_DESYNC`) bila manifest A dan B berbeda
 * selain `operator`. Karena itu tanda tangan mencakup `operator` dan `keyId`,
 * sedangkan perbandingan antar-server memakai `pirManifestsAgree()` dari
 * `@nyx/shared`.
 *
 * Kunci tidak pernah dibuat otomatis di sini. Operator menyediakan berkas
 * (0600) berisi 32-byte seed atau secret key ML-DSA-65 penuh; kunci publik dan
 * `keyId` diturunkan dari situ, jadi tidak ada dua sumber kebenaran.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ML_DSA_65_SECRET_KEY_BYTES,
  mlDsaGetPublicKey,
  mlDsaKeygen,
  mlDsaSign,
  mlDsaVerify,
  pirManifestMessage,
  type PirManifest,
} from '@nyx/shared';

/** Domain ML-DSA (context), terpisah dari domain pesan di `@nyx/shared`. */
export const PIR_MANIFEST_DOMAIN = 'nyx-pir-manifest-v1';

export interface PirSigningKey {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** sha256 hex atas public key; dipakai sebagai `keyId` di manifest. */
  keyId: string;
}

export function pirKeyId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

/** Terima 32-byte seed (disarankan) atau secret key ML-DSA-65 penuh. */
export function loadPirSigningKeyBytes(bytes: Uint8Array): PirSigningKey {
  if (bytes.length === 32) {
    const pair = mlDsaKeygen(bytes);
    return { ...pair, keyId: pirKeyId(pair.publicKey) };
  }
  if (bytes.length === ML_DSA_65_SECRET_KEY_BYTES) {
    const publicKey = mlDsaGetPublicKey(bytes);
    return { secretKey: bytes, publicKey, keyId: pirKeyId(publicKey) };
  }
  throw new Error(
    `PIR: kunci penanda tangan harus 32 byte (seed) atau ${ML_DSA_65_SECRET_KEY_BYTES} byte (secret key)`,
  );
}

export async function loadPirSigningKey(path: string): Promise<PirSigningKey> {
  const raw = await readFile(path);
  const bytes = raw.toString('utf8').trim();
  // Berkas boleh berisi hex/base64url (hasil `pir:keygen`) atau biner mentah.
  const decoded = decodeKeyFile(bytes);
  return loadPirSigningKeyBytes(decoded ?? new Uint8Array(raw));
}

function decodeKeyFile(text: string): Uint8Array | null {
  if (/^[0-9a-fA-F]{64}$/.test(text)) return new Uint8Array(Buffer.from(text, 'hex'));
  if (/^[A-Za-z0-9_-]{43,}$/.test(text)) {
    const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
    if (bytes.length === 32 || bytes.length === ML_DSA_65_SECRET_KEY_BYTES) return bytes;
  }
  return null;
}

export function signPirManifest(manifest: PirManifest, key: PirSigningKey): string {
  if (manifest.keyId !== key.keyId) {
    throw new Error('PIR: keyId manifest tidak cocok dengan kunci penanda tangan');
  }
  const signature = mlDsaSign(pirManifestMessage(manifest), key.secretKey, PIR_MANIFEST_DOMAIN);
  return Buffer.from(signature).toString('base64url');
}

export function verifyPirManifest(
  manifest: PirManifest,
  signature: string,
  publicKey: Uint8Array,
): boolean {
  const bytes = new Uint8Array(Buffer.from(signature, 'base64url'));
  if (bytes.length === 0) return false;
  try {
    return mlDsaVerify(
      bytes,
      pirManifestMessage(manifest),
      publicKey,
      PIR_MANIFEST_DOMAIN,
    );
  } catch {
    return false;
  }
}
