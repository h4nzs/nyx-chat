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
