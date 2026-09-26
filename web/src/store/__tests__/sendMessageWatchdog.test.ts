import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMessageStore } from '../message';

const convId = 'conv1';

vi.mock('@utils/crypto', () => ({
  encryptMessage: vi.fn().mockResolvedValue({ ciphertext: 'ct', mk: undefined }),
  storeMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  getMyEncryptionKeyPair: vi.fn().mockResolvedValue({ publicKey: new Uint8Array() }),
  ensureGroupSession: vi.fn().mockResolvedValue(undefined),
  establishSessionFromPreKeyBundle: vi.fn().mockResolvedValue(undefined),
  deriveSessionKeyAsRecipient: vi.fn().mockResolvedValue(undefined),
  storeRatchetStateSecurely: vi.fn().mockResolvedValue(undefined),
  retrieveRatchetStateSecurely: vi.fn().mockResolvedValue(undefined),
  PreKeyBundle: class {},
}));

vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn().mockResolvedValue({
    from_base64: () => new Uint8Array(8),
    to_base64: () => 'x',
    base64_variants: { URLSAFE_NO_PADDING: 0, ORIGINAL: 1, URLSAFE: 2 },
  }),
}));

vi.mock('@lib/crypto-worker-proxy', () => ({
  worker_crypto_box_seal: vi.fn().mockResolvedValue(new Uint8Array(8)),
  worker_crypto_secretbox_xchacha20poly1305_open_easy: vi.fn().mockResolvedValue(new Uint8Array(8)),
}));

vi.mock('../profile', () => ({
  useProfileStore: { getState: () => ({ decryptAndCache: vi.fn().mockResolvedValue(null), profiles: {} }) },
}));

vi.mock('../conversation', () => ({
  useConversationStore: {
    getState: () => ({
      conversations: [{ id: convId, participants: [{ userId: 'u1', id: 'u1' }], isGroup: false }],
      updateConversationLastMessage: vi.fn(),
      markKeyRotationNeeded: vi.fn(),
    }),
  },
}));

vi.mock('../auth', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1', encryptedProfile: undefined }, hasRestoredKeys: true }) },
}));

vi.mock('../dynamicIsland', () => ({
  default: { getState: () => ({}) },
  UploadActivity: class {},
}));

vi.mock('../connection', () => ({
  useConnectionStore: { getState: () => ({}) },
}));

vi.mock('../keychain', () => ({
  useKeychainStore: { getState: () => ({}) },
}));

vi.mock('@lib/keychainDb', () => ({
  getProfileKey: vi.fn().mockResolvedValue(undefined),
  storeMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  getGroupSenderState: vi.fn().mockResolvedValue(null),
  saveGroupSenderState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@lib/transportClient', () => {
  let captured: ((err: any, res: any) => void) | null = null;
  return {
    transportClient: {
      connected: true,
      // emit callback SENGAJA tidak pernah dipanggil -> mensimulasikan
      // "callback tidak pernah fire" (transport mati di tengah pengiriman).
      timeout: (_ms: number) => ({
        emit: (_e: string, _d: unknown, cb: (err: any, res: any) => void) => {
          captured = cb;
        },
      }),
      emitSessionKeyRequest: vi.fn(),
      emitGroupKeyDistribution: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn(),
    },
    __getCaptured: () => captured,
  };
});

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string, d: string) => d } }));
vi.mock('@lib/messagePipeline', () => ({
  decryptMessageObject: vi.fn(),
  evaluateControlMessage: vi.fn(),
  createRepliedToForStoryReply: vi.fn(),
}));
vi.mock('@lib/offlineQueueDb', () => ({
  addToQueue: vi.fn(),
  getQueueItems: vi.fn().mockResolvedValue([]),
  removeFromQueue: vi.fn(),
  updateQueueAttempt: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@lib/api', () => ({ api: vi.fn(), authFetch: vi.fn() }));
vi.mock('@lib/shadowVaultDb', () => ({ shadowVault: { upsertMessages: vi.fn() }, saveStoryKey: vi.fn() }));

describe('Optimistic send terminal-state guarantee (H1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useMessageStore.setState({ messages: { [convId]: [] } } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bubble optimistik berubah ke FAILED bila callback emit tidak pernah fire', async () => {
    await useMessageStore.getState().sendMessage(convId, { content: 'hello' });

    const msgs = useMessageStore.getState().messages[convId] || [];
    const opt = msgs.find((m) => m.optimistic);
    expect(opt).toBeTruthy();
    expect(opt!.status).toBe('SENDING'); // prasyarat: awalnya menggantung

    // Maju melewati jendela watchdog (20s). Callback emit tidak pernah fire,
    // sehingga sabuk-dan-gesper harus memaksa status -> FAILED.
    await vi.advanceTimersByTimeAsync(21000);

    const after = (useMessageStore.getState().messages[convId] || []).find(
      (m) => m.id === opt!.id
    );
    expect(after).toBeTruthy();
    expect(after!.status).toBe('FAILED');
    expect((after as any).error).toBe(true);
  });
});
