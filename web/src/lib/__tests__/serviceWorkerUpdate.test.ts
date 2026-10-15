import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SW_RELOAD_MARKER,
  handleServiceWorkerUpdate,
  readReloadMarker,
  writeReloadMarker,
} from '../serviceWorkerRegistration'

// [R2 2026-10-15] Tanpa reload, halaman terus menjalankan bundel lama walau
// service worker baru sudah mengambil alih — dan bundel lama itu yang menolak
// envelope grup v2 secara diam-diam. Karena itu yang diuji di sini: reload
// TERJADI saat SW baru aktif, HANYA SEKALI per tab per sesi (tidak loop), dan
// data tetap di-resync walau reload ditahan.

function effects(overrides: Partial<Parameters<typeof handleServiceWorkerUpdate>[0]> = {}) {
  return {
    isUpdate: false,
    alreadyReloaded: false,
    resync: vi.fn(),
    reload: vi.fn(),
    markReloaded: vi.fn(),
    ...overrides,
  }
}

describe('handleServiceWorkerUpdate (R2)', () => {
  it('SW pertama kali dipasang (bukan update) → tidak reload, tidak resync', () => {
    const e = effects({ isUpdate: false })
    expect(handleServiceWorkerUpdate(e)).toBe(false)
    expect(e.reload).not.toHaveBeenCalled()
    expect(e.resync).not.toHaveBeenCalled()
  })

  it('update pertama di tab ini → resync, tandai, lalu reload', () => {
    const e = effects({ isUpdate: true })
    expect(handleServiceWorkerUpdate(e)).toBe(true)
    expect(e.resync).toHaveBeenCalledTimes(1)
    expect(e.markReloaded).toHaveBeenCalledTimes(1)
    expect(e.reload).toHaveBeenCalledTimes(1)
  })

  it('update berikutnya di tab yang sama → resync tetap, TAPI tidak reload lagi (anti-loop)', () => {
    const e = effects({ isUpdate: true, alreadyReloaded: true })
    expect(handleServiceWorkerUpdate(e)).toBe(false)
    expect(e.resync).toHaveBeenCalledTimes(1)
    expect(e.reload).not.toHaveBeenCalled()
    expect(e.markReloaded).not.toHaveBeenCalled()
  })
})

describe('penanda reload di sessionStorage (R2)', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('tulis lalu baca penanda bekerja', () => {
    expect(readReloadMarker()).toBe(false)
    writeReloadMarker()
    expect(sessionStorage.getItem(SW_RELOAD_MARKER)).toBe('1')
    expect(readReloadMarker()).toBe(true)
  })

  it('sessionStorage yang melempar → dianggap "sudah pernah" (tidak reload) dan penulisan aman', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('ditutup mode privasi') },
      setItem: () => { throw new Error('ditutup mode privasi') },
    })

    expect(readReloadMarker()).toBe(true)
    expect(() => writeReloadMarker()).not.toThrow()
  })
})
