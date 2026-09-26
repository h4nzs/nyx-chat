// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [T4] Cover traffic (doc 26.10) — unit tests.
 *
 * Kunci desain yang diuji:
 *  - Poisson sampling: interval acak deterministik via injected rng, clamp
 *    [10s, 15min] sesuai desain 26.10.3.
 *  - Memoryless resampling: scheduler fire → interval berikutnya beda.
 *  - Fire eligibility: master switch, per-group opt-in, visibility, transport.
 *  - Rate-limit backoff (26.10.4): cover YIELD ke real send, tidak sebaliknya.
 *  - Client-local privacy: tidak ada API call; onSendCover adalah injectable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  samplePoissonInterval,
  CoverTrafficScheduler,
  coverShouldYield,
  notifyRealSend,
  makeCoverContent,
  estimateDailyCoverBytes,
  isBurnerConversation,
  isCoverPayload,
  collectCoverArmedIds,
  _resetCoverTrafficStateForTests,
  COVER_MIN_INTERVAL_MS,
  COVER_MAX_INTERVAL_MS,
} from '../coverTraffic'

describe('samplePoissonInterval', () => {
  it('menghasilkan interval dalam clamp [10s, 15min] untuk seluruh rentang u', () => {
    for (let i = 0; i <= 100; i++) {
      const interval = samplePoissonInterval(0.5, () => i / 100)
      expect(interval).toBeGreaterThanOrEqual(COVER_MIN_INTERVAL_MS)
      expect(interval).toBeLessThanOrEqual(COVER_MAX_INTERVAL_MS)
    }
  })

  it('u→0 (raw tak terhingga) di-clamp ke max, u→1 di-clamp ke min', () => {
    expect(samplePoissonInterval(0.5, () => Number.MIN_VALUE)).toBe(COVER_MAX_INTERVAL_MS)
    expect(samplePoissonInterval(0.5, () => 0.999999)).toBe(COVER_MIN_INTERVAL_MS)
  })

  it('deterministik terhadap rng yang disuntik', () => {
    expect(samplePoissonInterval(0.5, () => 0.5)).toBe(samplePoissonInterval(0.5, () => 0.5))
    // λ lebih tinggi → interval lebih pendek (u sama).
    expect(samplePoissonInterval(2, () => 0.5)).toBeLessThanOrEqual(samplePoissonInterval(0.5, () => 0.5))
  })
})

describe('coverShouldYield (rate-limit backoff 26.10.4)', () => {
  beforeEach(() => {
    _resetCoverTrafficStateForTests()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('tidak yield saat bucket longgar', () => {
    expect(coverShouldYield(Date.now())).toBe(false)
  })

  it('yield setelah banyak real send mendekati soft cap 118/min [27.2.4: bucket server 120]', () => {
    const now = Date.now()
    for (let i = 0; i < 118; i++) notifyRealSend(now - i * 100)
    expect(coverShouldYield(now)).toBe(true)
  })

  it('tidak yield di bawah soft cap (100 real send dalam window 60s)', () => {
    const now = Date.now()
    // Spread 100 send di seluruh window (spacing 600ms) — semuanya > now-60s.
    for (let i = 0; i < 100; i++) notifyRealSend(now - i * 600)
    expect(coverShouldYield(now)).toBe(false)
  })

  it('real send yang lebih tua dari 60s tidak dihitung', () => {
    const now = Date.now()
    // Baris pertama juga mem-prune sisa state test sebelumnya (semuanya
    // lebih tua dari now-60s karena fake timers maju). Setelah prune,
    // tambahkan real send 61s lalu — semuanya di luar window.
    for (let i = 0; i < 118; i++) notifyRealSend(now - 61_000)
    notifyRealSend(now - 120_000) // trigger prune
    expect(coverShouldYield(now)).toBe(false)
  })
})

describe('CoverTrafficScheduler', () => {
  function makeScheduler(overrides: Partial<ConstructorParameters<typeof CoverTrafficScheduler>[0]> = {}) {
    const sentTo: string[] = []
    const scheduler = new CoverTrafficScheduler({
      masterEnabled: true,
      maximumGroups: new Set(['g1']),
      isVisible: () => true,
      isTransportConnected: () => true,
      onSendCover: (id) => sentTo.push(id),
      ...overrides,
    })
    return { scheduler, sentTo }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fire cover untuk grup yang opted-in', () => {
    const { scheduler, sentTo } = makeScheduler()
    scheduler.start('g1')
    // Interval max 15min — advance lebih dari itu memastikan ≥1 fire.
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).toContain('g1')
  })

  it('TIDAK fire untuk grup yang tidak opted-in (client-local opt-in)', () => {
    const { scheduler, sentTo } = makeScheduler()
    scheduler.start('g2') // tidak ada di maximumGroups
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).not.toContain('g2')
  })

  it('master kill-switch menghentikan semua pengiriman', () => {
    const { scheduler, sentTo } = makeScheduler()
    scheduler.start('g1')
    scheduler.updatePreferences({ masterEnabled: false })
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS * 3)
    expect(sentTo).not.toContain('g1')
  })

  it('skip tick saat transport putus / tab hidden (tidak menumpuk antrean)', () => {
    const { scheduler, sentTo } = makeScheduler({ isTransportConnected: () => false })
    scheduler.start('g1')
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).toEqual([]) // skipped, bukan queued
    // Koneksi pulih → tick berikutnya bisa fire.
    scheduler.updatePreferences({ isTransportConnected: () => true })
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).toContain('g1')
  })

  it('stop() menghentikan pengiriman untuk satu percakapan', () => {
    const { scheduler, sentTo } = makeScheduler()
    scheduler.start('g1')
    scheduler.stop('g1')
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS * 3)
    expect(sentTo).toEqual([])
  })

  it('sync() menambah dan menghapus timer sesuai daftar', () => {
    const { scheduler, sentTo } = makeScheduler()
    scheduler.sync(['g1', 'gX'])
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).toContain('g1')
    expect(sentTo).not.toContain('gX')
  })
})

