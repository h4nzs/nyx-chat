import { describe, it, expect, beforeEach } from 'vitest'
import { runExclusive } from '../refreshLock'

// jsdom tidak punya navigator.locks → test ini menutupi jalur fallback localStorage.
describe('runExclusive (localStorage fallback)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('menserialkan tugas yang dipanggil bersamaan (tidak pernah overlap)', async () => {
    let active = 0
    let maxActive = 0
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 40))
      active--
    }

    await Promise.all([runExclusive(task), runExclusive(task), runExclusive(task)])

    expect(maxActive).toBe(1)
  })

  it('melepas kunci setelah selesai sehingga tugas berikutnya bisa masuk', async () => {
    const order: string[] = []

    await runExclusive(async () => {
      order.push('first')
      await new Promise((r) => setTimeout(r, 20))
    })
    await runExclusive(async () => {
      order.push('second')
    })

    expect(order).toEqual(['first', 'second'])
    expect(localStorage.getItem('nyx_refresh_lock')).toBeNull()
  })

  it('mengambil alih lock basi (melewati stale window) tanpa menunggu', async () => {
    const staleTs = Date.now() - 20_000
    localStorage.setItem('nyx_refresh_lock', `pemilik-lama|${staleTs}`)

    let ran = false
    await runExclusive(async () => {
      ran = true
    })

    expect(ran).toBe(true)
    expect(localStorage.getItem('nyx_refresh_lock')).toBeNull()
  })

  it('hanya melepas lock yang masih miliknya (tidak menghapus milik tab lain)', async () => {
    // Simulasi skenario TOCTOU: lock ditimpa pemilik lain SELAMA fn berjalan.
    // finally harus membiarkan nilai itu utuh.
    let valueDuringFn: string | null = null
    await runExclusive(async () => {
      localStorage.setItem('nyx_refresh_lock', `tab-lain|${Date.now()}`)
      valueDuringFn = localStorage.getItem('nyx_refresh_lock')
    })

    expect(localStorage.getItem('nyx_refresh_lock')).toBe(valueDuringFn)
  })

  it('kegagalan fn tetap melepas lock (finally) dan error diteruskan', async () => {
    await expect(
      runExclusive(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(localStorage.getItem('nyx_refresh_lock')).toBeNull()
  })
})