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
import type { IDeviceTemplate, IOneTimePreKey, IPreKeyBundle } from '@nyx/shared';
import { ApiError } from './errors.js';

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
 * [docs/30 WS-G(4)] Baris OTPK hasil konsumsi atomik (`DELETE ... RETURNING`).
 * Tipe field sengaja longgar: PostgreSQL bisa mengembalikan `Buffer`/`Uint8Array`
 * (driver) atau string (driver lain / baris yang sudah dikodekan).
 */
export interface OneTimePreKeyRow {
  id: string;
  keyId: number;
  publicKey: unknown;
  pqPublicKey: unknown;
}

/**
 * Baris OTPK → `oneTimePreKey` yang dikirim ke klien (base64url).
 *
 * Sebelumnya ekspresi `Buffer.isBuffer(x) || x instanceof Uint8Array` ini
 * **disalin** di dua jalur (`/prekey-bundle/:userId` dan `/prekey-bundles`)
 * dengan penanganan `pqKey` yang berbeda-beda — sumber bug diam: satu jalur lupa
 * mengubah tipe biner sehingga klien menerima `[object Uint8Array]`.
 */
export function toOneTimePreKey(row: OneTimePreKeyRow): IOneTimePreKey {
  return {
    keyId: row.keyId,
    key: toBase64Url(row.publicKey),
    // Sengaja cek falsy (bukan `toOptionalBase64Url`): itu perilaku lama yang
    // dipertahankan apa adanya — nilai kosong (`''`, `Buffer(0)`) berarti
    // "tidak ada pq key" dan harus jadi `null`, bukan string kosong.
    pqKey: row.pqPublicKey ? toBase64Url(row.pqPublicKey) : null,
  };
}

/**
 * Bundle akhir untuk klien: template perangkat + OTPK **bila ada**.
 *
 * OTPK habis bukan kegagalan: bundle tetap sah tanpa `oneTimePreKey` (klien
 * lanjut ke X3DH tanpa pre-key sekali-pakai — perilaku lama yang dipertahankan),
 * dan field-nya **tidak** muncul sama sekali, bukan `null`, karena klien memeriksa
 * keberadaan field (`bundle.oneTimePreKey`).
 */
export function toPreKeyBundle(template: IDeviceTemplate, otpk?: OneTimePreKeyRow | null): IPreKeyBundle {
  const bundle: IPreKeyBundle = {
    deviceId: template.id,
    identityKey: template.identityKey,
    pqIdentityKey: template.pqIdentityKey,
    signingKey: template.signingKey,
    signedPreKey: template.signedPreKey,
  };
  if (otpk) bundle.oneTimePreKey = toOneTimePreKey(otpk);
  return bundle;
}

/**
 * Pilih perangkat yang boleh dipakai untuk handshake dari baris hasil query.
 *
 * Prisma sudah mengurutkan baris (`lastActiveAt` lalu `createdAt` — bucket 15
 * menit, `docs/28` Tier 2 B4), jadi fungsi ini hanya mengambil yang pertama dan
 * memutuskan **kode errornya**: tidak ada perangkat vs perangkat yang belum
 * punya identitas adalah dua kondisi berbeda yang harus bisa dibedakan klien.
 */
export function requireBundleDevice<T extends { signingKey: unknown; publicKey: unknown }>(
  devices: T[]
): T {
  if (devices.length === 0) {
    throw new ApiError(404, 'User does not have any active devices.');
  }
  const device = devices[0]!;
  if (!device.signingKey || !device.publicKey) {
    throw new ApiError(404, 'Device identity not fully initialized.');
  }
  return device;
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
