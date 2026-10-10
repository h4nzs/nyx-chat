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

// [docs/28 Tier 4] ensureMyPseudonym boleh jatuh ke decryptGroupMetadata; di
// unit test ini cukup di-mock (bukan graph crypto yang berat).
vi.mock('@utils/crypto', () => ({
  decryptGroupMetadata: vi.fn(async () => null),
}))

import {
  generateGroupPseudonym,
  generatePseudonymMap,
  getPseudonymMap,
  getMyPseudonym,
  ensureMyPseudonym,
  resolveSenderIdentityForGroup,
  requireGroupSenderIdentity,
  resolvePseudonymToUserId,
  isEphemeralReceipts,
  scheduleEphemeralReceipt,
  RECEIPT_JITTER_MAX_MS,
} from '../groupPseudonyms'
import { decryptGroupMetadata } from '@utils/crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const decryptGroupMetadataMock = vi.mocked(decryptGroupMetadata)

async function setConversations(convs: Array<Record<string, unknown>>) {
  conversations = convs
}

describe('T1 pseudonym helpers (lib/groupPseudonyms)', () => {
  beforeEach(async () => {
    counter = 0
    ephemeralGroups = []
    decryptGroupMetadataMock.mockReset()
    decryptGroupMetadataMock.mockResolvedValue(null)
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

  // [docs/28 Tier 4] Temuan audit dump 2026-10-09: klien sering TIDAK punya
  // pseudonym di store (peta belum ter-hydrate) sehingga jalur kirim jatuh ke
  // `?? myId` dan userId asli tersimpan di Message.senderId + wrapper pesan.
  it('ensureMyPseudonym: peta di store dipakai langsung (tanpa decrypt)', async () => {
    await setConversations([
      { id: 'conv1', isGroup: true, decryptedMetadata: { v: 3, pseudonymMap: { AAAA: 'peer-1', BBBB: 'me-user' } } },
    ])
    expect(await ensureMyPseudonym('conv1')).toBe('BBBB')
    expect(decryptGroupMetadataMock).not.toHaveBeenCalled()
  })

  it('ensureMyPseudonym: hydrate dari metadata v2 yang belum ter-decrypt', async () => {
    // Metadata v2 asli membawa `pseudonymMap`; tipe balikan publik hanya
    // menyebut field roster, jadi cast eksplisit untuk fixture test.
    decryptGroupMetadataMock.mockResolvedValueOnce(
      { v: 2, pseudonymMap: { CCCC: 'me-user' } } as never
    )
    await setConversations([
      {
        id: 'conv2',
        isGroup: true,
        encryptedMetadata: JSON.stringify({ v: 2, kind: 'group_metadata', chainId: 'c', ct: 'x', signature: 's' }),
      },
    ])
    expect(await ensureMyPseudonym('conv2')).toBe('CCCC')
    expect(decryptGroupMetadataMock).toHaveBeenCalledTimes(1)
  })

  it('ensureMyPseudonym: blob non-v2 / tanpa metadata → undefined (tidak menyentuh rantai)', async () => {
    await setConversations([
      { id: 'conv-v1', isGroup: true, encryptedMetadata: JSON.stringify({ header: { n: 0 }, ciphertext: 'ct' }) },
      { id: 'conv-none', isGroup: true },
    ])
    expect(await ensureMyPseudonym('conv-v1')).toBeUndefined()
    expect(await ensureMyPseudonym('conv-none')).toBeUndefined()
    expect(decryptGroupMetadataMock).not.toHaveBeenCalled()
  })

  it('resolveSenderIdentityForGroup: selalu pseudonym; tanpa peta (termasuk v1) → undefined (tanpa fallback userId)', async () => {
    await setConversations([
      { id: 'v2-ok', isGroup: true, decryptedMetadata: { v: 2, pseudonymMap: { PPPP: 'me-user' } } },
      { id: 'v1-legacy', isGroup: true, decryptedMetadata: { title: 'legacy' } },
      { id: 'v2-no-map', isGroup: true, decryptedMetadata: { v: 2, generation: 3 } },
    ])
    expect(await resolveSenderIdentityForGroup('v2-ok')).toBe('PPPP')
    expect(await resolveSenderIdentityForGroup('v2-no-map')).toBeUndefined()
    // Tidak ada lagi fallback userId untuk grup tanpa peta (v1 dihapus).
    expect(await resolveSenderIdentityForGroup('v1-legacy')).toBeUndefined()
  })

  // [BUGFIX 2026-10-10] Wrapper pesan grup WAJIB punya senderId — kalau tidak,
  // penerima gagal me-route receiver state. Gagal keras di pengirim.
  it('requireGroupSenderIdentity: pseudonym tersedia → dikembalikan apa adanya', () => {
    expect(requireGroupSenderIdentity('PSEUDO-OK', 'conv1')).toBe('PSEUDO-OK')
  })

  it('requireGroupSenderIdentity: tanpa pseudonym → throw jelas, BUKAN userId/undefined', () => {
    expect(() => requireGroupSenderIdentity(undefined, 'conv-x')).toThrowError(
      /Pseudonym pengirim grup tidak tersedia untuk conv-x/
    )
    expect(() => requireGroupSenderIdentity('', 'conv-y')).toThrowError(/tidak tersedia/)
  })

  it('guard sumber: doEncryptMessage memakai requireGroupSenderIdentity (tanpa fallback userId)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(path.join(here, '../../utils/crypto.ts'), 'utf8')
    expect(src).toMatch(/requireGroupSenderIdentity\(\s*await resolveSenderIdentityForGroup\(conversationId\)/)
    // Tidak boleh ada fallback ke userId di jalur pengiriman pseudonym.
    expect(src).not.toMatch(/senderIdForServer\s*\?\?/)
  })

  it('guard: wrapper metadata v2 tidak lagi menulis senderId (userId penulis)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(path.join(here, '../../utils/crypto.ts'), 'utf8')
    const wrapper = src.slice(src.indexOf("kind: 'group_metadata'"), src.indexOf("kind: 'group_metadata'") + 400)
    expect(wrapper).not.toMatch(/senderId:/)
    expect(wrapper).toMatch(/senderDeviceKey/)
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
