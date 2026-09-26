// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Unit test T1 pseudonym helpers (doc 26.2 / keputusan 26.7.1).
 *
 * Module groupPseudonyms.ts sengaja ringan — hanya butuh auth/conversation
 * store + sodiumInitializer. Test mock store, bukan graph crypto.
 *
 * CATATAN PATH MOCK: file ada di src/lib/__tests__/ — '../auth' menunjuk
 * src/lib/auth? TIDAK — store ada di src/store. Karena itu auth/conversation
 * di-mock via path absolut '@store/…' (alias) yang resolve sama seperti
 * module asli; sodiumInitializer di-mock via '../sodiumInitializer'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Store mocks: conversation store stateful untuk peta metadata ---
let conversations: Array<Record<string, unknown>> = []
vi.mock('@store/conversation', () => ({
  useConversationStore: {
    getState: () => ({ conversations }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'me-user' } }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
// [26.10.5] Settings store untuk isEphemeralReceipts — stateful via variabel test.
let ephemeralGroups: string[] = []
vi.mock('@store/settings', () => ({
  useSettingsStore: {
    getState: () => ({ ephemeralReceiptsGroups: ephemeralGroups }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
vi.mock('../sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({
    randombytes_buf: (n: number) => {
      // PRNG deterministik per-call via counter global test.
      counter = (counter + 1) % 251
      return new Uint8Array(n).map((_, i) => (i * 31 + counter * 17 + 3) % 256)
    },
    to_base64: (b: Uint8Array, _v: number) => {
      // base64url fake: map byte → karakter unik (cukup untuk test collision).
      let s = ''
      for (const byte of b) s += String.fromCharCode(33 + (byte % 90))
      return s
    },
    from_base64: (s: string) => new Uint8Array(s.length),
    memzero: vi.fn(),
    base64_variants: { URLSAFE_NO_PADDING: 0, ORIGINAL: 1, URLSAFE: 2 },
  })),
}))

let counter = 0

import {
  generateGroupPseudonym,
  generatePseudonymMap,
  getPseudonymMap,
  getMyPseudonym,
  resolvePseudonymToUserId,
  isEphemeralReceipts,
  scheduleEphemeralReceipt,
  RECEIPT_JITTER_MAX_MS,
} from '../groupPseudonyms'

async function setConversations(convs: Array<Record<string, unknown>>) {
  conversations = convs
}

describe('T1 pseudonym helpers (lib/groupPseudonyms)', () => {
  beforeEach(async () => {
    counter = 0
    ephemeralGroups = []
    await setConversations([])
  })

  it('generateGroupPseudonym menghasilkan string non-kosong dari 16 byte random', async () => {
    const p = await generateGroupPseudonym()
    expect(typeof p).toBe('string')
    // Fake sodium menghasilkan 1 char per byte; yang penting: 16 byte input →
    // output non-kosong & deterministik-panjang. Real base64url(16B) = 22 char.
    expect(p.length).toBe(16)
  })

  it('generatePseudonymMap membuat entri unik per anggota tanpa tabrakan', async () => {
    const map = await generatePseudonymMap(['u1', 'u2', 'u3'])
    const pseudos = Object.keys(map)
    expect(pseudos).toHaveLength(3)
    expect(new Set(pseudos).size).toBe(3)
    expect(Object.values(map).sort()).toEqual(['u1', 'u2', 'u3'])
  })

  it('getPseudonymMap: v2 → peta; v1/tidak ada → undefined', async () => {
    await setConversations([
      { id: 'conv-v2', isGroup: true, decryptedMetadata: { v: 2, generation: 1, pseudonymMap: { AAAA: 'u1' } } },
      { id: 'conv-v1', isGroup: true, decryptedMetadata: { title: 'legacy' } },
    ])
    expect(getPseudonymMap('conv-v2')).toEqual({ AAAA: 'u1' })
    expect(getPseudonymMap('conv-v1')).toBeUndefined()
    expect(getPseudonymMap('conv-tidak-ada')).toBeUndefined()
  })

  it('getMyPseudonym menemukan pseudonym milik user sendiri', async () => {
    await setConversations([
      { id: 'conv1', isGroup: true, decryptedMetadata: { v: 2, generation: 1, pseudonymMap: { PSEUDO1: 'peer-1', PSEUDO2: 'me-user' } } },
    ])
    expect(await getMyPseudonym('conv1')).toBe('PSEUDO2')
    expect(await getMyPseudonym('conv-tidak-ada')).toBeUndefined()
  })

  it('resolvePseudonymToUserId: resolve benar; unknown/v1 → undefined', async () => {
    await setConversations([
      { id: 'conv1', isGroup: true, decryptedMetadata: { v: 2, generation: 1, pseudonymMap: { PSEUDO1: 'peer-1' } } },
    ])
    expect(resolvePseudonymToUserId('conv1', 'PSEUDO1')).toBe('peer-1')
    expect(resolvePseudonymToUserId('conv1', 'UNKNOWN')).toBeUndefined()
    await setConversations([{ id: 'conv-v1', isGroup: true, decryptedMetadata: {} }])
    expect(resolvePseudonymToUserId('conv-v1', 'PSEUDO1')).toBeUndefined()
  })

  it('kontrak rotasi 26.7.1: peta baru ≠ peta lama (full rewrite, unlinkable)', async () => {
    await setConversations([
      { id: 'conv1', isGroup: true, decryptedMetadata: { v: 2, generation: 3, pseudonymMap: { OLDPSEUDO: 'u1' } } },
    ])
    const oldMap = getPseudonymMap('conv1')
    const newMap = await generatePseudonymMap(['u1'])
    expect(oldMap).toEqual({ OLDPSEUDO: 'u1' })
    expect(Object.keys(newMap)[0]).not.toBe('OLDPSEUDO')
  })
})

describe('[26.10.5] ephemeral + jittered receipts (lib/groupPseudonyms)', () => {
  beforeEach(async () => {
    ephemeralGroups = []
    await setConversations([])
  })

  it('isEphemeralReceipts: burner selalu ephemeral (26.10.7), grup reguler default false', () => {
    expect(isEphemeralReceipts('burner_abc')).toBe(true)
    expect(isEphemeralReceipts('conv-reguler')).toBe(false)
  })

  it('isEphemeralReceipts: grup yang opt-in via settings store → true', () => {
    ephemeralGroups = ['conv-max']
    expect(isEphemeralReceipts('conv-max')).toBe(true)
    expect(isEphemeralReceipts('conv-lain')).toBe(false)
  })

  it('scheduleEphemeralReceipt: delay 0 (maxDelayMs=0) → kirim langsung sinkron', () => {
    let sent = false
    scheduleEphemeralReceipt('burner_x', 0, () => { sent = true })
    expect(sent).toBe(true)
  })

  it('scheduleEphemeralReceipt: delay > 0 → terjadwal via setTimeout', () => {
    vi.useFakeTimers()
    try {
      let sent = false
      scheduleEphemeralReceipt('burner_x', 45_000, () => { sent = true })
      expect(sent).toBe(false)
      vi.advanceTimersByTime(RECEIPT_JITTER_MAX_MS + 1)
      expect(sent).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('RECEIPT_JITTER_MAX_MS: kecil, jangan merusak UX read (≤60s)', () => {
    expect(RECEIPT_JITTER_MAX_MS).toBeGreaterThan(0)
    expect(RECEIPT_JITTER_MAX_MS).toBeLessThanOrEqual(60_000)
  })
})
