// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Unit test T4 rotasi metadata — regresi bug "member baru bisa terima,
 * tidak bisa kirim".
 *
 * Kontrak yang dikunci:
 *  1. `pseudonymMap` lama DIBUANG (penulis metadata wajib meregenerasi peta
 *     untuk roster baru; peta stale = anggota baru tanpa pseudonym sendiri).
 *  2. Anggota baru masuk `participants` + `members` dengan
 *     `joinedAtGeneration` = generation baru.
 *  3. Role anggota lama dipertahankan; anggota yang keluar hilang.
 *  4. `generation` di metadata BELUM dinaikkan (encryptGroupMetadata menaikkan
 *     tepat sekali saat peta tidak ada) — menghindari lompatan +2.
 *  5. Delivery token hasil invite di-merge ke `deliveryTokenMap`.
 */
import { describe, it, expect } from 'vitest'
import type { GroupMemberEntry } from '@nyx/shared'
import { buildRotatedGroupMetadata } from '@lib/groupMetadataRotation'

const existing = {
  v: 3 as const,
  generation: 5,
  title: 'Ops',
  authSecret: 'secret',
  participants: ['me', 'peer'],
  pseudonymMap: { pseudo_me: 'me', pseudo_peer: 'peer' },
  deliveryTokenMap: { me: 'tok-me', peer: 'tok-peer' },
  members: [
    { userId: 'me', role: 'OWNER', joinedAtGeneration: 1 },
    { userId: 'peer', role: 'ADMIN', joinedAtGeneration: 2 },
  ] as GroupMemberEntry[],
}

describe('buildRotatedGroupMetadata', () => {
  it('membuang pseudonymMap lama supaya peta diregenerasi untuk roster baru', () => {
    const { metadata } = buildRotatedGroupMetadata(existing, ['me', 'peer', 'newbie'])
    expect(metadata.pseudonymMap).toBeUndefined()
  })

  it('memasukkan anggota baru ke participants + members (MEMBER, generation baru)', () => {
    const { metadata, generation } = buildRotatedGroupMetadata(existing, ['me', 'peer', 'newbie'], {
      newbie: 'tok-newbie',
    })

    expect(generation).toBe(6)
    expect(metadata.participants).toEqual(['me', 'peer', 'newbie'])
    const members = metadata.members as GroupMemberEntry[]
    expect(members.map(m => m.userId)).toEqual(['me', 'peer', 'newbie'])
    expect(members.find(m => m.userId === 'newbie')).toEqual({
      userId: 'newbie',
      role: 'MEMBER',
      joinedAtGeneration: 6,
    })
  })

  it('mempertahankan role anggota lama dan membuang anggota yang keluar', () => {
    const { metadata } = buildRotatedGroupMetadata(existing, ['me', 'newbie'])
    const members = metadata.members as GroupMemberEntry[]
    expect(members).toEqual([
      { userId: 'me', role: 'OWNER', joinedAtGeneration: 1 },
      { userId: 'newbie', role: 'MEMBER', joinedAtGeneration: 6 },
    ])
    expect(metadata.participants).toEqual(['me', 'newbie'])
  })

  it('tidak menaikkan generation di metadata (encrypt menaikkan tepat sekali)', () => {
    const { metadata, generation } = buildRotatedGroupMetadata(existing, ['me'])
    expect(metadata.generation).toBe(5)
    expect(generation).toBe(6)
    expect(metadata.v).toBe(3)
  })

  it('menggabungkan delivery token invite dan mempertahankan token lama', () => {
    const { metadata } = buildRotatedGroupMetadata(existing, ['me', 'peer', 'newbie'], {
      newbie: 'tok-newbie',
    })
    expect(metadata.deliveryTokenMap).toEqual({
      me: 'tok-me',
      peer: 'tok-peer',
      newbie: 'tok-newbie',
    })
  })

  it('token baru menang bila id sama (re-invite)', () => {
    const { metadata } = buildRotatedGroupMetadata(existing, ['me', 'peer'], { peer: 'tok-peer-2' })
    expect((metadata.deliveryTokenMap as Record<string, string>).peer).toBe('tok-peer-2')
  })
})
