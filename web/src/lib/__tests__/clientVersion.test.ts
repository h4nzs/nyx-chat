import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { api, ApiError } from '../api'
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_VALUE, clientVersionHeaders } from '../clientVersion'
import { useClientVersionGateStore } from '../../store/clientVersionGate'
import i18n from '../../i18n'
import enErrors from '../../../public/locales/en/errors.json'
import esErrors from '../../../public/locales/es/errors.json'
import idErrors from '../../../public/locales/id/errors.json'
import ptBrErrors from '../../../public/locales/pt-BR/errors.json'

// [R2 2026-10-15 · 2026-10-27] Tiga sisi kontrak versi klien di klien web:
//   1. setiap request REST membawa header `x-nyx-client-version` (tanpa itu
//      gerbang server tidak punya apa pun untuk diputuskan);
//   2. jawaban 426 (`CLIENT_TOO_OLD` / `CLIENT_VERSION_REQUIRED`) menjadi state
//      yang dirender sebagai LAYAR PENUH, bukan toast — pengguna akan terus
//      kehilangan pesan grup sampai ia memperbarui, dan kegagalan itu tidak
//      boleh bisa tertimpa toast lain;
//   3. kedua kode dibedakan: `too-old` tidak bisa ditutup (semua request gagal),
//      `version-required` boleh ditutup karena baca masih jalan.

vi.mock('@utils/fingerprint', () => ({
  getPersistentInstallationId: vi.fn(async () => 'iid-test'),
}))

// `vi.mock` diangkat ke atas file, jadi fn-nya harus dibuat lewat `vi.hoisted`.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('react-hot-toast', () => ({ default: { error: toastError, success: vi.fn() } }))

const fetchMock = vi.fn()

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function errorResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

// Pakai bundle `errors` bahasa Inggris yang NYATA (bukan key mentah): dengan
// begitu uji ini sekaligus menahan aturan "key harus ada di 4 bahasa" — kalau
// `client_too_old` hilang dari JSON, pesan yang dilihat pengguna jadi
// `client_too_old`, tepat seperti yang terjadi di produksi.
// Sinkron, tanpa backend: `changeLanguage()` akan mencoba mengunduh
// `/locales/en/*.json` di lingkungan uji sehingga hook-nya menggantung.
beforeAll(() => {
  i18n.addResourceBundle('en', 'errors', enErrors, true, true)
  i18n.language = 'en'
})

beforeEach(() => {
  fetchMock.mockReset()
  toastError.mockReset()
  useClientVersionGateStore.getState().reset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('header versi klien (R2)', () => {
  it('setiap request membawa x-nyx-client-version = __APP_VERSION__', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }))

    await api('/api/whatever', { timeoutMs: 1000 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const init = (call?.[1] ?? {}) as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers[CLIENT_VERSION_HEADER]).toBe(CLIENT_VERSION_VALUE)
    expect(headers[CLIENT_VERSION_HEADER]).toBe(__APP_VERSION__)
    // Header lama tidak boleh hilang saat header baru ditambahkan.
    expect(headers['x-nyx-installation-id']).toBe('iid-test')
  })

  it('jalur anonim tidak mengirim cookie, installation ID, atau CSRF', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }))

    await api('/api/groups/sync', { method: 'POST', body: '{}', anonymous: true, timeoutMs: 1000 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit
    expect(init.credentials).toBe('omit')
    const headers = init.headers as Record<string, string>
    expect(headers['x-nyx-installation-id']).toBeUndefined()
    expect(headers['CSRF-Token']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers[CLIENT_VERSION_HEADER]).toBe(CLIENT_VERSION_VALUE)
  })

  it('versi build yang dikirim benar-benar versi nyata, bukan string kosong', () => {
    // Kalau define Vite hilang, `__APP_VERSION__` menjadi undefined dan server
    // memperlakukannya sebagai "klien tanpa penanda versi" — gerbang jadi bisu
    // tanpa gejala. Uji ini menjaga asumsi itu tetap terlihat.
    expect(typeof __APP_VERSION__).toBe('string')
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('jawaban 426 → layar khusus, bukan toast (R2)', () => {
  it('CLIENT_TOO_OLD menyalakan layar penuh dengan versi minimum, tanpa toast', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(426, {
        error: 'CLIENT_TOO_OLD',
        message: 'Versi NYX ini tidak lagi didukung',
        minimumVersion: '3.1.0',
        clientVersion: '2.4.0',
      })
    )

    await expect(api('/api/messages', { timeoutMs: 1000 })).rejects.toBeInstanceOf(ApiError)

    // Permintaan tetap gagal ke pemanggil (perilaku lama), tetapi UI-nya milik
    // store — bukan toast yang bisa tertimpa.
    expect(toastError).not.toHaveBeenCalled()
    expect(useClientVersionGateStore.getState().rejection).toEqual({
      kind: 'too-old',
      minimumVersion: '3.1.0',
      clientVersion: '2.4.0',
    })
  })

  it('CLIENT_VERSION_REQUIRED dibedakan dari too-old (hanya mutasi yang ditolak)', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(426, { error: 'CLIENT_VERSION_REQUIRED', minimumVersion: '3.2.0' })
    )

    await expect(api('/api/messages', { method: 'POST', timeoutMs: 1000 })).rejects.toMatchObject({
      status: 426,
    })

    expect(useClientVersionGateStore.getState().rejection).toEqual({
      kind: 'version-required',
      minimumVersion: '3.2.0',
      clientVersion: undefined,
    })
  })

  it('426 tanpa kode kontrak tidak menyalakan layar', async () => {
    fetchMock.mockResolvedValue(errorResponse(426, { error: 'SOMETHING_ELSE' }))

    await expect(api('/api/messages', { timeoutMs: 1000 })).rejects.toMatchObject({ status: 426 })
    expect(useClientVersionGateStore.getState().rejection).toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('too-old menang atas version-required, tidak bisa ditutup, dan minimum terbaru dipakai', () => {
    const store = useClientVersionGateStore.getState()
    store.report('version-required', { minimumVersion: '3.2.0' })
    store.report('too-old', { minimumVersion: '3.1.0', clientVersion: '2.0.0' })

    // Request berikutnya yang hanya gagal di mutasi tidak boleh menurunkan
    // layar "semua gagal" menjadi layar yang bisa ditutup.
    store.report('version-required', { minimumVersion: '3.3.0' })
    expect(useClientVersionGateStore.getState().rejection).toMatchObject({
      kind: 'too-old',
      clientVersion: '2.0.0',
    })

    store.dismiss()
    // too-old tidak bisa ditutup: semua request gagal, jadi menyembunyikan
    // layar hanya menyembunyikan kegagalan.
    expect(useClientVersionGateStore.getState().dismissed).toBe(false)
  })

  it('version-required boleh ditutup, dan pengulangan jenis yang sama tidak membukanya lagi', () => {
    const store = useClientVersionGateStore.getState()
    store.report('version-required', { minimumVersion: '3.2.0' })
    store.dismiss()
    expect(useClientVersionGateStore.getState().dismissed).toBe(true)

    // Setiap percobaan kirim berikutnya akan 426 lagi — layar tidak boleh
    // berkedip terbuka-tutup untuk setiap pesan yang gagal.
    store.report('version-required', { minimumVersion: '3.2.0' })
    expect(useClientVersionGateStore.getState().dismissed).toBe(true)

    // Tapi minimum yang naik tetap terlihat bila layar dibuka lagi.
    store.report('too-old', { minimumVersion: '3.4.0' })
    expect(useClientVersionGateStore.getState().rejection).toMatchObject({ minimumVersion: '3.4.0' })
    expect(useClientVersionGateStore.getState().dismissed).toBe(false)
  })
})

