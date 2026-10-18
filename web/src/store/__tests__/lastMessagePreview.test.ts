// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi: preview baris terakhir di daftar percakapan.
 *
 * Gejala yang dilaporkan:
 *  1. Preview kadang bukan pesan terakhir yang sebenarnya (flaky).
 *  2. Begitu ada pesan sistem silent yang tidak muncul di UI, preview berubah
 *     menjadi "belum ada pesan" padahal riwayatnya ada.
 *
 * Akar masalah yang dikunci di sini:
 *  • `updateConversationLastMessage` dulu menerima SEMUA pesan, termasuk
 *    pesan kontrol (`CALL_INIT`, `GHOST_SYNC`, `PROFILE_SYNC`, `UNSEND`, …)
 *    yang preview-nya kosong → `lastMessage` tertimpa kosong.
 *  • Pesan yang tiba sebelum percakapannya ada di store dibuang diam-diam
 *    (preview hilang sampai sync berikutnya) — sumber gejala "kadang".
 *
 * Pola mock mengikuti unreadCount.test.ts (graph store diringankan).
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
vi.mock('@lib/shadowVaultDb', () => ({
  shadowVault: {
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getMessagesByConversation: vi.fn().mockResolvedValue([]),
  },
}))

import { useConversationStore } from '../conversation'
import { asConversationId, asMessageId, asUserId } from '@nyx/shared'
import type { Conversation, Message } from '@nyx/shared'

const convId = asConversationId('conv-preview')
const { shadowVault } = await import('@lib/shadowVaultDb')

function findConv(): Conversation {
  return useConversationStore.getState().conversations.find(c => c.id === convId)!
}

function makeMessage(id: string, content: string, seq: number, senderId = 'peer'): Message {
  return {
    id: asMessageId(id),
    conversationId: convId,
    senderId: asUserId(senderId),
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, seq)).toISOString(),
    seq,
    content,
    reactions: [],
  } as Message
}

function controlPayload(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra })
}

describe('preview daftar chat — pesan kontrol tidak boleh menimpanya', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [{
        id: convId,
        isGroup: false,
        participants: [
          { id: asUserId('me'), role: 'MEMBER' },
          { id: asUserId('peer'), role: 'MEMBER' },
        ],
        lastMessage: null,
        unreadCount: 0,
      }],
      activeId: null,
    } as never)
  })

  it('pesan nyata mengisi preview', () => {
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('real', 'halo', 1))
    expect(findConv().lastMessage?.preview).toBe('halo')
    expect(findConv().unreadCount).toBe(1)
  })

  it('CALL_INIT / GHOST_SYNC setelah pesan nyata → preview TIDAK dikosongkan, unread tidak naik', () => {
    // Id unik per test: watermark anti re-count bersifat per sesi modul.
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('real-2', 'halo', 10))

    useConversationStore.getState().updateConversationLastMessage(
      convId,
      makeMessage('call', controlPayload('CALL_INIT', { key: 'k' }), 11),
    )
    useConversationStore.getState().updateConversationLastMessage(
      convId,
      makeMessage('ghost', controlPayload('GHOST_SYNC'), 12),
    )

    const conv = findConv()
    expect(conv.lastMessage?.id).toBe('real-2')
    expect(conv.lastMessage?.preview).toBe('halo')
    expect(conv.unreadCount).toBe(1) // hanya pesan nyata yang dihitung
  })

  it('PROFILE_SYNC tidak membocorkan payload JSON ke daftar chat', () => {
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('real', 'halo', 1))
    useConversationStore.getState().updateConversationLastMessage(
      convId,
      makeMessage('profile', controlPayload('PROFILE_SYNC', { profileKey: 'RAHASIA' }), 2),
    )

    const conv = findConv()
    expect(conv.lastMessage?.id).toBe('real')
    expect(JSON.stringify(conv.lastMessage)).not.toContain('RAHASIA')
  })

  it('UNSEND atas pesan preview → preview dihitung ulang lewat force (bukan payload kontrol)', () => {
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('real', 'halo', 1))
    // UNSEND datang sebagai payload kontrol: tidak menyentuh preview sama sekali.
    useConversationStore.getState().updateConversationLastMessage(
      convId,
      makeMessage('unsend', controlPayload('UNSEND', { targetMessageId: 'real' }), 2),
    )
    expect(findConv().lastMessage?.id).toBe('real')

    // Pemanggil (messageStore.removeMessage/updateMessage) yang memutuskan
    // penggantinya — di sini disimulasikan dengan force.
    useConversationStore.getState().forceConversationLastMessage(convId, null)
    expect(findConv().lastMessage).toBeNull()
  })

  it('forceConversationLastMessage menolak pesan kontrol (tidak pernah jadi preview)', () => {
    useConversationStore.getState().forceConversationLastMessage(
      convId,
      makeMessage('ghost', controlPayload('GHOST_SYNC'), 5),
    )
    expect(findConv().lastMessage).toBeNull()
  })

  it('pesan "silent" bertipe teks tetap menjadi preview (memang terlihat)', () => {
    useConversationStore.getState().updateConversationLastMessage(
      convId,
      makeMessage('silent-text', controlPayload('silent', { text: 'psst' }), 1),
    )
    expect(findConv().lastMessage?.preview).toBe('psst')
  })
})

describe('preview daftar chat — pesan yang tiba sebelum percakapannya ada', () => {
  beforeEach(() => {
    useConversationStore.setState({ conversations: [], activeId: null } as never)
  })

  it('preview disimpan dan dipakai saat conversation:new tiba (tidak hilang sampai sync)', async () => {
    const incoming = makeMessage('first', 'pesan pertama', 1)

    // Pesan tiba lebih dulu: percakapan belum ada di store.
    useConversationStore.getState().updateConversationLastMessage(convId, incoming)
    expect(useConversationStore.getState().conversations).toHaveLength(0)

    // Lalu server mengirim conversation:new tanpa lastMessage.
    void useConversationStore.getState().addOrUpdateConversation({
      id: convId,
      isGroup: false,
      participants: [
        { id: asUserId('me'), role: 'MEMBER' },
        { id: asUserId('peer'), role: 'MEMBER' },
      ],
      lastMessage: null,
      unreadCount: 0,
    } as unknown as Conversation)

    const conv = useConversationStore.getState().conversations.find(c => c.id === convId)!
    expect(conv.lastMessage?.id).toBe('first')
    expect(conv.lastMessage?.preview).toBe('pesan pertama')
    // Persistensi ke vault berjalan async (fire-and-forget).
    await vi.waitFor(() => expect(shadowVault.saveConversation).toHaveBeenCalled())
  })
})
