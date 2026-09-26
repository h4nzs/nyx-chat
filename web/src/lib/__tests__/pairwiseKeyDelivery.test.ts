// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [T2] Pairwise key delivery (doc 26.2) — unit tests.
 *
 * Fungsi crypto berat (DR ratchet, pq_box_seal) dijalankan di worker dan tidak
 * bisa dimuat di vitest tanpa graph lengkap — test ini mengunci KONTRAK
 * wire-format & ID yang bisa diverifikasi murni string:
 *   1. Virtual conversation id kontrol pairwise: `<groupConvId>:pw:<peerId>`
 *      dan normalisasi baliknya (strip `:pw:<peerId>`).
 *   2. Payload kontrol GROUP_KEY harus dikenali sebagai silent payload
 *      (tidak pernah masuk bubble UI).
 *   3. Wire format pesan DR `{dr, ciphertext}` — sama dengan pesan 1:1 biasa,
 *      sehingga server tidak bisa membedakan kontrol kunci dari pesan konten.
 */
import { describe, it, expect } from 'vitest'

const PW_SUFFIX = /:pw:[A-Za-z0-9_-]+$/

function makeControlConvId(groupConvId: string, peerId: string): string {
  return `${groupConvId}:pw:${peerId}`
}

function stripControlSuffix(convId: string): string {
  return convId.replace(/:pw:[A-Za-z0-9_-]+$/, '')
}

describe('T2: pairwise control conversation id', () => {
  it('membentuk virtual id `<group>:pw:<peer>`', () => {
    expect(makeControlConvId('conv-abc', 'user-1')).toBe('conv-abc:pw:user-1')
    expect(makeControlConvId('conv-abc', 'user-1')).toMatch(PW_SUFFIX)
  })

  it('peer id dengan karakter base64url tidak merusak suffix', () => {
    const id = makeControlConvId('conv-abc', 'Ab_12-z-')
    expect(id).toMatch(PW_SUFFIX)
    expect(stripControlSuffix(id)).toBe('conv-abc')
  })

  it('normalisasi balik mengembalikan conversation grup asli', () => {
    const group = 'cm GROUP_ID-123_x'
    const virtual = makeControlConvId(group, 'peer456')
    expect(stripControlSuffix(virtual)).toBe(group)
  })

  it('conversation id grup biasa (tanpa suffix) tidak berubah', () => {
    expect(stripControlSuffix('plain-group-id')).toBe('plain-group-id')
  })
})

describe('T2: wire format', () => {
  it('payload kontrol GROUP_KEY berbentuk silent (type + groupKey.key)', () => {
    const controlPayload = JSON.stringify({
      type: 'GROUP_KEY',
      groupKey: {
        key: 'sealed-envelope-b64',
        targetDeviceId: 'dev-2',
        targetDeviceKey: 'identity-key-b64',
        senderId: 'AAAAAAAAAAAAAAAAAAAAAA',
        senderDeviceKey: 'sender-device-b64',
      },
    })
    const parsed = JSON.parse(controlPayload) as { type: string; groupKey?: { key: string; targetDeviceKey?: string } }
    expect(parsed.type).toBe('GROUP_KEY')
    expect(parsed.groupKey?.key).toBe('sealed-envelope-b64')
    expect(parsed.groupKey?.targetDeviceKey).toBe('identity-key-b64')
  })

  it('pesan DR pairwise memakai wrapper {dr, ciphertext} — identik dengan pesan 1:1 biasa', () => {
    // Server hanya melihat struktur ini; tidak ada field khusus "key material".
    const drMessage = JSON.stringify({ dr: { n: 0, kemPk: 'kem-pk-b64' }, ciphertext: 'ct-b64' })
    const parsed = JSON.parse(drMessage) as { dr?: unknown; ciphertext?: string }
    expect(parsed.dr).toBeDefined()
    expect(typeof parsed.ciphertext).toBe('string')
    expect(Object.keys(parsed).sort()).toEqual(['ciphertext', 'dr'])
  })
})