describe('satu sumber kebenaran untuk header versi (R2)', () => {
  it('helper mengembalikan header yang sama dengan yang dipakai api()', () => {
    expect(clientVersionHeaders()).toEqual({ [CLIENT_VERSION_HEADER]: CLIENT_VERSION_VALUE })
    expect(CLIENT_VERSION_VALUE).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('TIDAK ada jalur REST di luar lib/api.ts yang lupa mengirim header versi', () => {
    // Gerbang versi di server hanya berguna kalau SETIAP jalur /api membawa
    // header ini. Beberapa jalur memang sengaja tidak lewat `api()` (alat
    // WebMCP di main.tsx, pembersihan sesi saat wipe, proksi gambar pratinjau),
    // dan justru jalur seperti itu yang paling mudah terlupa saat ditambah
    // nanti — jadi diperiksa sebagai kontrak sumber, bukan dipercaya dari niat.
    const root = path.resolve(__dirname, '..', '..')
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules') continue
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        if (full.endsWith(path.join('lib', 'api.ts'))) continue

        const source = readFileSync(full, 'utf8')
        const fetchCall = /fetch\(\s*[`'"][^`'"]*\/api\//g
        let match: RegExpExecArray | null
        while ((match = fetchCall.exec(source)) !== null) {
          // Periksa pemanggilan yang sama: dari awal fungsi pembungkusnya (header
          // boleh disiapkan sebagai variabel sebelum `fetch`, seperti di
          // `LinkPreviewCard`) sampai ±400 karakter sesudahnya (untuk options
          // inline) — tanpa melewati pemanggilan berikutnya.
          const start = Math.max(
            source.lastIndexOf('async', match.index),
            source.lastIndexOf('function', match.index),
            source.lastIndexOf('=>', match.index),
            match.index - 200
          )
          const callSite = source.slice(start, match.index + 400)
          if (!callSite.includes('clientVersionHeaders')) {
            const line = source.slice(0, match.index).split('\n').length
            offenders.push(`${path.relative(root, full)}:${line}`)
          }
        }
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })
})

describe('kunci i18n layar versi klien ada di keempat bahasa (R2)', () => {
  const REQUIRED_KEYS = [
    'client_too_old',
    'client_version_too_old_title',
    'client_version_too_old_body',
    'client_version_required_title',
    'client_version_required_body',
    'client_version_current',
    'client_version_minimum',
    'client_version_unknown_minimum',
    'client_version_reload',
    'client_version_continue',
    'client_version_pwa_hint',
  ] as const

  it.each([
    ['en', enErrors],
    ['es', esErrors],
    ['id', idErrors],
    ['pt-BR', ptBrErrors],
  ])('%s', (_lang, bundle) => {
    const strings = bundle as Record<string, string>
    for (const key of REQUIRED_KEYS) {
      expect(typeof strings[key]).toBe('string')
      expect(strings[key]?.length ?? 0).toBeGreaterThan(0)
    }

    // Pesan tanpa versi tidak bisa ditindaklanjuti pengguna: keduanya wajib
    // menyebut minimum, dan body wajib menyebut build yang sedang dipakai.
    expect(strings.client_too_old).toContain('{{minimum}}')
    for (const key of ['client_version_too_old_body', 'client_version_required_body'] as const) {
      expect(strings[key]).toContain('{{minimum}}')
      expect(strings[key]).toContain('{{version}}')
    }
  })
})
