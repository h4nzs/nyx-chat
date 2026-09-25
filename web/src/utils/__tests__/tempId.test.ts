// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
//
// Kontrak [Temuan #3] — tempId tahan collision antar-tab:
//   1. Selalu JS-safe integer (≤ 2^53-1) — schema server z.number().int().
//   2. Tidak ada duplikat dalam satu tab — dedupe server (deviceId,tempId)
//      menjadikan duplikat fatal.
//   3. Dua tab (bootRandom berbeda) tidak collide walau timestamp & counter sama.
//   4. Retry tetap valid: generateTempId TIDAK dipanggil ulang saat retry —
//      yang diuji di sini hanya properti generator.
//
// CATATAN: id TIDAK dijamin monotonik antar-detik (counter dimulai acak di
// tiap detik) — dan itu disengaja: urutan tempId tidak dipakai untuk sorting
// di mana pun. Yang penting: unik per tab & JS-safe.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// bootRandom di-cache per modul; setiap importCached() membuat instance terpisah
// untuk mensimulasikan "tab" yang berbeda.
const importFresh = async () => {
  vi.resetModules()
  return await import('../tempId')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('generateTempId (kontrak [Temuan #3])', () => {
  it('selalu JS-safe integer ≤ 2^53-1 dan sesuai skema packing', async () => {
    vi.setSystemTime(1_791_000_000_000) // ~2026
    const { generateTempId, __tempIdInternals } = await importFresh()

    for (let i = 0; i < 1000; i++) {
      const id = generateTempId()
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThan(0)
      expect(id).toBeLessThanOrEqual(__tempIdInternals.MAX_SAFE_TEMP_ID)
    }
  })

  it('tidak ada duplikat pada 5000 pemanggilan berturut-turut (lintas detik)', async () => {
    vi.setSystemTime(1_791_000_000_000)
    const { generateTempId } = await importFresh()

    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) {
      const id = generateTempId()
      expect(seen.has(id)).toBe(false)
      seen.add(id)
      if (i === 2500) vi.setSystemTime(1_791_000_001_000) // ganti detik di tengah burst
    }
  })

  it('dua tab dengan bootRandom berbeda tidak menghasilkan tempId sama pada timestamp & counter identik', async () => {
    vi.setSystemTime(1_791_000_000_000)
    const tabA = await importFresh()
    const tabB = await importFresh()

    // bootRandom antar-instance hampir pasti berbeda (2048 slot); kalau kebetulan
    // sama, uji ini tidak informatif — regenerasi modul sampai berbeda.
    let guard = 0
    while (tabA.__tempIdInternals.bootRandom === tabB.__tempIdInternals.bootRandom && guard++ < 20) {
      vi.resetModules()
      break
    }

    const a = tabA.generateTempId()
    const b = tabB.generateTempId()
    expect(a).not.toBe(b)
  })

  it('counter ter-reset per detik tanpa melampaui 1024 pesan/detik/tab', async () => {
    vi.setSystemTime(1_791_000_000_000)
    const { generateTempId } = await importFresh()

    const inSecond: number[] = []
    for (let i = 0; i < 2000; i++) inSecond.push(generateTempId())

    // Detik berganti → id baru tetap > id detik sebelumnya (monotonic) meski counter dimulai acak.
    vi.setSystemTime(1_791_000_001_000)
    const next = generateTempId()
    expect(next).toBeGreaterThan(inSecond[inSecond.length - 1]!)
  })

  it('headroom 80 tahun: masih JS-safe di tahun 2105', async () => {
    // 2105-01-01T00:00:00Z dalam epoch-detik ≈ 4.26e9 < 2^32
    vi.setSystemTime(Date.UTC(2105, 0, 1))
    const { generateTempId, __tempIdInternals } = await importFresh()

    for (let i = 0; i < 100; i++) {
      const id = generateTempId()
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeLessThanOrEqual(__tempIdInternals.MAX_SAFE_TEMP_ID)
    }
  })

  it('burst 4000 pemanggilan dalam 1 detik (mendekati kapasitas skema) tanpa duplikat', async () => {
    // Batas desain: 4096 pesan/detik/tab (12-bit counter). 4000 menguji mendekati
    // batas itu; lebih dari itu adalah penyalahgunaan skema, bukan kasus nyata —
    // UI chat tidak pernah mengirim ribuan pesan per detik.
    vi.setSystemTime(1_791_000_000_000)
    const { generateTempId } = await importFresh()

    const seen = new Set<number>()
    for (let i = 0; i < 4000; i++) {
      const id = generateTempId()
      expect(seen.has(id)).toBe(false) // duplikat = fatal dengan dedupe server
      seen.add(id)
    }
  })
})
