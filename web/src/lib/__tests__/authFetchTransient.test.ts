// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi bug 2026-10-18: logout sendiri saat idle + `/login?reason=revoked`.
 *
 * `authFetch` dulu memanggil handler logout (yang mem-POST `/api/auth/logout` →
 * revoke SELURUH family) untuk kegagalan refresh APA PUN. Satu gangguan jaringan
 * saat tab resume cukup untuk mematikan sesi di semua tab; tab yang tertinggal
 * lalu memicu deteksi "reuse" + `force_logout` → `/login?reason=revoked`.
 *
 * Kontrak yang dikunci di sini:
 *   1. `getLastRefreshFailureKind() === 'transient'` → handler logout TIDAK
 *      dipanggil, sesi dibiarkan hidup.
 *   2. `'auth'` (401/403) → handler logout dipanggil (sesi memang mati).
 *   3. Refresh sukses → request asli diulang dan hasilnya dikembalikan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const silentRefreshMock = vi.fn()
let failureKind: 'auth' | 'transient' | null = null

vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'u1' }, silentRefresh: silentRefreshMock }),
  },
  getLastRefreshFailureKind: () => failureKind,
}))
vi.mock('@utils/fingerprint', () => ({
  getPersistentInstallationId: vi.fn(async () => 'iid-test'),
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))

import { authFetch, setAuthFailureHandler, ApiError } from '../api'

const fetchMock = vi.fn()

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  failureKind = null
  silentRefreshMock.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authFetch: kegagalan refresh transien tidak boleh logout', () => {
  it('transient → handler logout TIDAK dipanggil, error asli dilempar', async () => {
    const onAuthFailure = vi.fn(async () => {})
    setAuthFailureHandler(onAuthFailure)

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
    silentRefreshMock.mockImplementation(async () => {
      failureKind = 'transient'
      return false
    })

    await expect(authFetch('/api/secret')).rejects.toBeInstanceOf(ApiError)
    expect(silentRefreshMock).toHaveBeenCalledTimes(1)
    expect(onAuthFailure).not.toHaveBeenCalled()
  })

  it('auth (401/403) → handler logout dipanggil sekali', async () => {
    const onAuthFailure = vi.fn(async () => {})
    setAuthFailureHandler(onAuthFailure)

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
    silentRefreshMock.mockImplementation(async () => {
      failureKind = 'auth'
      return false
    })

    await expect(authFetch('/api/secret')).rejects.toBeInstanceOf(ApiError)
    expect(onAuthFailure).toHaveBeenCalledTimes(1)
  })

  it('refresh sukses → request asli diulang dan hasilnya dikembalikan', async () => {
    const onAuthFailure = vi.fn(async () => {})
    setAuthFailureHandler(onAuthFailure)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    silentRefreshMock.mockResolvedValue(true)

    await expect(authFetch<{ ok: boolean }>('/api/secret')).resolves.toEqual({ ok: true })
    expect(onAuthFailure).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
