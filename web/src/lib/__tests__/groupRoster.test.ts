// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Unit test T4 roster v3 (doc 26 — keputusan desain 2026-09-30).
 *
 * Cakupan:
 *  - shared: parseGroupMembers (validasi roster tak terpercaya dari metadata
 *    terdekripsi — fail-safe ke MEMBER, buang entri korup)
 *  - shared: roleAtLeast + GROUP_ROLE_RANK (hierarki OWNER > ADMIN > MEMBER)
 *  - web: getGroupMembers / getMyGroupRole / amIGroupAdmin (baca metadata v3
 *    dari store; fallback legacy role participants untuk grup v1/v2)
 *
 * Pola mock mengikuti groupPseudonyms.test.ts: conversation & auth store
 * di-mock via alias '@store/…' (stateful via variabel test), sodium tidak
 * dibutuhkan karena helper roster tidak generate randomness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Store mocks: conversation store stateful untuk metadata roster ---
let conversations: Array<Record<string, unknown>> = []
vi.mock('@store/conversation', () => ({
  useConversationStore: {
    getState: () => ({ conversations }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
let myUserId = 'me-user'
vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: myUserId } }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
vi.mock('@store/settings', () => ({
  useSettingsStore: {
    getState: () => ({ ephemeralReceiptsGroups: [] }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
vi.mock('../sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({})),
}))

import { parseGroupMembers, roleAtLeast, GROUP_ROLE_RANK } from '@nyx/shared'
import { getGroupMembers, getMyGroupRole, amIGroupAdmin } from '../groupPseudonyms'

describe('parseGroupMembers (shared — validasi roster tak terpercaya)', () => {
  it('menerima roster valid utuh (userId, role, joinedAtGeneration)', () => {
    const roster = [
      { userId: 'u1', role: 'OWNER', joinedAtGeneration: 1 },
      { userId: 'u2', role: 'ADMIN', joinedAtGeneration: 2 },
      { userId: 'u3', role: 'MEMBER', joinedAtGeneration: 1 },
    ]
    expect(parseGroupMembers(roster)).toEqual(roster)
  })

  it('membuang entri tanpa userId / bukan objek / roster bukan array', () => {
    const out = parseGroupMembers([
      { role: 'ADMIN', joinedAtGeneration: 1 }, // tanpa userId
      null,                                      // bukan objek
      'bukan-objek',                             // bukan objek
      { userId: 'u-ok', role: 'MEMBER', joinedAtGeneration: 3 },
    ])
    expect(out).toEqual([{ userId: 'u-ok', role: 'MEMBER', joinedAtGeneration: 3 }])
    expect(parseGroupMembers(undefined)).toEqual([])
    expect(parseGroupMembers('corrupt')).toEqual([])
    expect(parseGroupMembers(42)).toEqual([])
  })

  it('role tidak dikenal fail-safe ke MEMBER (anggota tidak boleh hilang)', () => {
    const out = parseGroupMembers([
      { userId: 'u1', role: 'SUPERGOD', joinedAtGeneration: 1 },
      { userId: 'u2', role: undefined, joinedAtGeneration: 1 },
      { userId: 'u3', role: 123, joinedAtGeneration: 1 },
    ])
    expect(out.map(m => m.role)).toEqual(['MEMBER', 'MEMBER', 'MEMBER'])
    // userId & joinedAtGeneration tetap dipertahankan
    expect(out[0]?.userId).toBe('u1')
    expect(out[2]?.joinedAtGeneration).toBe(1)
  })

  it('joinedAtGeneration hilang/bukan number → 0', () => {
    const out = parseGroupMembers([
      { userId: 'u1', role: 'MEMBER' },
      { userId: 'u2', role: 'MEMBER', joinedAtGeneration: 'x' },
    ])
    expect(out.map(m => m.joinedAtGeneration)).toEqual([0, 0])
  })
})

describe('roleAtLeast (shared — hierarki OWNER > ADMIN > MEMBER)', () => {
  it('rank berurutan: OWNER(3) > ADMIN(2) > MEMBER(1)', () => {
    expect(GROUP_ROLE_RANK.OWNER).toBeGreaterThan(GROUP_ROLE_RANK.ADMIN)
    expect(GROUP_ROLE_RANK.ADMIN).toBeGreaterThan(GROUP_ROLE_RANK.MEMBER)
  })

  it('ADMIN memenuhi syarat minimum ADMIN & MEMBER, tapi bukan OWNER', () => {
    expect(roleAtLeast('ADMIN', 'ADMIN')).toBe(true)
    expect(roleAtLeast('ADMIN', 'MEMBER')).toBe(true)
    expect(roleAtLeast('ADMIN', 'OWNER')).toBe(false)
  })

  it('OWNER memenuhi semua minimum; MEMBER hanya MEMBER', () => {
    expect(roleAtLeast('OWNER', 'OWNER')).toBe(true)
    expect(roleAtLeast('OWNER', 'ADMIN')).toBe(true)
    expect(roleAtLeast('OWNER', 'MEMBER')).toBe(true)
    expect(roleAtLeast('MEMBER', 'MEMBER')).toBe(true)
    expect(roleAtLeast('MEMBER', 'ADMIN')).toBe(false)
    expect(roleAtLeast('MEMBER', 'OWNER')).toBe(false)
  })
})

describe('getGroupMembers / getMyGroupRole (web — baca metadata v3)', () => {
  beforeEach(async () => {
    myUserId = 'me-user'
    conversations = []
  })

  it('metadata v3 → roster ter-parse; v2/v1 → undefined (legacy)', () => {
    conversations = [
      {
        id: 'conv-v3',
        isGroup: true,
        decryptedMetadata: {
          v: 3,
          generation: 2,
          members: [
            { userId: 'me-user', role: 'OWNER', joinedAtGeneration: 1 },
            { userId: 'peer-1', role: 'MEMBER', joinedAtGeneration: 1 },
          ],
        },
      },
      { id: 'conv-v2', isGroup: true, decryptedMetadata: { v: 2, generation: 1, pseudonymMap: { A: 'me-user' } } },
      { id: 'conv-v1', isGroup: true, decryptedMetadata: { title: 'legacy' } },
    ]
    expect(getGroupMembers('conv-v3')).toEqual([
      { userId: 'me-user', role: 'OWNER', joinedAtGeneration: 1 },
      { userId: 'peer-1', role: 'MEMBER', joinedAtGeneration: 1 },
    ])
    // Role korup dalam metadata fail-safe MEMBER via parseGroupMembers.
    expect(getGroupMembers('conv-v2')).toBeUndefined()
    expect(getGroupMembers('conv-v1')).toBeUndefined()
    expect(getGroupMembers('tidak-ada')).toBeUndefined()
  })

  it('getMyGroupRole menemukan role saya dari roster', () => {
    conversations = [
      {
        id: 'conv1',
        isGroup: true,
        decryptedMetadata: {
          v: 3,
          generation: 1,
          members: [
            { userId: 'me-user', role: 'OWNER', joinedAtGeneration: 1 },
            { userId: 'peer-1', role: 'MEMBER', joinedAtGeneration: 1 },
          ],
        },
      },
    ]
    expect(getMyGroupRole('conv1')).toBe('OWNER')
    expect(getMyGroupRole('tidak-ada')).toBeUndefined()
  })

  it('getMyGroupRole: saya bukan anggota roster → undefined', () => {
    myUserId = 'outsider'
    conversations = [
      {
        id: 'conv1',
        isGroup: true,
        decryptedMetadata: {
          v: 3,
          generation: 1,
          members: [{ userId: 'peer-1', role: 'OWNER', joinedAtGeneration: 1 }],
        },
      },
    ]
    expect(getMyGroupRole('conv1')).toBeUndefined()
  })
})

describe('amIGroupAdmin (web — admin check dari roster, fallback legacy)', () => {
  beforeEach(async () => {
    myUserId = 'me-user'
    conversations = []
  })

  it('v3: OWNER dan ADMIN = admin; MEMBER bukan', () => {
    conversations = [
      {
        id: 'owner-conv',
        isGroup: true,
        decryptedMetadata: { v: 3, generation: 1, members: [{ userId: 'me-user', role: 'OWNER', joinedAtGeneration: 1 }] },
      },
      {
        id: 'admin-conv',
        isGroup: true,
        decryptedMetadata: { v: 3, generation: 1, members: [{ userId: 'me-user', role: 'ADMIN', joinedAtGeneration: 2 }] },
      },
      {
        id: 'member-conv',
        isGroup: true,
        decryptedMetadata: { v: 3, generation: 1, members: [{ userId: 'me-user', role: 'MEMBER', joinedAtGeneration: 2 }] },
      },
    ]
    expect(amIGroupAdmin('owner-conv')).toBe(true)
    expect(amIGroupAdmin('admin-conv')).toBe(true)
    expect(amIGroupAdmin('member-conv')).toBe(false)
  })

  it('fallback legacy v1/v2: role ADMIN dari participants store tetap dikenali', () => {
    conversations = [
      {
        id: 'legacy-admin',
        isGroup: true,
        decryptedMetadata: { v: 2, generation: 1, pseudonymMap: {} },
        participants: [{ id: 'me-user', role: 'ADMIN' }],
      },
      {
        id: 'legacy-member',
        isGroup: true,
        decryptedMetadata: { title: 'v1' },
        participants: [{ id: 'me-user', role: 'MEMBER' }],
      },
    ]
    expect(amIGroupAdmin('legacy-admin')).toBe(true)
    expect(amIGroupAdmin('legacy-member')).toBe(false)
  })

  it('fallback legacy: role OWNER di participants (mirror v3) juga admin', () => {
    conversations = [
      {
        id: 'legacy-owner',
        isGroup: true,
        decryptedMetadata: { title: 'v1' },
        participants: [{ id: 'me-user', role: 'OWNER' }],
      },
    ]
    expect(amIGroupAdmin('legacy-owner')).toBe(true)
  })
})
