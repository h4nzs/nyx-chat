import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMessageStore } from '../message';

// [ROBUSTNESS] Guard re-entrancy processOfflineQueue: dua pemanggil yang
// overlap tidak boleh memproses item queue yang sama (pesan dobel). Harness
// mengikuti pola sendMessageWatchdog.test.ts; sendEvent TIDAK langsung ACK —
// callback ditahan agar drain bisa digantung di tengah dan pemanggil kedua
// benar-benar overlap.

const convId = 'conv1';

vi.mock('@utils/crypto', () => ({
  encryptMessage: vi.fn().mockResolvedValue({ ciphertext: 'ct', mk: undefined }),
  decryptMessage: vi.fn().mockResolvedValue({ content: 'plain' }),
  retrieveMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  storeMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  deleteMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  getMyEncryptionKeyPair: vi.fn().mockResolvedValue({ publicKey: new Uint8Array() }),
  ensureGroupSession: vi.fn().mockResolvedValue(undefined),
  establishSessionFromPreKeyBundle: vi.fn().mockResolvedValue(undefined),
  deriveSessionKeyAsRecipient: vi.fn().mockResolvedValue(undefined),
  storeRatchetStateSecurely: vi.fn().mockResolvedValue(undefined),
  retrieveRatchetStateSecurely: vi.fn().mockResolvedValue(undefined),
  getPseudonymMap: vi.fn(() => undefined),
  getMyPseudonym: vi.fn().mockResolvedValue(undefined),
  // [docs/28 Tier 4] jalur kirim memakai versi hydrate (peta dari metadata).
  ensureMyPseudonym: vi.fn().mockResolvedValue(undefined),
  resolveSenderIdentityForGroup: vi.fn().mockResolvedValue(undefined),
  PreKeyBundle: class {},
}));

vi.mock('@utils/feedback', () => ({ captureAndLog: vi.fn() }));

vi.mock('@lib/groupPseudonyms', () => ({
  isEphemeralReceipts: vi.fn(() => false),
  scheduleEphemeralReceipt: vi.fn(),
  RECEIPT_JITTER_MAX_MS: 1000,
  getDeliveryTokenMap: vi.fn(() => undefined),
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

vi.mock('../connection', () => ({ useConnectionStore: { getState: () => ({}) } }));
vi.mock('../keychain', () => ({ useKeychainStore: { getState: () => ({}) } }));

vi.mock('@lib/keychainDb', () => ({
  getProfileKey: vi.fn().mockResolvedValue(undefined),
  storeMessageKeySecurely: vi.fn().mockResolvedValue(undefined),
  getGroupSenderState: vi.fn().mockResolvedValue(null),
  saveGroupSenderState: vi.fn().mockResolvedValue(undefined),
  getCachedGroupParticipants: vi.fn().mockResolvedValue(undefined),
}));

// sendEvent: callback ACK ditahan (tidak dipanggil) sampai test melepasnya,
// sehingga drain menggantung di tengah dan pemanggil kedua bisa overlap.
const ackCallbacks: Array<(err: unknown, res: unknown) => void> = [];
const sendEventMock = vi.fn((_e: string, _d: unknown, cb: (err: unknown, res: unknown) => void) => {
  ackCallbacks.push(cb);
});
vi.mock('@lib/transportClient', () => ({
  transportClient: {
    connected: true,
    sendEvent: (...a: unknown[]) => sendEventMock(...(a as [string, unknown, (err: unknown, res: unknown) => void])),
    timeout: vi.fn(() => ({ emit: vi.fn() })),
    emitSessionKeyRequest: vi.fn(),
    emitGroupKeyDistribution: vi.fn().mockResolvedValue(undefined),
  },
  emitSessionKeyRequest: vi.fn(),
  emitGroupKeyDistribution: vi.fn().mockResolvedValue(undefined),
}));

type QueueItem = { tempId: number; conversationId: string; data: Record<string, unknown>; timestamp: number; attempt: number };
let queue: QueueItem[] = [];
const getQueueItems = vi.fn(async () => [...queue]);
const removeFromQueue = vi.fn(async (tempId: number) => {
  queue = queue.filter((q) => q.tempId !== tempId);
});
const updateQueueAttempt = vi.fn(async (_tempId: number, _attempt: number) => {});
vi.mock('@lib/offlineQueueDb', () => ({
  addToQueue: vi.fn(),
  getQueueItems: () => getQueueItems(),
  removeFromQueue: (tempId: number) => removeFromQueue(tempId),
  updateQueueAttempt: (tempId: number, attempt: number) => updateQueueAttempt(tempId, attempt),
}));

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string, d: string) => d } }));
vi.mock('@lib/messagePipeline', () => ({
  decryptMessageObject: vi.fn(),
  evaluateControlMessage: vi.fn(),
  createRepliedToForStoryReply: vi.fn(),
}));
vi.mock('@lib/api', () => ({ api: vi.fn(), authFetch: vi.fn() }));
vi.mock('@lib/shadowVaultDb', () => ({
  shadowVault: {
    upsertMessages: vi.fn().mockResolvedValue(undefined),
    getMessage: vi.fn().mockResolvedValue(null),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  },
  saveStoryKey: vi.fn(),
}));

