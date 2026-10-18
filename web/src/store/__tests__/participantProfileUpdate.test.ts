// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] `user:updated` → participant snapshot.
 *
 * Bug: ketika peer mengganti nama/avatar, bubble chat & modal info ikut berubah
 * (profil diambil dari pesan / fetch langsung) tetapi daftar chat dan story tray
 * tetap memakai avatar lama. Penyebabnya participant 1:1 hanya hidup di klien
 * (Opaque Mailbox: server tak mengirim roster) dan tidak pernah diperbarui:
 *   - penulisan hanya cocok untuk `p.id === user.id` (participant pseudonym grup
 *     v2 dilewati), dan
 *   - hasilnya tidak dipersist ke ShadowVault sehingga hilang lagi saat reload.
 *
 * Kontrak yang dikunci di sini:
 *  1. 1:1: `encryptedProfile` participant diganti + dekripsi + contact store.
 *  2. Grup v2: participant pseudonym ikut diperbarui TANPA menimpa pseudonym
 *     dengan userId asli.
 *  3. Perubahan dipersist ke ShadowVault (bertahan setelah reload).
 *  4. User yang tidak ada di conversation mana pun tidak menyentuh apa pun.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { saveConversationMock, decryptAndCacheMock, upsertContactMock, pseudonymMaps } = vi.hoisted(() => ({
  saveConversationMock: vi.fn().mockResolvedValue(undefined),
  decryptAndCacheMock: vi.fn().mockResolvedValue({ name: 'Peer New' }),
  upsertContactMock: vi.fn().mockResolvedValue(undefined),
  pseudonymMaps: new Map<string, Record<string, string>>(),
}))

vi.mock('@utils/crypto', () => ({
  encryptMessage: vi.fn().mockResolvedValue({ ciphertext: 'ct', mk: undefined }),
  encryptGroupMetadata: vi.fn().mockResolvedValue('meta'),
  decryptGroupMetadata: vi.fn().mockResolvedValue(null),
  forceRotateGroupSenderKey: vi.fn().mockResolvedValue(undefined),
  ensureGroupSession: vi.fn().mockResolvedValue(undefined),
  checkAndRefillOneTimePreKeys: vi.fn(),
  generatePseudonymMap: vi.fn().mockResolvedValue({}),
  getPseudonymMap: (conversationId: string) => pseudonymMaps.get(conversationId),
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
vi.mock('@store/profile', () => ({
  useProfileStore: { getState: () => ({ decryptAndCache: decryptAndCacheMock }) },
}))
vi.mock('@lib/contactStore', () => ({ upsertContact: upsertContactMock }))
vi.mock('@lib/shadowVaultDb', () => ({ shadowVault: { saveConversation: saveConversationMock } }))
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

const directId = asConversationId('conv-direct')
const groupId = asConversationId('conv-group')

/** Biarkan rantai dynamic import + promise di dalam aksi selesai. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function findConv(id: string) {
  return useConversationStore.getState().conversations.find(c => c.id === id)!
}

describe('updateParticipantDetails — profil peer sampai ke daftar chat/story tray', () => {
  beforeEach(() => {
    saveConversationMock.mockClear()
    decryptAndCacheMock.mockClear()
    upsertContactMock.mockClear()
    pseudonymMaps.clear()

    useConversationStore.setState({
      conversations: [
        {
          id: directId,
          isGroup: false,
          participants: [
            { id: asUserId('me'), role: 'MEMBER' },
            { id: asUserId('peer'), role: 'MEMBER', encryptedProfile: 'OLD-DIRECT' },
          ],
        },
        {
          id: groupId,
          isGroup: true,
          participants: [
            { id: asUserId('pseudo-peer'), role: 'MEMBER', encryptedProfile: 'OLD-GROUP' },
          ],
        },
      ],
      activeId: null,
    } as never)
  })

  it('1:1: encryptedProfile participant diganti, didekripsi, dan kontak disegarkan', async () => {
    useConversationStore.getState().updateParticipantDetails({ id: asUserId('peer'), encryptedProfile: 'NEW-DIRECT' })
    await flushAsync()

    const peer = findConv(directId).participants.find(p => String(p.id) === 'peer')!
    expect(peer.encryptedProfile).toBe('NEW-DIRECT')

    expect(decryptAndCacheMock).toHaveBeenCalledWith('peer', 'NEW-DIRECT')
    expect(upsertContactMock).toHaveBeenCalledWith({ userId: 'peer', encryptedProfile: 'NEW-DIRECT' })
    expect(saveConversationMock).toHaveBeenCalled()
    const persisted = saveConversationMock.mock.calls[0]![0] as { id: string; participants: Array<{ id: string; encryptedProfile?: string }> }
    expect(persisted.id).toBe(directId)
    expect(persisted.participants.find(p => p.id === 'peer')!.encryptedProfile).toBe('NEW-DIRECT')

    // Percakapan lain tidak tersentuh.
    expect(findConv(groupId).participants[0]!.encryptedProfile).toBe('OLD-GROUP')
  })

  it('grup v2: participant pseudonym diperbarui tanpa menimpa id pseudonym', async () => {
    pseudonymMaps.set(groupId, { 'pseudo-peer': 'peer' })

    useConversationStore.getState().updateParticipantDetails({ id: asUserId('peer'), encryptedProfile: 'NEW-GROUP' })
    await flushAsync()

    const member = findConv(groupId).participants[0]!
    expect(member.id).toBe('pseudo-peer') // pseudonym TIDAK diganti userId asli
    expect(member.encryptedProfile).toBe('NEW-GROUP')
    expect(decryptAndCacheMock).toHaveBeenCalledWith('peer', 'NEW-GROUP')
  })

  it('user di luar conversation mana pun → tidak ada perubahan / persist', async () => {
    useConversationStore.getState().updateParticipantDetails({ id: asUserId('stranger'), encryptedProfile: 'NEW-X' })
    await flushAsync()

    expect(findConv(directId).participants[1]!.encryptedProfile).toBe('OLD-DIRECT')
    expect(saveConversationMock).not.toHaveBeenCalled()
    expect(decryptAndCacheMock).not.toHaveBeenCalled()
  })
})
