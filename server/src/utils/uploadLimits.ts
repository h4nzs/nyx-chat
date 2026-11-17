// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Batas ukuran upload — ditetapkan SERVER, bukan klien.
 *
 * Sebelum ini route hanya memeriksa `fileSize` dari body, dan angka itu tidak
 * pernah masuk ke tanda tangan URL. Klien bisa mengaku 1 byte lalu PUT 10 GB dan
 * R2 menerimanya. Sekarang ukuran yang lolos dipakai sebagai `ContentLength`
 * pada presign (masuk `X-Amz-SignedHeaders`), jadi R2 sendiri yang menolak body
 * yang tidak sama persis — klien hanya perlu mengirim angka yang jujur
 * (`file.size` dari blob terenkripsi, seperti `web/src/lib/r2.ts`).
 */

/** Ruang tambahan untuk amplop enkripsi (nonce + auth tag + margin). */
export const ENCRYPTION_OVERHEAD_BYTES = 1024;

const MB = 1024 * 1024;

/** Folder yang punya batas sendiri. `misc` mengikuti batas lampiran. */
export type UploadFolder = 'avatars' | 'attachments' | 'groups' | 'misc' | 'burner';

export interface UploadPolicy {
  /** Batas yang dijanjikan ke pengguna (dipakai untuk pesan error). */
  baseMaxBytes: number;
  /** Batas yang benar-benar diterima, sudah termasuk overhead enkripsi. */
  allowedMaxBytes: number;
}

/**
 * Batas per folder + tier. Angka dipertahankan sama dengan sebelumnya supaya
 * tidak ada perubahan perilaku untuk pengguna yang sah:
 * avatar/grup 5 MB, lampiran 100 MB (FREE) / 500 MB (SUBSCRIBER), burner 50 MB.
 */
export function resolveUploadPolicy (
  folder: UploadFolder,
  subscriptionTier: string | null | undefined
): UploadPolicy {
  const baseMaxBytes =
    folder === 'burner'
      ? 50 * MB
      : folder === 'avatars' || folder === 'groups'
        ? 5 * MB
        : subscriptionTier === 'SUBSCRIBER'
          ? 500 * MB
          : 100 * MB;

  return { baseMaxBytes, allowedMaxBytes: baseMaxBytes + ENCRYPTION_OVERHEAD_BYTES };
}

export type UploadSizeVerdict =
  | { ok: true; size: number; maxMB: number }
  | { ok: false; error: 'FILE_SIZE_REQUIRED' | 'FILE_TOO_LARGE'; maxMB: number };

/**
 * Validasi `fileSize` dari body request.
 *
 * WAJIB ada dan bilangan bulat positif: tanpa angka dari klien, server tidak
 * punya angka untuk dikunci di tanda tangan — dan presign tanpa batas ukuran
 * adalah lubang yang sedang ditutup ini. `fileSize` yang lebih besar dari
 * `allowedMaxBytes` ditolak di sini supaya klien mendapat pesan yang jelas,
 * bukan 403 dari R2 setelah mengunggah separuh file.
 */
export function validateUploadSize (rawSize: unknown, policy: UploadPolicy): UploadSizeVerdict {
  const maxMB = Math.round(policy.baseMaxBytes / MB);
  const size = typeof rawSize === 'string' ? Number(rawSize) : rawSize;

  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return { ok: false, error: 'FILE_SIZE_REQUIRED', maxMB };
  }
  if (size > policy.allowedMaxBytes) {
    return { ok: false, error: 'FILE_TOO_LARGE', maxMB };
  }
  return { ok: true, size, maxMB };
}

// ============================================================================
// [AUDIT 2026-10-31 — F-06] Batas TTL URL & retensi objek.
// ============================================================================
//
// `POST /api/upload/presigned` (dan varian burner) meneruskan `urlTtl` /
// `fileRetention` dari body apa adanya ke presign. Klien bisa meminta URL
// bertahun-tahun (jendela penyalahgunaan link bocor) atau objek hidup jauh ke
// depan. Angka-angka ini sekarang di-clamp di server; nilai tak masuk akal
// jatuh ke default, bukan diteruskan.

