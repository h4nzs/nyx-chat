// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [Temuan #2] Sinkronisasi salinan `encryptedPrivateKey` di server.
 *
 * Kolom `device.encryptedPrivateKey` adalah bundle kunci privat yang
 * terenkripsi password user — server zero-knowledge, hanya menyimpannya.
 * Masalahnya, salinan itu dulunya hanya ditulis saat register / login /
 * recover. Alur ROTASI kunci (KeyManagementPage) tidak menyentuhnya:
 * bundle baru diupload via POST /api/keys/prekey-bundle, tapi kolom
 * device masih menyimpan bundle identitas LAMA. Saat user login blind
 * di perangkat baru, server mengembalikan bundle basi → identitas device
 * baru tidak cocok dengan pre-key bundle → handshake gagal.
 *
 * Perbaikan: endpoint prekey-bundle ikut menerima `encryptedPrivateKeys`
 * dan menimpa kolom device SETIAP kali client mengunggah bundle baru
 * (login, rotasi, auto-heal — semuanya lewat jalur ini). Payload tetap
 * opaque: server tidak pernah mendekripsi, hanya menyimpan ulang.
 */

import { ApiError } from './errors.js';

/** Batas ukuran payload bundle terenkripsi (chars UTF-8, base64 dari bundle JSON). */
export const ENCRYPTED_KEYS_MAX_LENGTH = 100_000;

/**
 * Validasi payload `encryptedPrivateKeys` dari client.
 *
 * Bundle sah adalah string base64 — dihasilkan crypto worker
 * (`storePrivateKeys`). Kosong/terlalu panjang → 400. `undefined` (field
 * tidak dikirim, mis. client lama) diterima dan mengembalikan undefined
 * agar endpoint tetap kompatibel mundur — client resmi saat ini selalu
 * mengirim field ini di setiap upload bundle.
 */
export const validateEncryptedPrivateKeysPayload = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > ENCRYPTED_KEYS_MAX_LENGTH) {
    throw new ApiError(400, 'encryptedPrivateKeys must be a non-empty base64 string.');
  }
  return value;
};

/**
 * Bentuk patch Prisma untuk kolom `device.encryptedPrivateKey`.
 * Dipisah dari validasi agar mudah diuji tanpa koneksi DB.
 */
export const toEncryptedPrivateKeyPatch = (encryptedPrivateKeys: string) => ({
  encryptedPrivateKey: Buffer.from(encryptedPrivateKeys, 'utf8'),
});
