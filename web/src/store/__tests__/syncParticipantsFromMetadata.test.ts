// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Unit test T4: syncParticipantsFromMetadata — mirror roster metadata v3
 * (sumber kebenaran) ke participants store.
 *
 * Kontrak yang dikunci:
 *  1. Roster metadata → participants utuh (id, role ter-normalisasi).
 *  2. Profile cache anggota lama (name/username/avatar/encryptedProfile)
 *     TIDAK hilang saat re-sync.
 *  3. Anggota yang keluar dari roster metadata ikut hilang dari mirror.
 *  4. Percakapan lain tidak tersentuh.
 *  5. Roster korup (entri tanpa userId, role aneh) tetap aman via
 *     parseGroupMembers (fail-safe MEMBER).
 *
 * Pola mock mengikuti unreadCount.test.ts (mock '@utils/crypto',
 * '@lib/api', '@lib/transportClient', dst. supaya graph store ringan).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@utils/crypto', () => ({
  encryptMessage: vi.fn().mockResolvedValue({ ciphertext: 'ct', mk: undefined }),
  encryptGroupMetadata: vi.fn().mockResolvedValue('meta'),
  decryptGroupMetadata: vi.fn().mockResolvedValue(null),
  forceRotateGroupSenderKey: vi.fn().mockResolvedValue(undefined),
  ensureGroupSession: vi.fn().mockResolvedValue(undefined),
  checkAndRefillOneTimePreKeys: vi.fn(),
}))
vi.mock('@lib/api', () => ({ api: vi.fn().mockResolvedValue([]), authFetch: vi.fn() }))
vi.mock('@lib/transportClient', () => ({
  transportClient: { connected: false, sendEvent: vi.fn(), on: vi.fn() },
  emitSessionKeyRequest: vi.fn(),
  emitGroupKeyDistribution: vi.fn(),
  emitMetadataUpdated: vi.fn(),
  fireGhostSync: vi.fn(),
  disconnectSocket: vi.fn(),
  connectSocket: vi.fn(),
}))
vi.mock('../verification', () => ({
  useVerificationStore: { getState: () => ({ loadInitialStatus: vi.fn() }) },
}))
vi.mock('../auth', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'me' }, loginGeneration: 0 }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }))
vi.mock('@utils/feedback', () => ({ captureAndLog: vi.fn() }))
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }))

import { useConversationStore } from '../conversation'
import { asConversationId, asUserId } from '@nyx/shared'
import type { GroupMemberEntry } from '@nyx/shared'

const convId = asConversationId('conv-roster')

function findConv() {
  return useConversationStore.getState().conversations.find(c => c.id === convId)!
}

describe('syncParticipantsFromMetadata (T4 roster v3 mirror)', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [
        {
          id: convId,
          isGroup: true,
          participants: [
            { id: asUserId('me'), role: 'MEMBER' },
          ],
        },
        {
          id: asConversationId('conv-lain'),
          isGroup: true,
          participants: [{ id: asUserId('orang-lain'), role: 'MEMBER' }],
        },
      ],
      activeId: null,
    } as never)
  })

  it('mirror roster penuh: role OWNER/ADMIN/MEMBER tersambung ke participants', () => {
    const members: GroupMemberEntry[] = [
      { userId: 'me', role: 'OWNER', joinedAtGeneration: 1 },
      { userId: 'admin-1', role: 'ADMIN', joinedAtGeneration: 1 },
      { userId: 'member-1', role: 'MEMBER', joinedAtGeneration: 1 },
    ]
    useConversationStore.getState().syncParticipantsFromMetadata(convId, members)

    const participants = findConv().participants
    expect(participants.map(p => ({ id: p.id, role: p.role }))).toEqual([
      { id: asUserId('me'), role: 'OWNER' },
      { id: asUserId('admin-1'), role: 'ADMIN' },
      { id: asUserId('member-1'), role: 'MEMBER' },
    ])
  })

  it('re-sync MEMPERTAHANKAN profile cache anggota lama (name/avatar/encryptedProfile)', () => {
    useConversationStore.setState({
      conversations: [
        {
          id: convId,
          isGroup: true,
          participants: [
            {
              id: asUserId('peer-lama'),
              name: 'Budi',
              username: 'budi',
              avatarUrl: 'https://cdn/ava.png',
              encryptedProfile: 'enc-profile',
              role: 'MEMBER',
            },
          ],
        },
      ],
      activeId: null,
    } as never)

    // Promosi peer-lama jadi ADMIN — profile harus tetap utuh.
    useConversationStore.getState().syncParticipantsFromMetadata(convId, [
      { userId: 'peer-lama', role: 'ADMIN', joinedAtGeneration: 2 },
    ])

    const p = findConv().participants[0]!
    expect(p.role).toBe('ADMIN')
    expect(p.name).toBe('Budi')
    expect(p.username).toBe('budi')
    expect(p.avatarUrl).toBe('https://cdn/ava.png')
    expect(p.encryptedProfile).toBe('enc-profile')
  })

  it('anggota yang keluar dari roster metadata ikut hilang dari mirror', () => {
    useConversationStore.setState({
      conversations: [
        {
          id: convId,
          isGroup: true,
          participants: [
            { id: asUserId('me'), role: 'OWNER' },
            { id: asUserId('kick-me'), role: 'MEMBER' },
          ],
        },
      ],
      activeId: null,
    } as never)

    // Roster baru tanpa 'kick-me' (sudah di-kick).
    useConversationStore.getState().syncParticipantsFromMetadata(convId, [
      { userId: 'me', role: 'OWNER', joinedAtGeneration: 1 },
    ])

    expect(findConv().participants.map(p => p.id)).toEqual([asUserId('me')])
  })

  it('percakapan lain tidak tersentuh', () => {
    const lainId = asConversationId('conv-lain')
    useConversationStore.getState().syncParticipantsFromMetadata(convId, [
      { userId: 'me', role: 'OWNER', joinedAtGeneration: 1 },
    ])
    const lain = useConversationStore.getState().conversations.find(c => c.id === lainId)!
    expect(lain.participants).toEqual([{ id: asUserId('orang-lain'), role: 'MEMBER' }])
  })

  it('roster korup (entri tanpa userId, role aneh) tetap aman — fail-safe MEMBER', () => {
    // parseGroupMembers dibuang entri korup + normalisasi role sebelum mirror.
    useConversationStore.getState().syncParticipantsFromMetadata(convId, [
      { userId: 'u1', role: 'HACKER', joinedAtGeneration: 1 },
      { role: 'ADMIN', joinedAtGeneration: 1 },
    ] as never as GroupMemberEntry[])

    const participants = findConv().participants
    expect(participants).toHaveLength(1)
    expect(participants[0]).toMatchObject({ id: asUserId('u1'), role: 'MEMBER' })
  })
})

