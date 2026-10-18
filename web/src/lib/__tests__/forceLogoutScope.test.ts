// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi bug 2026-10-18: `force_logout` tanpa scope device me-logout perangkat
 * lain (`/login?reason=revoked` di perangkat yang sesinya masih sah).
 */
import { describe, it, expect } from 'vitest'
import { isForceLogoutForThisDevice, classifyKickPayload } from '../forceLogout'

describe('isForceLogoutForThisDevice', () => {
  it('deviceId cocok → berlaku', () => {
    expect(isForceLogoutForThisDevice('dev-a', 'dev-a')).toBe(true)
  })

  it('deviceId beda → diabaikan (perangkat lain tidak ikut logout)', () => {
    expect(isForceLogoutForThisDevice('dev-b', 'dev-a')).toBe(false)
  })

  it('event tanpa deviceId (server lama) → tetap berlaku', () => {
    expect(isForceLogoutForThisDevice(undefined, 'dev-a')).toBe(true)
    expect(isForceLogoutForThisDevice(null, 'dev-a')).toBe(true)
    expect(isForceLogoutForThisDevice('', 'dev-a')).toBe(true)
  })

  it('deviceId lokal tidak diketahui → jangan tahan logout yang mungkin sah', () => {
    expect(isForceLogoutForThisDevice('dev-b', null)).toBe(true)
    expect(isForceLogoutForThisDevice('dev-b', undefined)).toBe(true)
    expect(isForceLogoutForThisDevice('dev-b', '')).toBe(true)
  })
})

/**
 * [PARITY 2026-10-18] KICK (opcode 0x07) kini dipetakan di SATU tempat untuk jalur
 * WT maupun WSS. Sebelumnya jalur WT hanya menerima penutupan koneksi sehingga
 * revoke sesi/kick device tidak pernah me-logout perangkat itu secara instan.
 */
describe('classifyKickPayload', () => {
  it('kick device ini (revoke sesi) → force_logout dengan payload utuh', () => {
    const payload = { reason: 'SESSION_REVOKED', deviceId: 'dev-a', message: 'logged in elsewhere' }
    expect(classifyKickPayload(payload, 'dev-a')).toEqual({ action: 'force_logout', payload })
  })

  it('kick device ini tanpa reason (revoke via /api/sessions) → force_logout', () => {
    expect(classifyKickPayload({ deviceId: 'dev-a' }, 'dev-a')).toEqual({
      action: 'force_logout',
      payload: { deviceId: 'dev-a' },
    })
  })

  it('kick device LAIN → ignore (jangan logout perangkat yang sesinya sah)', () => {
    expect(classifyKickPayload({ reason: 'HARDWARE_MISMATCH', deviceId: 'dev-b' }, 'dev-a')).toEqual({
      action: 'ignore',
      deviceId: 'dev-b',
    })
  })

  it('payload akun (tanpa deviceId, ada reason) → auth:banned', () => {
    expect(classifyKickPayload({ reason: 'Account deleted' }, 'dev-a')).toEqual({
      action: 'auth_banned',
      reason: 'Account deleted',
    })
  })

  it('payload tanpa info apa pun / tak terbaca → force_logout (server memang menutup sesi)', () => {
    expect(classifyKickPayload({}, 'dev-a')).toEqual({ action: 'force_logout', payload: {} })
    expect(classifyKickPayload(null, 'dev-a')).toEqual({ action: 'force_logout', payload: {} })
    expect(classifyKickPayload(undefined, 'dev-a')).toEqual({ action: 'force_logout', payload: {} })
  })

  it('deviceId lokal tidak diketahui → payload device-spesifik tetap diterapkan', () => {
    expect(classifyKickPayload({ deviceId: 'dev-b' }, null)).toEqual({
      action: 'force_logout',
      payload: { deviceId: 'dev-b' },
    })
  })
})