describe('[26.10.5 Q5] burner default Maximum', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('isBurnerConversation mengenali prefix burner_', () => {
    expect(isBurnerConversation('burner_abc123')).toBe(true)
    expect(isBurnerConversation('conv-123')).toBe(false)
    expect(isBurnerConversation('')).toBe(false)
  })

  it('scheduler FIRE untuk burner tanpa opt-in eksplisit (default Maximum)', () => {
    const sentTo: string[] = []
    const scheduler = new CoverTrafficScheduler({
      masterEnabled: true,
      maximumGroups: new Set<string>(), // TIDAK ada burner di sini
      isVisible: () => true,
      isTransportConnected: () => true,
      onSendCover: (id) => sentTo.push(id),
    })
    scheduler.start('burner_abc123')
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).toContain('burner_abc123')
  })

  it('master kill-switch TETAP menang atas default burner', () => {
    const sentTo: string[] = []
    const scheduler = new CoverTrafficScheduler({
      masterEnabled: false,
      maximumGroups: new Set<string>(),
      isVisible: () => true,
      isTransportConnected: () => true,
      onSendCover: (id) => sentTo.push(id),
    })
    scheduler.start('burner_abc123')
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS * 3)
    expect(sentTo).toEqual([])
  })

  it('collectCoverArmedIds menggabungkan grup Maximum + semua burner (dedupe)', () => {
    const armed = collectCoverArmedIds(
      ['g1', 'g2'],
      [{ id: 'burner_a' }, { id: 'conv-x' }, { id: 'g1' }, { id: 'burner_b' }],
    )
    expect(armed).toEqual(['g1', 'g2', 'burner_a', 'burner_b'])
    // burners tanpa conversation store entry tetap ter-unggulkan dari daftar Maximum
    expect(collectCoverArmedIds(['burner_a'], [{ id: 'burner_a' }])).toEqual(['burner_a'])
  })

  it('collectCoverArmedIds mengabaikan id non-string / entri kosong', () => {
    const armed = collectCoverArmedIds([], [{ id: undefined as unknown as string }, { id: 'burner_ok' }])
    expect(armed).toEqual(['burner_ok'])
  })

  it('isCoverPayload mengenali payload COVER yang didekripsi (jalur burner DR)', () => {
    expect(isCoverPayload(makeCoverContent())).toBe(true)
    expect(isCoverPayload(JSON.stringify({ type: 'file', url: 'x' }))).toBe(false)
    expect(isCoverPayload('halo biasa')).toBe(false)
    expect(isCoverPayload('{not json')).toBe(false)
    expect(isCoverPayload('')).toBe(false)
  })

  it('sync() meng-arm burner yang baru muncul di conversation store', () => {
    const sentTo: string[] = []
    const scheduler = new CoverTrafficScheduler({
      masterEnabled: true,
      maximumGroups: new Set<string>(),
      isVisible: () => true,
      isTransportConnected: () => true,
      onSendCover: (id) => sentTo.push(id),
    })
    scheduler.sync(collectCoverArmedIds([], [{ id: 'burner_new' }]))
    vi.advanceTimersByTime(COVER_MAX_INTERVAL_MS + 1000)
    expect(sentTo).toContain('burner_new')
  })
})

describe('payload & estimasi', () => {
  it('makeCoverContent: payload { type: COVER, ts } — dikenali parseSilent client', () => {
    const content = makeCoverContent()
    const parsed = JSON.parse(content) as { type: string; ts: number }
    expect(parsed.type).toBe('COVER')
    expect(typeof parsed.ts).toBe('number')
  })

  it('estimasi harian: 0.5/min × 8KB ≈ 5.6MB/hari (angka jujur untuk UI)', () => {
    const bytes = estimateDailyCoverBytes()
    expect(bytes).toBeGreaterThan(5 * 1024 * 1024)
    expect(bytes).toBeLessThan(6.5 * 1024 * 1024)
  })
})