describe('removeParticipant + addParticipants sinkron metadata.members (T4 race fix)', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [
        {
          id: convId,
          isGroup: true,
          requiresKeyRotation: false,
          participants: [
            { id: asUserId('me'), role: 'OWNER' },
            { id: asUserId('peer-1'), role: 'MEMBER' },
          ],
          decryptedMetadata: {
            v: 3,
            generation: 2,
            participants: ['me', 'peer-1'],
            pseudonymMap: { P1: 'me', P2: 'peer-1' },
            members: [
              { userId: 'me', role: 'OWNER', joinedAtGeneration: 1 },
              { userId: 'peer-1', role: 'MEMBER', joinedAtGeneration: 1 },
            ],
          },
        },
      ],
      activeId: null,
    } as never)
  })

  it('kick: removeParticipant menghapus JUGA dari metadata.members/participants', () => {
    useConversationStore.getState().removeParticipant(convId, 'peer-1')

    const conv = findConv()
    // Mirror & metadata sama-sama bersih dari kicked member.
    expect(conv.participants.map(p => p.id)).toEqual([asUserId('me')])
    const meta = conv.decryptedMetadata as { members: GroupMemberEntry[]; participants: string[] }
    expect(meta.members.map(m => m.userId)).toEqual(['me'])
    expect(meta.participants).toEqual(['me'])
    // Regresi lama: roster-sync tidak boleh mem-mirror kicked member kembali.
    expect(conv.requiresKeyRotation).toBe(true)
  })

  it('add: addParticipants memasukkan anggota baru ke metadata.members (MEMBER)', () => {
    useConversationStore.getState().addParticipants(convId, [
      { id: asUserId('newbie'), name: '', role: 'MEMBER' },
    ])

    const conv = findConv()
    expect(conv.participants.map(p => p.id)).toContain(asUserId('newbie'))
    const meta = conv.decryptedMetadata as { members: GroupMemberEntry[]; participants: string[] }
    expect(meta.members.map(m => m.userId)).toContain('newbie')
    const newbie = meta.members.find(m => m.userId === 'newbie')!
    expect(newbie.role).toBe('MEMBER')
    expect(newbie.joinedAtGeneration).toBe(2) // generation berjalan
    expect(meta.participants).toContain('newbie')
  })

  it('kick → sync mirror: kicked member TIDAK hidup kembali (regresi utama)', () => {
    useConversationStore.getState().removeParticipant(convId, 'peer-1')
    // Simulasi GroupInfoPanel roster-sync yang memicu ulang dengan metadata
    // TERBARU (tanpa peer-1) — mirror harus tetap konsisten.
    const meta = findConv().decryptedMetadata as { members: GroupMemberEntry[] }
    useConversationStore.getState().syncParticipantsFromMetadata(convId, meta.members)
    expect(findConv().participants.map(p => p.id)).toEqual([asUserId('me')])
  })
})
