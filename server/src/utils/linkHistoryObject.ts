// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createHmac } from 'node:crypto';

import { backupSizeLimit, clampBackupUrlTtl } from './backupObject.js';

// [docs/40 §40.6] Objek arsip riwayat di R2 ==================================
//
// Aturan yang sama dengan `backupObject.ts` (dan sengaja memakai helper yang
// sama untuk kuota/TTL): server hanya melihat blob opaque, kunci objek
// diturunkan HMAC (tanpa userId/deviceId di nama), dan tidak ada tabel DB baru.
//
// Bedanya: objek ini berumur pendek (30 menit) dan SEKALI pakai — dihapus saat
// perangkat tujuan selesai mengimpor. Ekstensinya `.nyxhist`, bukan `.nyxbak`,
// karena isinya bukan backup (payload = objek domain, lihat `docs/40` §40.5);
// operator yang menemukan objek ini tidak boleh mencoba me-restore-nya sebagai
// backup.

/** Prefix folder privat di bucket R2 — lifecycle rule mengacu ke sini. */
export const LINK_HISTORY_OBJECT_PREFIX = 'link-history/';

/** Ekstensi berkas arsip riwayat (bukan `.nyxbak`). */
export const LINK_HISTORY_FILE_EXTENSION = 'nyxhist';

/** Label domain-separation HMAC — jangan dipakai untuk tujuan lain. */
const LINK_HISTORY_KEY_LABEL = 'nyx:link-history:';

/** Ukuran minimum yang masuk akal (header arsip saja 32 byte). */
export const LINK_HISTORY_MIN_BYTES = 64;

/**
 * Batas untuk akun BELUM terverifikasi (sandbox).
 *
 * Berbeda dari `/api/backup/presign` yang menolak sandbox sepenuhnya, arsip
 * riwayat adalah transfer sekali pakai yang dipicu oleh perangkat yang SUDAH
 * login (token QR + approve), hidup ≤30 menit, dan dihapus setelah diimpor.
 * Menolaknya membuat mayoritas pengguna baru kehilangan kontak saat ganti HP
 * tanpa alasan yang sebanding — tetapi batasnya tetap dipotong supaya R2 tidak
 * menjadi penyimpanan gratis: 25 MB cukup untuk kontak + daftar percakapan
 * (tahap ini), dan naik ke kuota tier setelah akun terverifikasi.
 */
export const LINK_HISTORY_SANDBOX_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Kunci objek R2 untuk arsip riwayat satu perangkat.
 *
 * HMAC-SHA256(secret, `nyx:link-history:${deviceId}`) hex →
 * `link-history/<64 hex>.nyxhist`. Deterministik (satu perangkat = satu objek,
 * unggah ulang menimpa), tanpa deviceId di nama, dan tanpa rahasia server kunci
 * tidak bisa diturunkan dari deviceId yang bocor.
 */
export function deriveLinkHistoryObjectKey(secret: string, deviceId: string): string {
  if (!secret) throw new Error('Rahasia kunci arsip riwayat kosong (BACKUP_KEY_SECRET/JWT_SECRET)');
  if (!deviceId) throw new Error('deviceId kosong');
  const digest = createHmac('sha256', secret).update(`${LINK_HISTORY_KEY_LABEL}${deviceId}`).digest('hex');
  return `${LINK_HISTORY_OBJECT_PREFIX}${digest}.${LINK_HISTORY_FILE_EXTENSION}`;
}

/**
 * Kuota satu arsip riwayat untuk akun ini (byte).
 *
 * Dipakai **dua** tempat dan harus tetap satu sumber: `validateHistorySize`
 * (penegakan di presign) dan `GET /history/limits` (klien memeriksa sebelum
 * mengunggah, agar pesannya jelas dan bukan error generik dari presign).
 */
export function historySizeLimit(account: {
  tier: string | null | undefined;
  verified: boolean;
}): number {
  const tierLimit = backupSizeLimit(account.tier);
  return account.verified ? tierLimit : Math.min(LINK_HISTORY_SANDBOX_MAX_BYTES, tierLimit);
}

export type HistoryPresignDecision =
  | { ok: true; size: number; urlTtl: number }
  | { ok: false; status: number; error: string };

/**
 * Validasi body `POST /api/auth/link/history/presign`.
 *
 * Batas = kuota tier yang sama dengan `.nyxbak` (100 MB FREE / 500 MB
 * SUBSCRIBER), dipotong ke `LINK_HISTORY_SANDBOX_MAX_BYTES` untuk akun yang
 * belum terverifikasi. `size` adalah nilai yang DIKLAIM klien (batasan yang
 * sama dengan jalur backup/attachment; penegakan keras ada di kebijakan
 * bucket/lifecycle R2).
 */
export function validateHistorySize(
  rawSize: unknown,
  rawTtl: unknown,
  account: { tier: string | null | undefined; verified: boolean }
): HistoryPresignDecision {
  const size = typeof rawSize === 'number' ? rawSize : Number.parseInt(String(rawSize ?? ''), 10);
  if (!Number.isSafeInteger(size) || size < LINK_HISTORY_MIN_BYTES) {
    return { ok: false, status: 400, error: 'Missing or invalid history size' };
  }
  const limit = historySizeLimit(account);
  if (size > limit) {
    const limitMB = Math.floor(limit / (1024 * 1024));
    return {
      ok: false,
      status: 400,
      error: `History archive too large. Maximum size for your plan is ${limitMB} MB.`,
    };
  }
  return { ok: true, size, urlTtl: clampBackupUrlTtl(rawTtl) };
}
