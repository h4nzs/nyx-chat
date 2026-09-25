import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks follow the pattern in socketSync.test.ts, extended to capture the
// transportClient 'connect' handler so we can exercise the offline-sync poll
// and its one-shot delayed retry (FIX 2).

const loadMessagesForConversation = vi.fn()
const processOfflineQueue = vi.fn()
let conversations: unknown[] = []

const connectHandlers: Array<() => void> = []
const transportClientOn = vi.fn((event: string, cb: () => void) => {
  if (event === 'connect') connectHandlers.push(cb)
})

vi.mock('../transportClient', () => ({
  transportClient: { on: transportClientOn, sendEvent: vi.fn() },
  emitSessionKeyRequest: vi.fn(),
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
