// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import type { CookieOptions, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { redisClient } from '../lib/redis.js'
import { env } from '../config.js'

/**
 * Opsi cookie sesi — SATU sumber untuk `setAuthCookies` (routes/auth.ts) dan
 * `clearAuthCookies` di bawah. Kalau kedua sisi menyimpang (mis. `domain`
 * hanya ada saat set), cookie tidak pernah benar-benar terhapus.
 *
 * [OPS 2026-10-25] `domain` (COOKIE_DOMAIN) wajib ada pada deployment yang
 * memisahkan REST (`app.*`) dari relay realtime (`api.*`): cookie host-only
 * tidak dikirim ke `api.*` sehingga handshake socket.io ditolak `unauthorized`.
 */
export function authCookieOptions (): CookieOptions {
  const isProd = env.nodeEnv === 'production'
  return {
    path: '/',
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
  }
}

/**
 * Hapus cookie auth (access + refresh) dengan opsi yang SAMA PERSIS dengan
 * setAuthCookies. Sebelumnya clear-cookie tersebar 8× dengan opsi berbeda
 * (mis. sameSite 'strict' vs 'lax') → cookie bisa gagal terhapus.
 */
export function clearAuthCookies (res: Response): void {
  const options = authCookieOptions()
  res.clearCookie('at', options)
  res.clearCookie('rt', options)
}

/**
 * Apakah subjek JWT ini guest ephemeral (Burner Chat `/drop`)?
 *
 * `issueTokens` sengaja TIDAK mempersist refresh token guest (tidak ada baris
 * User/Device → FK gagal), sehingga `POST /api/auth/refresh` untuk guest selalu
 * berakhir 401 "token tidak ditemukan". Itu kondisi NORMAL, bukan sesi rusak —
 * jangan `clearAuthCookies` di jalur itu: cookie `at` (15 menit) masih sah dan
 * dipakai `GET /api/auth/transport-ticket` untuk menaikkan uplink burner.
 */
export function isEphemeralGuestSubject (sub: unknown): boolean {
  return typeof sub === 'string' && sub.startsWith('guest_')
}

/**
 * Revoke seluruh refresh token dalam satu family (rotasi chain) dan
 * blacklist semua JTI-nya di Redis secara PARALEL (sebelumnya sequential).
 * Dipakai pada: reuse detection, logout, dan session revocation.
 */
export async function revokeFamily (familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() }
  })

  const familyTokens = await prisma.refreshToken.findMany({
    where: { familyId },
    select: { jti: true, expiresAt: true }
  })

  const now = Date.now()
  await Promise.all(familyTokens.map(async (ft) => {
    const expiresIn = Math.floor((new Date(ft.expiresAt).getTime() - now) / 1000)
    if (expiresIn > 0) {
      await redisClient.setEx(`revoked_jti:${ft.jti}`, expiresIn, '1').catch(() => {})
    }
  }))
}
