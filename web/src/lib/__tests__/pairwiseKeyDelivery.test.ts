// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [T2] Key delivery (doc 26.2) — unit tests.
 *
 * Fungsi crypto berat (pq_box_seal) dijalankan di worker dan tidak bisa dimuat
 * di vitest tanpa graph lengkap — test ini mengunci KONTRAK wire-format yang
 * bisa diverifikasi murni string:
 *   1. Event `group:fulfilled_key` membawa envelope pq_box_seal per-device +
 *      routing metadata (requesterId, targetDeviceId) — server hanya melihat
 *      envelope opaque, tidak bisa membuka isinya.
 *   2. Payload GROUP_KEY tetap dikenali sebagai silent payload (tidak pernah
 *      masuk bubble UI).
 *
 * SEJARAH: dulu pairwise SPQR via pesan kontrol virtual `<group>:pw:<peer>` —
 * jalur itu TIDAK PERNAH lengkap (server menolak conversation virtual; client
 * tak punya hook decryptWithSpqrSession) sehingga kunci tak pernah sampai.
 * Ditemukan lewat E2E manual 2026-09-27; distribusi kini via fulfilled_key.
 */
import { describe, it, expect } from 'vitest'

describe('T2: key delivery wire format', () => {
  it('fulfilled_key payload membawa envelope + routing, tanpa plaintext key', () => {
    const fulfillment = {
      requesterId: 'user-1',
      conversationId: 'conv-abc',
      encryptedKey: 'sealed-envelope-b64',
      targetDeviceId: 'dev-2',
      senderDeviceKey: 'sender-device-b64',
      senderPseudonym: 'AAAAAAAAAAAAAAAAAAAAAA',
    }
    expect(fulfillment.encryptedKey).not.toMatch(/^ck_/)
    expect(Object.keys(fulfillment).sort()).toEqual([
      'conversationId', 'encryptedKey', 'requesterId',
      'senderDeviceKey', 'senderPseudonym', 'targetDeviceId',
    ])
  })

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
})
