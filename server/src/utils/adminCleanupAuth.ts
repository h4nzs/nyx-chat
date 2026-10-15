// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R6 2026-10-15] Kebijakan otorisasi `POST /api/admin/cleanup` — dipisah jadi
 * fungsi MURNI supaya bisa diuji perilakunya tanpa Express/DB/Redis.
 *
 * Kenapa perlu dikeraskan: sejak endpoint ini benar-benar menjalankan
 * `runCleanup` (dulu stub yang hanya menjawab "Cleanup triggered"), ia menjadi
 * **operasi destruktif** — termasuk menghancurkan akun dorman (dead-man's
 * switch). Sebelumnya satu rahasia statis (`x-admin-key` = `CHAT_SECRET`, yang
 * juga dipakai fitur lain) adalah satu-satunya gerbang, tanpa rate limit khusus
 * dan tanpa jejak audit.
 *
 * Yang ditegakkan di sini (urutan diperiksa dari yang termurah dan paling tidak
 * sensitif):
 *
 *   1. **Allow-list IP opsional** (`ADMIN_CLEANUP_IP_ALLOWLIST`, CSV). Kosong =
 *      tanpa batasan (perilaku lama, jadi operasi yang sudah jalan tidak
 *      mendadak rusak). Bila diisi, hanya IP itu yang boleh memicunya.
 *   2. **Rahasia khusus** `ADMIN_CLEANUP_SECRET`; hanya bila tidak diset, ia
 *      jatuh ke `CHAT_SECRET` (kompatibilitas). Rahasia yang diset tapi kosong
 *      / hanya spasi diperlakukan sebagai TIDAK diset. Perbandingan
 *      constant-time (`safeEqualStrings`), dan server TANPA rahasia apa pun
 *      selalu menolak (fail-closed) — bukan "kalau tidak ada konfigurasi, semua
 *      boleh".
 *
 * Yang TIDAK dilakukan di sini: rate limit (itu middleware, lihat
 * `adminCleanupLimiter`) dan eksekusi cleanup. Fungsi ini hanya menjawab
 * "boleh/tidak + karena apa", tanpa efek samping.
 */

import { safeEqualStrings } from './validate.js'

export type AdminCleanupReason =
  | 'ok'
  | 'ip-not-allowed'
  | 'secret-not-configured'
  | 'bad-key'

export interface AdminCleanupDecision {
  /** true hanya bila pemanggil boleh menjalankan pembersihan. */
  ok: boolean
  reason: AdminCleanupReason
  /** true bila rahasia khusus (bukan fallback CHAT_SECRET) yang dipakai. */
  dedicatedSecret: boolean
}

export interface AdminCleanupAuthInput {
  /** Nilai header `x-admin-key` apa adanya (tipe diperiksa di dalam). */
  providedKey: unknown
  /** IP klien yang sudah dinormalkan (`cfAwareClientIp`). */
  clientIp?: string | undefined
}

export interface AdminCleanupAuthEnv {
  /** `ADMIN_CLEANUP_SECRET` — rahasia khusus endpoint ini. */
  cleanupSecret?: string | undefined
  /** `CHAT_SECRET` — fallback kompatibilitas + dipakai fitur lain. */
  chatSecret?: string | undefined
  /** `ADMIN_CLEANUP_IP_ALLOWLIST` — CSV IP; kosong/absen = tanpa batasan. */
  ipAllowlist?: string | undefined
}

/** Urai CSV allow-list: trim, buang entri kosong, dedup, case-fold. */
export function parseAdminCleanupAllowlist(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const seen = new Set<string>()
  for (const entry of raw.split(',')) {
    const value = entry.trim().toLowerCase()
    if (value !== '') seen.add(value)
  }
  return [...seen]
}

/** Rahasia efektif: khusus dulu, lalu fallback; kosong = tidak ada. */
export function resolveAdminCleanupSecret(env: AdminCleanupAuthEnv): { secret: string | null; dedicated: boolean } {
  const dedicated = typeof env.cleanupSecret === 'string' ? env.cleanupSecret.trim() : ''
  if (dedicated !== '') return { secret: dedicated, dedicated: true }
  const fallback = typeof env.chatSecret === 'string' ? env.chatSecret.trim() : ''
  return { secret: fallback !== '' ? fallback : null, dedicated: false }
}

export function authorizeAdminCleanup(
  input: AdminCleanupAuthInput,
  env: AdminCleanupAuthEnv
): AdminCleanupDecision {
  const { secret, dedicated } = resolveAdminCleanupSecret(env)

  const allowlist = parseAdminCleanupAllowlist(env.ipAllowlist)
  if (allowlist.length > 0) {
    const ip = (input.clientIp ?? '').trim().toLowerCase()
    if (ip === '' || !allowlist.includes(ip)) {
      return { ok: false, reason: 'ip-not-allowed', dedicatedSecret: dedicated }
    }
  }

  if (secret === null) {
    return { ok: false, reason: 'secret-not-configured', dedicatedSecret: false }
  }

  if (typeof input.providedKey !== 'string' || !safeEqualStrings(input.providedKey, secret)) {
    return { ok: false, reason: 'bad-key', dedicatedSecret: dedicated }
  }

  return { ok: true, reason: 'ok', dedicatedSecret: dedicated }
}

/**
 * Peringatan startup: bentuk konfigurasi yang berbahaya tapi tidak fatal —
 * dicatat sekali saat boot supaya operator melihatnya tanpa harus memicu
 * endpoint. Mengembalikan daftar pesan (bukan mencetak sendiri) agar bisa diuji.
 */
export function adminCleanupConfigWarnings(env: AdminCleanupAuthEnv & { nodeEnv?: string }): string[] {
  const warnings: string[] = []
  const { secret, dedicated } = resolveAdminCleanupSecret(env)
  const isProd = env.nodeEnv === 'production'

  if (secret === null) {
    warnings.push('ADMIN_CLEANUP_SECRET/CHAT_SECRET kosong — POST /api/admin/cleanup akan SELALU menolak (fail-closed).')
    return warnings
  }
  if (!dedicated && isProd) {
    warnings.push('ADMIN_CLEANUP_SECRET tidak diset — /api/admin/cleanup memakai CHAT_SECRET. Sebaiknya pakai rahasia terpisah: CHAT_SECRET juga dipakai fitur lain, jadi membocorkannya berarti bisa menghancurkan akun dorman.')
  }
  if (isProd && parseAdminCleanupAllowlist(env.ipAllowlist).length === 0) {
    warnings.push('ADMIN_CLEANUP_IP_ALLOWLIST kosong — /api/admin/cleanup bisa dipanggil dari IP mana pun yang punya kunci (docs/10 §10.13).')
  }
  return warnings
}
