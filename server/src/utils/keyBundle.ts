// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4)] Pemetaan perangkat (Prisma) → bundle/pre-key template.
 *
 * Sebelumnya blok konversi Buffer/Uint8Array → base64url ini **disalin tiga
 * kali** di `routes/keys.ts` (bundle tunggal, bulk, public-keys) dengan
 * penanganan `null` yang sedikit berbeda — sumber bug yang mudah: satu tempat
 * lupa `pqKey`, tempat lain memakai `instanceof` yang gagal untuk typed array
 * lintas realm. Sekarang satu implementasi, diuji perilakunya.
 */

import { Buffer } from 'buffer';
import type { IDeviceTemplate } from '@nyx/shared';

/** Konversi blob kunci apa pun (Buffer/Uint8Array/string) → base64url. */
export function toBase64Url(value: unknown): string {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value as Uint8Array).toString('base64url');
  }
  return String(value);
}

/** Sama seperti `toBase64Url`, tetapi `null`/`undefined` → `null`. */
export function toOptionalBase64Url(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toBase64Url(value);
}

export interface DeviceTemplateSource {
  id: string;
  publicKey: unknown;
  pqPublicKey: unknown;
  signingKey: unknown;
  preKeyBundle: {
    key: unknown;
    pqKey: unknown;
    signature: unknown;
    pqSignature: unknown;
  } | null;
}

/**
 * Bentuk `IDeviceTemplate` yang dikirim ke klien (termasuk signed pre-key).
 * Pemanggil bertanggung jawab memastikan `publicKey` & `signingKey` ada
 * (route sudah menyaring perangkat yang belum terinisialisasi).
 */
export function toDeviceTemplate(device: DeviceTemplateSource): IDeviceTemplate {
  return {
    id: device.id,
    identityKey: toBase64Url(device.publicKey),
    pqIdentityKey: toOptionalBase64Url(device.pqPublicKey),
    signingKey: toBase64Url(device.signingKey),
    signedPreKey: device.preKeyBundle
      ? {
          key: toBase64Url(device.preKeyBundle.key),
          pqKey: toOptionalBase64Url(device.preKeyBundle.pqKey),
          signature: toBase64Url(device.preKeyBundle.signature),
          pqSignature: toOptionalBase64Url(device.preKeyBundle.pqSignature),
        }
      : null,
  };
}

/**
 * Bentuk ringkas untuk `/public-keys` — **tanpa** signed pre-key, dan memakai
 * nama `deviceId` (bukan `id`) seperti yang dipakai klien di jalur itu.
 */
export function toPublicDeviceBundle(device: {
  id: string;
  publicKey: unknown;
  pqPublicKey: unknown;
  signingKey: unknown;
}): Record<string, unknown> {
  return {
    deviceId: device.id,
    identityKey: toBase64Url(device.publicKey),
    pqIdentityKey: toOptionalBase64Url(device.pqPublicKey),
    signingKey: toBase64Url(device.signingKey),
  };
}
