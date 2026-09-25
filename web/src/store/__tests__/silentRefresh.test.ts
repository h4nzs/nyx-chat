import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'

// silentRefresh lives inside the auth zustand store, which statically imports a
// large graph (transportClient, message, keyStorage, crypto, nukeProtocol, i18n,
// prefetch, ...). To unit-test it we mock every static import so the store can be
// created in isolation; only the refresh-relevant helpers are given real behavior.

// --- refresh-relevant helpers (real-ish behavior) ---
const apiMock = vi.fn()
const runExclusiveMock = vi.fn(async (fn: () => Promise<unknown>) => fn())
const refreshWithRetryMock = vi.fn(async (refreshOnce: () => Promise<unknown>) => {
  const data = await refreshOnce()
  return data as { accessToken: string } | null
})

vi.mock('@lib/api', () => ({
  authFetch: vi.fn(),
  api: (...a: unknown[]) => (apiMock as (...args: unknown[]) => Promise<unknown>)(...a),
}))
vi.mock('@lib/refreshLock', () => ({
  runExclusive: (...a: unknown[]) => (runExclusiveMock as (...args: unknown[]) => Promise<unknown>)(...a),
}))
vi.mock('@lib/refreshRetry', () => ({
  refreshWithRetry: (...a: unknown[]) => (refreshWithRetryMock as (...args: unknown[]) => Promise<unknown>)(...a),
}))

// --- everything else: trivial no-op mocks so the store module loads ---
vi.mock('@lib/transportClient', () => ({ disconnectSocket: vi.fn(), connectSocket: vi.fn() }))
vi.mock('@lib/tokenStorage', () => ({ clearAuthCookies: vi.fn() }))
vi.mock('./modal', () => ({ useModalStore: { getState: () => ({}) } }))
vi.mock('./conversation', () => ({ useConversationStore: { getState: () => ({}) } }))
vi.mock('./message', () => ({ useMessageStore: { getState: () => ({}) } }))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }))
vi.mock('@lib/keyStorage', () => ({
  getEncryptedKeys: vi.fn(), saveEncryptedKeys: vi.fn(), clearKeys: vi.fn(),
  hasStoredKeys: vi.fn(), getDeviceAutoUnlockKey: vi.fn(), saveDeviceAutoUnlockKey: vi.fn(),
  setDeviceAutoUnlockReady: vi.fn(), setAutoUnlockIdentity: vi.fn(),
}))
vi.mock('@utils/fingerprint', () => ({ getBrowserFingerprint: vi.fn(async () => 'fp') }))
vi.mock('@utils/crypto', () => ({ checkAndRefillOneTimePreKeys: vi.fn(), resetOneTimePreKeys: vi.fn() }))
vi.mock('@lib/nukeProtocol', () => ({ executeLocalWipe: vi.fn() }))
vi.mock('../i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@lib/prefetch', () => ({ prefetchAppChunks: vi.fn() }))
// @nyx/shared MinimalUserSchema is imported for real (pure schema, no side effects).

// navigator.locks mock: acquire immediately and run the callback.
const lockRequest = vi.fn(async (_name: string, cb: () => Promise<unknown>) => cb())

beforeEach(() => {
  apiMock.mockReset()
  runExclusiveMock.mockClear()
  refreshWithRetryMock.mockClear()
  lockRequest.mockClear()
  ;(navigator as unknown as { locks: unknown }).locks = { request: lockRequest }
})

async function loadStore() {
  const mod = await import('../auth')
  // Reset store auth state between tests.
  mod.useAuthStore.setState({ accessToken: null, user: { id: 'u1' } as never })
  return mod
}

describe('silentRefresh cross-tab single-flight (FIX)', () => {
  it('second caller skips its own POST /refresh when the probe succeeds (session already refreshed)', async () => {
    const { useAuthStore } = await loadStore()

    // Model: first GET /api/users/me 401s (not yet refreshed); after a successful
    // POST /api/auth/refresh, subsequent GETs succeed (cookie rotated by other tab).
    let refreshed = false
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/api/users/me') {
        if (refreshed) return { id: 'u1' }
        throw new Error('401') // stand-in for ApiError 401
      }
      if (path === '/api/auth/refresh' && opts?.method === 'POST') {
        refreshed = true
        return { accessToken: 'new-token' }
      }
      throw new Error('unexpected')
    })

    const r1 = await useAuthStore.getState().silentRefresh()
    const r2 = await useAuthStore.getState().silentRefresh()

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    // Only the FIRST caller actually performed the POST /refresh.
    const refreshPosts = apiMock.mock.calls.filter(
      (c) => c[0] === '/api/auth/refresh'
    )
    expect(refreshPosts).toHaveLength(1)
    expect(useAuthStore.getState().accessToken).toBe('new-token')
  })

  it('fires POST /refresh when the probe 401s (genuinely expired session)', async () => {
    const { useAuthStore } = await loadStore()

    // Probe always 401s → must proceed to refresh.
    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/api/users/me') throw new Error('401')
      if (path === '/api/auth/refresh' && opts?.method === 'POST') {
        return { accessToken: 'new-token' }
      }
      throw new Error('unexpected')
    })

    const r = await useAuthStore.getState().silentRefresh()

    expect(r).toBe(true)
    const refreshPosts = apiMock.mock.calls.filter(
      (c) => c[0] === '/api/auth/refresh'
    )
    expect(refreshPosts).toHaveLength(1)
    expect(useAuthStore.getState().accessToken).toBe('new-token')
  })

  it('falls back to plain refresh when navigator.locks is unavailable', async () => {
    const { useAuthStore } = await loadStore()
    ;(navigator as unknown as { locks: unknown }).locks = undefined

    apiMock.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/api/users/me') throw new Error('401')
      if (path === '/api/auth/refresh' && opts?.method === 'POST') {
        return { accessToken: 'new-token' }
      }
      throw new Error('unexpected')
    })

    const r = await useAuthStore.getState().silentRefresh()

    expect(r).toBe(true)
    expect(lockRequest).not.toHaveBeenCalled()
    const refreshPosts = apiMock.mock.calls.filter(
      (c) => c[0] === '/api/auth/refresh'
    )
    expect(refreshPosts).toHaveLength(1)
  })
})
