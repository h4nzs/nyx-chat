// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT PASS 6 — N6-01] Rencana KICK untuk `/logout` satu perangkat.
 *
 * Revokasi token saja TIDAK memutus sesi relay yang sedang hidup: relay tidak
 * memeriksa daftar blacklist per frame, jadi socket yang sudah terbuka tetap
 * mengirim & menerima setelah "logged out". `POST /api/auth/logout-all` dan
 * `DELETE /api/sessions/:jti` sudah mengirim `force_logout` + `KICK`; `/logout`
 * tidak, dan itulah temuan N6-01.
 *
 * Aturan yang dikunci di sini: kick SELALU device-scoped. Bila `deviceId` tidak
 * diketahui (mis. refresh token sudah tidak ada di DB), hasilnya `null` dan
 * TIDAK ada kick sama sekali — `force_logout`/`KICK` tanpa `deviceId` berarti
 * "logout semua perangkat", yang bukan arti dari `/logout` satu sesi.
 */

export interface DeviceLogoutKick {
  userId: string
  deviceId: string
  reason: string
}

export function planDeviceLogoutKick(input: {
  userId?: string | null
  deviceId?: string | null
  reason?: string
}): DeviceLogoutKick | null {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : ''
  if (!userId || !deviceId) return null
  return { userId, deviceId, reason: input.reason ?? 'logout' }
}
