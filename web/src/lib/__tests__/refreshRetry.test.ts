import { describe, it, expect, vi } from 'vitest'
import { classifyRefreshFailure, refreshWithRetry } from '../refreshRetry'

describe('refreshWithRetry', () => {
  it('success pada percobaan pertama → hanya 1 panggilan', async () => {
    const fn = vi.fn().mockResolvedValue({ accessToken: 'tok-1' })
    const res = await refreshWithRetry(fn, 3, 1)
    expect(res?.accessToken).toBe('tok-1')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gagal transien 2× lalu sukses → retry sampai berhasil (regresi: jangan logout)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockRejectedValueOnce(new Error('concurrent rotation'))
      .mockResolvedValueOnce({ accessToken: 'tok-ok' })

    const res = await refreshWithRetry(fn, 3, 1)
    expect(res?.accessToken).toBe('tok-ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('gagal terus → null setelah attempts kali', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('401'))
    const res = await refreshWithRetry(fn, 3, 1)
    expect(res).toBeNull()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('respons tanpa accessToken dianggap gagal dan di-retry', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ accessToken: 'tok-2' })
    const res = await refreshWithRetry(fn, 3, 1)
    expect(res?.accessToken).toBe('tok-2')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('classifyRefreshFailure (BUGFIX 2026-10-18)', () => {
  it('401/403 = auth (sesi memang ditolak server)', () => {
    expect(classifyRefreshFailure({ status: 401 })).toBe('auth')
    expect(classifyRefreshFailure({ status: 403 })).toBe('auth')
  })

  it('network/timeout/5xx/unknown = transient (jangan logout, jangan revoke family)', () => {
    expect(classifyRefreshFailure({ status: 0 })).toBe('transient')
    expect(classifyRefreshFailure({ status: 500 })).toBe('transient')
    expect(classifyRefreshFailure({ status: 429 })).toBe('transient')
    expect(classifyRefreshFailure(new Error('network down'))).toBe('transient')
    expect(classifyRefreshFailure(undefined)).toBe('transient')
  })

  it('onFailure dipanggil dengan kind yang benar untuk kegagalan berulang', async () => {
    const kinds: string[] = []
    await refreshWithRetry(
      vi.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 })),
      2,
      1,
      (kind) => kinds.push(kind)
    )
    expect(kinds).toEqual(['auth', 'auth'])
  })

  it('respons 2xx tanpa accessToken dilaporkan transien, lalu retry berhasil', async () => {
    const kinds: string[] = []
    const fn = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ accessToken: 'tok-3' })
    const res = await refreshWithRetry(fn, 3, 1, (kind) => kinds.push(kind))
    expect(res?.accessToken).toBe('tok-3')
    expect(kinds).toEqual(['transient'])
  })
})