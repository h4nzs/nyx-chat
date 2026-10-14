// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createHmac } from 'node:crypto'

// [docs/30 WS-C fase 3 / docs/31 §31.6] Objek backup di R2 =================
//
// Prinsip: server hanya melihat BLOB terenkripsi. Tidak ada tabel DB baru,
// tidak ada metadata isi, tidak ada userId di kunci objek.
//
// Kunci objek DITURUNKAN dari (rahasia server, userId) lewat HMAC-SHA256 →
// deterministik (tanpa state) tetapi tidak membocorkan userId. Konsekuensi yang
// harus diketahui operator: mengganti `BACKUP_KEY_SECRET` membuat backup lama
// tidak bisa ditemukan lagi (objek lama tetap ada, tapi kunci turunannya beda).

/** Prefix folder privat di bucket R2. Kebijakan bucket/lifecycle mengacu ke sini. */
export const BACKUP_OBJECT_PREFIX = 'backups/'

/** Ekstensi berkas backup. */
export const BACKUP_FILE_EXTENSION = 'nyxbak'

/** Label domain-separation HMAC — jangan dipakai untuk tujuan lain. */
const BACKUP_KEY_LABEL = 'nyx:backup:'

/** Kuota satu arsip backup untuk akun tier FREE (byte). */
export const BACKUP_FREE_MAX_BYTES = 100 * 1024 * 1024

/** Kuota satu arsip backup untuk akun SUBSCRIBER (byte). */
export const BACKUP_SUBSCRIBER_MAX_BYTES = 500 * 1024 * 1024

/** Umur default URL presigned (detik). */
export const BACKUP_DEFAULT_URL_TTL = 300

/** Batas bawah/atas URL presigned (detik) — nilai di luar ini dijepit, bukan ditolak. */
export const BACKUP_MIN_URL_TTL = 30
export const BACKUP_MAX_URL_TTL = 900

/**
 * Kunci objek R2 untuk backup akun.
 *
 * HMAC-SHA256(secret, `nyx:backup:${userId}`) hex → `backups/<64 hex>.nyxbak`.
 * Tidak ada userId di kunci, dan tanpa secret kunci tidak bisa diturunkan dari
 * userId yang bocor.
 */
export function deriveBackupObjectKey(secret: string, userId: string): string {
  if (!secret) throw new Error('Rahasia kunci backup kosong (BACKUP_KEY_SECRET/JWT_SECRET)')
  if (!userId) throw new Error('userId kosong')
  const digest = createHmac('sha256', secret).update(`${BACKUP_KEY_LABEL}${userId}`).digest('hex')
  return `${BACKUP_OBJECT_PREFIX}${digest}.${BACKUP_FILE_EXTENSION}`
}

/** Batas ukuran arsip per tier langganan. Tier tak dikenal diperlakukan sebagai FREE. */
export function backupSizeLimit(tier: string | null | undefined): number {
  return tier === 'SUBSCRIBER' ? BACKUP_SUBSCRIBER_MAX_BYTES : BACKUP_FREE_MAX_BYTES
}

/** Jepit TTL ke rentang aman; nilai tak sah → default. */
export function clampBackupUrlTtl(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed)) return BACKUP_DEFAULT_URL_TTL
  return Math.min(BACKUP_MAX_URL_TTL, Math.max(BACKUP_MIN_URL_TTL, Math.trunc(parsed)))
}

/** Keputusan validasi request presign — union diskriminatif agar route tetap tipis. */
export type BackupPresignDecision =
  | { ok: true; size: number; urlTtl: number }
  | { ok: false; status: number; error: string }

/**
 * Validasi body `POST /api/backup/presign`.
 *
 * `size` adalah panjang arsip `.nyxbak` final yang akan di-PUT klien. Kuota
 * ditegakkan terhadap nilai INI (client-declared) — sama seperti jalur upload
 * lampiran; penegakan keras ada di kebijakan bucket/lifecycle R2. Dicatat
 * sebagai batasan, bukan diklaim sebagai penegakan sisi server yang mutlak.
 */
export function validateBackupUpload(
  rawSize: unknown,
  rawTtl: unknown,
  tier: string | null | undefined
): BackupPresignDecision {
  const size = typeof rawSize === 'number' ? rawSize : Number.parseInt(String(rawSize ?? ''), 10)
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, status: 400, error: 'Missing or invalid backup size' }
  }
  const limit = backupSizeLimit(tier)
  if (size > limit) {
    const limitMB = Math.floor(limit / (1024 * 1024))
    return { ok: false, status: 400, error: `Backup too large. Maximum size for your plan is ${limitMB} MB.` }
  }
  return { ok: true, size: Math.trunc(size), urlTtl: clampBackupUrlTtl(rawTtl) }
}
