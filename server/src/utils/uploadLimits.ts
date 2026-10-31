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
// [AUDIT 2026-10-31 — F-08] Kepemilikan key objek R2.
// ============================================================================
//
// `DELETE /api/messages/:id?r2Key=` memakai sanitizer yang MEMPERTAHANKAN `/`
// dan `..`, lalu hanya memeriksa segmen path terakhir. Key yang benar-benar
// dihapus adalah key penuh, jadi bentuk key-nya harus divalidasi utuh dan harus
// benar-benar milik pemanggil (`<folder>/<userId>-<id>.<ext>`, seperti yang
// dibuat `POST /presigned`).

const OWNED_OBJECT_KEY_FOLDERS = 'avatars|attachments|groups|misc';

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `true` hanya bila `key` berbentuk `<folder>/<userId>-<opaque>.<ext>` dengan
 * folder yang dikenal, tanpa `..`, dan tanpa segmen tambahan.
 */
export function isOwnedObjectKey (userId: unknown, key: unknown): key is string {
  if (typeof userId !== 'string' || userId.length === 0) return false;
  if (typeof key !== 'string' || key.length === 0 || key.length > 255) return false;
  if (key.includes('..')) return false;
  const pattern = new RegExp(
    `^(${OWNED_OBJECT_KEY_FOLDERS})/${escapeRegExp(userId)}-[A-Za-z0-9_-]{1,80}[.][a-z0-9]{1,8}$`
  );
  return pattern.test(key);
}
