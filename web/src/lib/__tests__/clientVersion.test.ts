import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { api, ApiError } from '../api'
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_VALUE, clientVersionHeaders } from '../clientVersion'
import i18n from '../../i18n'
import enErrors from '../../../public/locales/en/errors.json'
import esErrors from '../../../public/locales/es/errors.json'
import idErrors from '../../../public/locales/id/errors.json'
import ptBrErrors from '../../../public/locales/pt-BR/errors.json'

// [R2 2026-10-15] Dua sisi kontrak versi klien di klien web:
//   1. setiap request REST membawa header `x-nyx-client-version` (tanpa itu
//      gerbang server tidak punya apa pun untuk diputuskan);
//   2. jawaban 426 `CLIENT_TOO_OLD` menjadi toast yang MENETAP (bukan pesan
//      sekilas di konsol) — karena pengguna akan terus kehilangan pesan grup
//      sampai ia memperbarui.

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

  it('versi build yang dikirim benar-benar versi nyata, bukan string kosong', () => {
    // Kalau define Vite hilang, `__APP_VERSION__` menjadi undefined dan server
    // memperlakukannya sebagai "klien tanpa penanda versi" — gerbang jadi bisu
    // tanpa gejala. Uji ini menjaga asumsi itu tetap terlihat.
    expect(typeof __APP_VERSION__).toBe('string')
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('jawaban 426 CLIENT_TOO_OLD (R2)', () => {
  it('menampilkan toast menetap dengan id tunggal + menyebut versi minimum', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(426, {
        error: 'CLIENT_TOO_OLD',
        message: 'Versi NYX ini tidak lagi didukung',
        minimumVersion: '3.1.0',
      })
    )

    await expect(api('/api/messages', { timeoutMs: 1000 })).rejects.toBeInstanceOf(ApiError)

    expect(toastError).toHaveBeenCalledTimes(1)
    const call = toastError.mock.calls[0]
    expect(call).toBeDefined()
    const message = call?.[0]
    const options = call?.[1]
    expect(options).toMatchObject({ id: 'client-too-old', duration: Infinity })
    expect(String(message)).toContain('3.1.0')
  })

  it('status 426 tanpa kode CLIENT_TOO_OLD tidak memicu toast khusus', async () => {
    fetchMock.mockResolvedValue(errorResponse(426, { error: 'SOMETHING_ELSE' }))

    await expect(api('/api/messages', { timeoutMs: 1000 })).rejects.toMatchObject({ status: 426 })
    expect(toastError).not.toHaveBeenCalled()
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

describe('kunci i18n client_too_old ada di keempat bahasa (R2)', () => {
  it.each([
    ['en', enErrors],
    ['es', esErrors],
    ['id', idErrors],
    ['pt-BR', ptBrErrors],
  ])('%s', (_lang, bundle) => {
    const key = (bundle as Record<string, string>).client_too_old
    expect(typeof key).toBe('string')
    // Placeholder `{{minimum}}` wajib ada: pesan tanpa versi minimum tidak bisa
    // ditindaklanjuti pengguna.
    expect(key).toContain('{{minimum}}')
  })
})
