import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, ApiError } from '../api'

// [ROBUSTNESS] Timeout request REST: fetch yang menggantung (server tak
// merespons) tidak boleh menunggu selamanya — harus melempar ApiError(0)
// dengan pesan timeout. Fetch di-mock dengan implementasi yang menghormati
// AbortSignal (seperti fetch asli), timeoutMs kecil dipakai agar test cepat.

vi.mock('@utils/fingerprint', () => ({
  getPersistentInstallationId: vi.fn(async () => 'iid-test'),
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))

const fetchMock = vi.fn()

// Implementasi mock yang menghormati signal: reject dengan abort reason.
function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api() timeout (ROBUSTNESS)', () => {
  it('melempar ApiError(0) berisi pesan timeout saat fetch menggantung', async () => {
    fetchMock.mockImplementation(hangingFetch())

    await expect(api('/api/slow', { timeoutMs: 20 })).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('Request timeout'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejection timeout tetap instanceof ApiError (konsisten jalur error jaringan)', async () => {
    fetchMock.mockImplementation(hangingFetch())

    const err: unknown = await api('/api/slow', { timeoutMs: 20 }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('berhasil ketika fetch merespons sebelum timeout', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }))

    const data = await api<{ ok: boolean }>('/api/fast', { timeoutMs: 1000 })
    expect(data).toEqual({ ok: true })
  })

  it('abort eksternal diteruskan apa adanya (bukan diubah jadi ApiError timeout)', async () => {
    fetchMock.mockImplementation(hangingFetch())

    const controller = new AbortController()
    const p = api('/api/external-abort', { signal: controller.signal, timeoutMs: 5000 })
    controller.abort(new DOMException('dibatalkan pemanggil', 'AbortError'))

    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('timeoutMs 0 menonaktifkan timer (request lama tetap selesai tanpa ApiError)', async () => {
    let release: ((v: Response) => void) | null = null
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )

    const p = api('/api/no-timeout', { timeoutMs: 0 })
    // Lewat 30ms nyata — tanpa timer, tidak ada abort yang terjadi.
    await new Promise((r) => setTimeout(r, 30))
    release!(okResponse({ late: true }))

    await expect(p).resolves.toEqual({ late: true })
  })
})
