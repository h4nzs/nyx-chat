// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi issue #98: "unread count keep reappearing".
 *
 * Kedua bug yang membuat badge unread salah (dobel / muncul kembali):
 *  1. Double increment — pemanggil ganda updateConversationLastMessage untuk
 *     pesan live yang sama (socketListeners DAN doAddIncomingMessage).
 *  2. Re-count pesan lama — pesan yang sudah dibaca di-emit ulang oleh
 *     re-delivery/sync race atau diedit (message:updated) → badge bertambah.
 *
 * Fix yang dikunci test ini: watermark in-memory per id pesan — satu pesan
 * hanya boleh menaikkan unreadCount sekali per sesi UI. (Reset setelah reload
 * tetap benar karena loadConversations memulai dari 0.)
 *
 * CATATAN PATH MOCK: file ini ada di src/store/__tests__/, jadi specifier
 * relatif mock menunjuk RELATIF TERHADAP FOLDER INI (bukan src/store/).
 * '../auth' dst. menunjuk module asli yang di-import conversation.ts;
 * '../../i18n' menunjuk src/i18n.ts. Specifier salah tidak pernah match dan
 * module asli (dengan side effect jaringan) ikut termuat — lihat commit
 * "repair dead vi.mock paths".
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
import { asConversationId, asMessageId, asUserId } from '@nyx/shared'

const convId = asConversationId('conv98')

function makeMessage(id: string, senderId: string, createdAt: string) {
  return {
    id: asMessageId(id),
    conversationId: convId,
    senderId: asUserId(senderId),
    createdAt,
    content: `msg-${id}`,
    isSilent: false,
    reactions: [],
  }
}

describe('updateConversationLastMessage anti re-count (issue #98)', () => {
  beforeEach(() => {
    // State bersih: satu percakapan, unread 0, belum ada lastMessage.
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

  it('pesan live baru menaikkan unread tepat +1', () => {
    const t1 = new Date('2026-01-01T10:00:00Z').toISOString()
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('m1', 'peer', t1))
    const conv = useConversationStore.getState().conversations.find(c => c.id === convId)!
    expect(conv.unreadCount).toBe(1)
  })

  it('panggilan ganda (socketListeners + doAddIncomingMessage) TIDAK menaikkan unread dua kali', () => {
    const t1 = new Date('2026-01-01T10:00:00Z').toISOString()
    const t2 = new Date('2026-01-01T10:00:01Z').toISOString()

    // Simulasi persis urutan pemanggilan nyata untuk satu pesan live:
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('dup1', 'peer', t1))
    // doAddIncomingMessage memanggil ulang dengan objek pesan hasil dekripsi
    // (createdAt sama/lebih baru) — dulu: +2; kini: tetap 1.
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('dup1', 'peer', t2))

    const conv = useConversationStore.getState().conversations.find(c => c.id === convId)!
    expect(conv.unreadCount).toBe(1)
  })

  it('pesan lama yang di-emit ulang (createdAt lebih tua dari lastMessage) tidak menaikkan unread dua kali', () => {
    const t1 = new Date('2026-01-01T10:00:00Z').toISOString()
    const t0 = new Date('2026-01-01T09:00:00Z').toISOString()

    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('re1', 'peer', t1))
    // Re-delivery pesan lama yang SUDAH pernah dihitung di sesi ini:
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('re1', 'peer', t0))
    const conv = useConversationStore.getState().conversations.find(c => c.id === convId)!
    expect(conv.unreadCount).toBe(1)
  })

  it('re-delivery pesan lama yang BELUM pernah dihitung tetap dihitung sekali (unread benar)', () => {
    // lastMessage sudah ada (lebih baru), lalu sync mengirim pesan LAMA yang
    // belum pernah masuk sesi ini — ini unread yang sah.
    const t2 = new Date('2026-01-01T10:00:02Z').toISOString()
    const t0 = new Date('2026-01-01T09:00:00Z').toISOString()
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('later2', 'peer', t2))
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('older2', 'peer', t0))

    const conv = useConversationStore.getState().conversations.find(c => c.id === convId)!
    expect(conv.unreadCount).toBe(2)
  })

  it('pesan milik sendiri tidak pernah menaikkan unread', () => {
    const t1 = new Date('2026-01-01T10:00:00Z').toISOString()
    useConversationStore.getState().updateConversationLastMessage(convId, makeMessage('mine2', 'me', t1))
    const conv = useConversationStore.getState().conversations.find(c => c.id === convId)!
    expect(conv.unreadCount).toBe(0)
  })
})