/** Batas bawah TTL URL upload (detik) — cukup untuk mengunggah blob besar. */
export const UPLOAD_URL_TTL_MIN_SECONDS = 60;
/** Batas atas TTL URL upload (detik) — 15 menit. */
export const UPLOAD_URL_TTL_MAX_SECONDS = 15 * 60;
/** Default TTL URL upload (detik) — 5 menit, sama seperti sebelumnya. */
export const UPLOAD_URL_TTL_DEFAULT_SECONDS = 5 * 60;
/** Batas atas retensi objek (detik) — 30 hari. */
export const UPLOAD_RETENTION_MAX_SECONDS = 30 * 24 * 60 * 60;

/** Terima number atau string numerik; selain itu `null`. */
function parseSeconds (raw: unknown): number | null {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * Clamp TTL URL upload ke [60 s, 15 mnt]. Nilai tidak valid → default 300 s.
 */
export function clampUploadUrlTtl (raw: unknown, fallbackSeconds = UPLOAD_URL_TTL_DEFAULT_SECONDS): number {
  const parsed = parseSeconds(raw);
  if (parsed === null) return fallbackSeconds;
  return Math.min(Math.max(parsed, UPLOAD_URL_TTL_MIN_SECONDS), UPLOAD_URL_TTL_MAX_SECONDS);
}

/**
 * Clamp retensi objek ke [0, 30 hari]. `0`/negatif/tidak valid = tanpa retensi
 * eksplisit (objek mengikuti lifecycle bucket).
 */
export function clampFileRetentionSeconds (raw: unknown, fallbackSeconds = 0): number {
  const parsed = parseSeconds(raw);
  if (parsed === null || parsed <= 0) return fallbackSeconds;
  return Math.min(parsed, UPLOAD_RETENTION_MAX_SECONDS);
}

// ============================================================================
// [AUDIT F-08 + docs/43 §43.16.2 T2] Key objek R2 acak & kepemilikan via HMAC.
// ============================================================================
//
// Key tidak lagi memuat userId/ekstensi (`<folder>/<uuid>`), jadi bentuk key
// TIDAK bisa dipakai membuktikan kepemilikan. Server menerbitkan token HMAC saat
// presign (`objectKeyToken`) yang dipegang klien bersama metadata pesan terenkripsi;
// `DELETE /api/messages/:id?r2Key=…&r2KeyToken=…` memverifikasinya. Tanpa token,
// pemegang lampiran yang diterima bisa menghapus file pengguna lain dengan
// memakai delete-token pesannya sendiri.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type ObjectFolder = 'avatars' | 'attachments' | 'groups' | 'misc' | 'burner';

const OBJECT_KEY_PATTERN =
  /^(avatars|attachments|groups|misc|burner)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<folder>/<uuid>` — acak, tanpa userId dan tanpa ekstensi asli. */
export function buildObjectKey (folder: ObjectFolder, id: string = randomUUID()): string {
  return `${folder}/${id}`;
}

/** Bentuk key yang boleh dihapus (folder dikenal, uuid, tanpa segmen liar). */
export function isValidObjectKey (key: unknown): key is string {
  return typeof key === 'string' && key.length <= 255 && OBJECT_KEY_PATTERN.test(key);
}

export function objectKeyToken (userId: string, key: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`nyx-r2-key-v1\n${userId}\n${key}`)
    .digest('base64url');
}

/** `true` hanya bila token cocok dengan pasangan (userId, key) ini. */
export function verifyObjectKeyToken (
  userId: unknown,
  key: unknown,
  token: unknown,
  secret: string
): boolean {
  if (typeof userId !== 'string' || userId.length === 0) return false;
  if (!isValidObjectKey(key)) return false;
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = Buffer.from(objectKeyToken(userId, key, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
