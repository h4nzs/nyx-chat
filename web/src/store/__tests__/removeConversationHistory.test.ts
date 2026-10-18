// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] Kick ≠ hapus permanen.
 *
 * Server mengirim `conversation:deleted` dengan `reason: 'removed'` saat anggota
 * dikeluarkan. Klien dulu selalu memanggil `deleteConversation()` yang menghapus
 * pesan di ShadowVault + SEMUA group receiver state/arsip; setelah anggota
 * di-add kembali, pesan lama di-fetch ulang tanpa kunci era → "waiting_for_key"
 * (kecuali yang message-key-nya sempat di-cache).
 *
 * Kontrak:
 *  1. `preserveHistory` → pesan + kunci dipertahankan; hanya record percakapan
 *     yang dilepas (`forgetConversation`).
 *  2. Tanpa opsi (hapus lokal / burner) → perilaku lama (hapus pesan + kunci).
 *  3. Percakapan hilang dari state di kedua kasus.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { clearMessagesForConversation, deleteConversation, forgetConversation, deleteConversationMessages } = vi.hoisted(() => ({
  clearMessagesForConversation: vi.fn(),
  deleteConversation: vi.fn().mockResolvedValue(undefined),
  forgetConversation: vi.fn().mockResolvedValue(undefined),
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@utils/crypto', () => ({
  encryptMessage: vi.fn().mockResolvedValue({ ciphertext: 'ct', mk: undefined }),
  encryptGroupMetadata: vi.fn().mockResolvedValue('meta'),
  decryptGroupMetadata: vi.fn().mockResolvedValue(null),
  forceRotateGroupSenderKey: vi.fn().mockResolvedValue(undefined),
  ensureGroupSession: vi.fn().mockResolvedValue(undefined),
  checkAndRefillOneTimePreKeys: vi.fn(),
  generatePseudonymMap: vi.fn().mockResolvedValue({}),
  getPseudonymMap: vi.fn().mockReturnValue(undefined),
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
vi.mock('@store/message', () => ({
  useMessageStore: { getState: () => ({ clearMessagesForConversation }) },
}))
vi.mock('@lib/shadowVaultDb', () => ({
  shadowVault: { deleteConversation, forgetConversation, deleteConversationMessages },
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
import { asConversationId } from '@nyx/shared'

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('removeConversation — riwayat bertahan saat dikeluarkan dari grup', () => {
  beforeEach(() => {
    clearMessagesForConversation.mockReset()
    deleteConversation.mockClear()
    forgetConversation.mockClear()
    useConversationStore.setState({
      conversations: [
        { id: asConversationId('group-1'), isGroup: true, participants: [] },
        { id: asConversationId('direct-1'), isGroup: false, participants: [] },
      ],
      activeId: null,
    } as never)
  })

  it("preserveHistory: hanya record percakapan dilepas, vault + kunci era TETAP", async () => {
    useConversationStore.getState().removeConversation('group-1', { preserveHistory: true })
    await flushAsync()

    expect(clearMessagesForConversation).toHaveBeenCalledWith('group-1', { preserveVault: true })
    expect(forgetConversation).toHaveBeenCalledWith('group-1')
    expect(deleteConversation).not.toHaveBeenCalled()

    const ids = useConversationStore.getState().conversations.map(c => String(c.id))
    expect(ids).toEqual(['direct-1'])
  })

  it('tanpa opsi: hapus lokal seperti biasa (pesan + kunci dibuang)', async () => {
    useConversationStore.getState().removeConversation('direct-1')
    await flushAsync()

    expect(clearMessagesForConversation).toHaveBeenCalledWith('direct-1', { preserveVault: false })
    expect(deleteConversation).toHaveBeenCalledWith('direct-1')
    expect(forgetConversation).not.toHaveBeenCalled()
  })
})
