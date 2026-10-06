import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks follow the pattern in socketSync.test.ts, extended to capture the
// transportClient 'connect' handler so we can exercise the offline-sync poll
// and its one-shot delayed retry (FIX 2).

const loadMessagesForConversation = vi.fn()
const processOfflineQueue = vi.fn()
let conversations: unknown[] = []

const connectHandlers: Array<() => void> = []
const disconnectHandlers: Array<(reason?: string) => void> = []
const burnerHandlers: Array<(payload: { roomId?: string; ciphertext: string }) => Promise<void> | void> = []
const transportClientOn = vi.fn((event: string, cb: (arg?: unknown) => void) => {
  if (event === 'connect') connectHandlers.push(cb as () => void)
  else if (event === 'disconnect') disconnectHandlers.push(cb as (reason?: string) => void)
  else if (event === 'burner:receive')
    burnerHandlers.push(cb as (payload: { roomId?: string; ciphertext: string }) => Promise<void> | void)
})

vi.mock('../transportClient', () => ({
  transportClient: { on: transportClientOn, sendEvent: vi.fn() },
  emitSessionKeyRequest: vi.fn(),
}))

// Burner store di-mock agar test routing burner:receive tidak memuat modul asli.
// CATATAN PATH: file test ini ada di src/lib/__tests__/, jadi path mock relatif
// di-resolve DARI FOLDER INI — '../../store/burner' → src/store/burner (target
// yang benar; '../store/burner' menunjuk src/lib/store/burner yang tidak ada).
let burnerActiveSessions: Record<string, unknown> = {}
const burnerReceiveMessage = vi.fn()
vi.mock('../../store/burner', () => ({
  useBurnerStore: {
    getState: () => ({ activeSessions: burnerActiveSessions, receiveMessage: burnerReceiveMessage }),
  },
}))
vi.mock('@store/message', () => ({
  useMessageStore: { getState: () => ({ loadMessagesForConversation, processOfflineQueue }) },
}))
vi.mock('@store/conversation', () => ({
  useConversationStore: { getState: () => ({ conversations }), subscribe: () => () => {} },
}))
vi.mock('@store/auth', () => ({ useAuthStore: { getState: () => ({}) } }))
vi.mock('@store/connection', () => ({
  useConnectionStore: { getState: () => ({ setStatus: vi.fn() }) },
}))
vi.mock('@store/presence', () => ({ usePresenceStore: { getState: () => ({}) } }))

beforeEach(() => {
  // Fresh module instance per test so the isInitialized guard resets.
  vi.resetModules()
  loadMessagesForConversation.mockReset()
  processOfflineQueue.mockReset()
  conversations = []
  connectHandlers.length = 0
  disconnectHandlers.length = 0
  burnerHandlers.length = 0
  burnerActiveSessions = {}
  burnerReceiveMessage.mockReset()
  vi.useFakeTimers()
})

async function loadModule() {
  const mod = await import('../socketListeners')
  mod.resetSocketSyncForTests()
  return mod
}

describe('socketListeners offline sync retry (FIX 2)', () => {
  it('schedules a single delayed retry after 8 failed polls, then syncs when conversations arrive', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    connectHandlers.forEach((h) => h())

    // 8×500ms polling windows all find an empty conversation list → no sync yet.
    await vi.advanceTimersByTimeAsync(300 + 8 * 500) // 4300ms
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // Conversations arrive; the 15s one-shot retry should now perform the sync.
    conversations = [{ id: 'c1', isGroup: false }]
    await vi.advanceTimersByTimeAsync(15000)
    expect(loadMessagesForConversation).toHaveBeenCalledWith('c1')
  })

  it('does not loop infinitely after the bounded backoff retries also fail', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    connectHandlers.forEach((h) => h())

    // Exhaust normal polling (schedules the 15s retry).
    await vi.advanceTimersByTimeAsync(300 + 8 * 500) // 4300ms
    // Backoff retries fire at 15s, 30s, 60s with still-empty conversations.
    // None may sync, and after the last one there must be NO further attempts.
    await vi.advanceTimersByTimeAsync(15000 + 30000 + 60000) // all 3 retries
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // Beyond the bounded backoff (15+30+60s), no further sync attempt.
    await vi.advanceTimersByTimeAsync(120000)
    expect(loadMessagesForConversation).not.toHaveBeenCalled()
  })

  it('supersedes the pending retry when a real sync starts first', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    connectHandlers.forEach((h) => h())

    // Exhaust polling → schedules 15s retry.
    await vi.advanceTimersByTimeAsync(300 + 8 * 500) // 4300ms
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // A real sync starts (e.g. via the Zustand subscription) before the retry fires.
    conversations = [{ id: 'c2', isGroup: false }]
    await socketListeners.doSyncMessages()
    expect(loadMessagesForConversation).toHaveBeenCalledWith('c2')

    // The pending retry must be cleared, so advancing 15s does nothing further.
    await vi.advanceTimersByTimeAsync(15000)
    expect(loadMessagesForConversation).toHaveBeenCalledTimes(1)
  })

  it('uses escalating backoff 15s → 30s → 60s when conversations stay empty (FIX 4)', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    connectHandlers.forEach((h) => h())

    // Exhaust normal polling.
    await vi.advanceTimersByTimeAsync(300 + 8 * 500) // 4300ms
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // At exactly 15s: first backoff retry fires → schedules 30s.
    await vi.advanceTimersByTimeAsync(15000)
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // At exactly 30s more: second retry fires → schedules 60s.
    await vi.advanceTimersByTimeAsync(30000)
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // At exactly 60s more: third (final) retry fires.
    await vi.advanceTimersByTimeAsync(60000)
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // Nothing beyond the 3 bounded retries.
    await vi.advanceTimersByTimeAsync(120000)
    expect(loadMessagesForConversation).not.toHaveBeenCalled()
  })
})