const mkItem = (tempId: number): QueueItem => ({
  tempId,
  conversationId: convId,
  data: { content: `halo-${tempId}` },
  timestamp: tempId,
  attempt: 0,
});

const mkOptimistic = (tempId: number) => ({
  id: `temp_${tempId}`,
  tempId,
  conversationId: convId,
  senderId: 'u1',
  content: `halo-${tempId}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'SENDING',
  optimistic: true,
  reactions: [],
});

const okAck = (tempId: number) => ({
  ok: true,
  msg: {
    id: `srv-${tempId}`,
    tempId,
    conversationId: convId,
    senderId: 'u1',
    content: `halo-${tempId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
});

describe('processOfflineQueue re-entrancy guard (ROBUSTNESS)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queue = [];
    ackCallbacks.length = 0;
    getQueueItems.mockClear();
    removeFromQueue.mockClear();
    updateQueueAttempt.mockClear();
    sendEventMock.mockClear();
    useMessageStore.setState({ messages: { [convId]: [mkOptimistic(1), mkOptimistic(2)] } } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pemanggil kedua saat drain berjalan tidak mengirim ulang item yang sama; rerun meng-drain item baru', async () => {
    queue = [mkItem(1)];

    // Drain pertama berjalan dan menggantung menunggu ACK item 1.
    const p1 = useMessageStore.getState().processOfflineQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendEventMock).toHaveBeenCalledTimes(1);
    expect(ackCallbacks.length).toBe(1);

    // Pemanggil kedua (overlap) → hanya menandai rerun, TIDAK mengirim ulang.
    await useMessageStore.getState().processOfflineQueue();
    expect(sendEventMock).toHaveBeenCalledTimes(1);

    // Item baru masuk ke queue SELAMA drain masih berjalan.
    queue.push(mkItem(2));

    // ACK item 1 → drain selesai → rerun fire-and-forget mengambil item 2.
    ackCallbacks[0]!(null, okAck(1));
    await vi.advanceTimersByTimeAsync(150);
    await p1;

    expect(removeFromQueue).toHaveBeenCalledWith(1);
    expect(sendEventMock).toHaveBeenCalledTimes(2);
    expect(ackCallbacks.length).toBe(2);

    // Selesaikan item 2 agar rerun tidak menggantung.
    ackCallbacks[1]!(null, okAck(2));
    await vi.advanceTimersByTimeAsync(150);
    expect(removeFromQueue).toHaveBeenCalledWith(2);

    // Tidak ada pemrosesan ganda: item 1 dan 2 masing-masing dikirim SEKALI.
    const sentTempIds = sendEventMock.mock.calls.map((c) => (c[1] as { tempId: number }).tempId);
    expect(sentTempIds).toEqual([1, 2]);
    // Queue dikosongkan; tidak ada sisa item yang tak terproses.
    expect(queue).toHaveLength(0);
  });

  it('pemanggil kedua tanpa item baru tetap aman (rerun no-op, tanpa kirim ulang)', async () => {
    queue = [mkItem(1)];

    const p1 = useMessageStore.getState().processOfflineQueue();
    await vi.advanceTimersByTimeAsync(0);
    await useMessageStore.getState().processOfflineQueue(); // overlap, tanpa item baru

    ackCallbacks[0]!(null, okAck(1));
    await vi.advanceTimersByTimeAsync(300);
    await p1;

    expect(sendEventMock).toHaveBeenCalledTimes(1);
    expect(removeFromQueue).toHaveBeenCalledTimes(1);
    expect(removeFromQueue).toHaveBeenCalledWith(1);
  });
});
