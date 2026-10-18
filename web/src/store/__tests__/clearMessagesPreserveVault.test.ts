// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [BUGFIX 2026-10-18] `clearMessagesForConversation` dengan `preserveVault`.
 *
 * Saat anggota dikeluarkan dari grup, pesan di ShadowVault dan kunci grup per
 * era TIDAK boleh dihapus — kalau tidak, riwayat yang di-fetch ulang setelah
 * anggota di-add kembali tidak bisa didekripsi ("waiting_for_key"). Hapus lokal
 * biasa (tanpa opsi) tetap membersihkan keduanya.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { deleteConversationMessages, deleteConversationKeychain } = vi.hoisted(() => ({
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
  deleteConversationKeychain: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@lib/shadowVaultDb', () => ({
  shadowVault: {
    deleteConversationMessages,
    upsertMessages: vi.fn().mockResolvedValue(undefined),
    getMessagesByConversation: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue(undefined),
  },
  saveStoryKey: vi.fn(),
}))

vi.mock('@utils/crypto', () => ({
  encryptMessage: vi.fn().mockResolvedValue({ ciphertext: 'ct', mk: undefined }),
  deleteConversationKeychain,
  storeMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  getMyEncryptionKeyPair: vi.fn().mockResolvedValue({ publicKey: new Uint8Array() }),
  retrieveMessageKeySecurely: vi.fn().mockResolvedValue(null),
  ensureGroupSession: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn().mockResolvedValue({
    from_base64: () => new Uint8Array(8),
    to_base64: () => 'x',
    base64_variants: { URLSAFE_NO_PADDING: 0, ORIGINAL: 1, URLSAFE: 2 },
  }),
}))
vi.mock('@lib/crypto-worker-proxy', () => ({}))
vi.mock('../profile', () => ({
  useProfileStore: { getState: () => ({ decryptAndCache: vi.fn(), profiles: {} }) },
}))
vi.mock('../conversation', () => ({
  useConversationStore: {
    getState: () => ({ conversations: [], updateConversationLastMessage: vi.fn(), markKeyRotationNeeded: vi.fn() }),
  },
}))
vi.mock('../auth', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' }, hasRestoredKeys: true }) },
}))
vi.mock('../dynamicIsland', () => ({ default: { getState: () => ({}) }, UploadActivity: class {} }))
vi.mock('../connection', () => ({ useConnectionStore: { getState: () => ({}) } }))
vi.mock('../keychain', () => ({ useKeychainStore: { getState: () => ({}) } }))
vi.mock('@lib/keychainDb', () => ({
  getProfileKey: vi.fn().mockResolvedValue(undefined),
  getGroupSenderState: vi.fn().mockResolvedValue(null),
  saveGroupSenderState: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@lib/transportClient', () => ({
  transportClient: { connected: false, sendEvent: vi.fn(), emit: vi.fn(), timeout: vi.fn() },
  emitSessionKeyRequest: vi.fn(),
  emitGroupKeyDistribution: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }))
vi.mock('../../i18n', () => ({ default: { t: (k: string, d: string) => d } }))

import { useMessageStore } from '../message'

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('clearMessagesForConversation — preserveVault (kick)', () => {
  beforeEach(() => {
    deleteConversationMessages.mockClear()
    deleteConversationKeychain.mockClear()
    useMessageStore.setState({
      messages: { g1: [{ id: 'm1', conversationId: 'g1' } as never] },
    })
  })

  it('preserveVault: state in-memory dibersihkan, vault + kunci TIDAK disentuh', async () => {
    useMessageStore.getState().clearMessagesForConversation('g1', { preserveVault: true })
    await flushAsync()

    expect(useMessageStore.getState().messages['g1']).toBeUndefined()
    expect(deleteConversationMessages).not.toHaveBeenCalled()
    expect(deleteConversationKeychain).not.toHaveBeenCalled()
  })

  it('tanpa opsi: vault + keychain ikut dihapus (hapus lokal biasa)', async () => {
    useMessageStore.getState().clearMessagesForConversation('g1')
    await flushAsync()

    expect(useMessageStore.getState().messages['g1']).toBeUndefined()
    expect(deleteConversationMessages).toHaveBeenCalledWith('g1')
    expect(deleteConversationKeychain).toHaveBeenCalledWith('g1')
  })
})