describe('doSyncMessages failure retry (FIX 3)', () => {
  it('does NOT set syncCompleted when a conversation sync fails, and retries once after 5s', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()

    conversations = [{ id: 'c1', isGroup: false }, { id: 'c2', isGroup: false }]
    // First call for c1 fails; c2 succeeds.
    loadMessagesForConversation.mockImplementation((id: string) => {
      if (id === 'c1') return Promise.reject(new Error('network glitch'))
      return Promise.resolve()
    })

    await socketListeners.doSyncMessages()
    expect(loadMessagesForConversation).toHaveBeenCalledTimes(2)

    // syncCompleted must stay false so future polls/subscriptions can retry.
    expect(socketListeners.syncCompleted).toBe(false)

    // The one-shot failure retry (5s) re-runs doSyncMessages.
    loadMessagesForConversation.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(5000)
    expect(loadMessagesForConversation).toHaveBeenCalledWith('c1')
    expect(loadMessagesForConversation).toHaveBeenCalledWith('c2')

    // Now the full sync succeeded → syncCompleted flips true, no more retries.
    expect(socketListeners.syncCompleted).toBe(true)
    const callsAfterFirstRetry = loadMessagesForConversation.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(loadMessagesForConversation.mock.calls.length).toBe(callsAfterFirstRetry)
  })

  it('sets syncCompleted when all conversations sync successfully (no failure retry)', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()

    conversations = [{ id: 'c1', isGroup: false }]
    loadMessagesForConversation.mockResolvedValue(undefined)

    await socketListeners.doSyncMessages()
    expect(socketListeners.syncCompleted).toBe(true)

    const calls = loadMessagesForConversation.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(loadMessagesForConversation.mock.calls.length).toBe(calls)
  })

  it('prevents overlapping syncs via the syncInProgress guard', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()

    conversations = [{ id: 'c1', isGroup: false }]
    let releaseFirst: () => void = () => {}
    loadMessagesForConversation.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirst = resolve })
    )

    const first = socketListeners.doSyncMessages()
    // Second call while the first loop is still awaiting must be a no-op.
    await socketListeners.doSyncMessages()
    releaseFirst()
    await first
    expect(loadMessagesForConversation).toHaveBeenCalledTimes(1)
  })
})

describe('socketListeners robustness (ROBUSTNESS 2026-10-06)', () => {
  it('mematikan poll chain koneksi lama saat disconnect, dan sync jalan lagi saat reconnect', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    connectHandlers.forEach((h) => h())

    // Disconnect di tengah polling (chain 300ms + 8×500ms masih hidup).
    disconnectHandlers.forEach((h) => h())
    conversations = [{ id: 'c1', isGroup: false }]
    await vi.advanceTimersByTimeAsync(60000)
    // Chain lama harus mati — tidak ada sync yang bocor dari koneksi sebelumnya.
    expect(loadMessagesForConversation).not.toHaveBeenCalled()

    // Reconnect → poll 300ms menemukan conversations → sync jalan.
    connectHandlers.forEach((h) => h())
    await vi.advanceTimersByTimeAsync(300)
    expect(loadMessagesForConversation).toHaveBeenCalledWith('c1')
  })

  it('membatasi failure retry 5s maksimal 3× per siklus koneksi (tidak loop selamanya)', async () => {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    connectHandlers.forEach((h) => h())
    conversations = [{ id: 'c1', isGroup: false }, { id: 'c2', isGroup: false }]
    loadMessagesForConversation.mockRejectedValue(new Error('server unreachable'))

    // Poll 300ms → sync gagal (2 calls) → retry 5s terjadwal.
    await vi.advanceTimersByTimeAsync(300)
    expect(loadMessagesForConversation).toHaveBeenCalledTimes(2)
    expect(socketListeners.syncCompleted).toBe(false)

    // Tiga retry berturut-turut: 5300, 10300, 15300.
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(loadMessagesForConversation).toHaveBeenCalledTimes(8)

    // Setelah batas 3 retry: tidak ada percobaan lagi walau waktu terus berjalan.
    await vi.advanceTimersByTimeAsync(120000)
    expect(loadMessagesForConversation).toHaveBeenCalledTimes(8)
  })
})

describe('burner:receive routing (ROBUSTNESS 2026-10-06)', () => {
  async function initAndGetHandler() {
    const socketListeners = await loadModule()
    socketListeners.initSocketListeners()
    return burnerHandlers[0]!
  }

  it('memakai roomId dari payload kapan pun tersedia', async () => {
    const handler = await initAndGetHandler()
    burnerActiveSessions = { a: {}, b: {} }

    await handler({ roomId: 'b', ciphertext: 'x' })

    expect(burnerReceiveMessage).toHaveBeenCalledWith('b', 'x')
  })

  it('fallback ke sesi pertama hanya bila tepat satu sesi aktif', async () => {
    const handler = await initAndGetHandler()
    burnerActiveSessions = { only: {} }

    await handler({ ciphertext: 'x' })

    expect(burnerReceiveMessage).toHaveBeenCalledWith('only', 'x')
  })

  it('drop pesan tanpa roomId saat routing ambigu (>1 sesi)', async () => {
    const handler = await initAndGetHandler()
    burnerActiveSessions = { a: {}, b: {} }

    await handler({ ciphertext: 'x' })

    expect(burnerReceiveMessage).not.toHaveBeenCalled()
  })

  it('drop pesan tanpa roomId saat tidak ada sesi aktif', async () => {
    const handler = await initAndGetHandler()

    await handler({ ciphertext: 'x' })

    expect(burnerReceiveMessage).not.toHaveBeenCalled()
  })
})
