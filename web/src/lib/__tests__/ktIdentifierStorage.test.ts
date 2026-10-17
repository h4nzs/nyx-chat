// [docs/30 §30.5 WS-A / docs/32 §32.7 poin 2] Identifier mentah untuk entri log
// rotasi kunci identitas.
//
// Kontrak yang dijaga file ini:
//   1. Identifier disimpan **ter-seal** (`ENC1:`), bukan plaintext di kvStore.
//   2. Slot **scoped per user** — akun B tidak mewarisi (dan tidak menghapus)
//      identifier akun A. Search key yang disangka milik akun sendiri tapi
//      sebenarnya milik akun lain = entri log yang salah alamat.
//   3. `clearKtIdentifier` hanya membuang slot user aktif (logout).
//   4. Wiring store: login & register MENYIMPAN identifier, `logout` MEMBERSIHKAN,
//      `lockApp` TIDAK (vault terkunci hanya membuat pembacaan gagal), dan upload
//      bundle melampirkan nilai itu ke body `POST /keys/prekey-bundle`.
//
// Pemanggilan at-rest di-mock (mekanisme `ENC1:` sendiri diuji di suite
// keychainDb) supaya file ini fokus pada skoping + wiring. Yang diperiksa adalah
// bahwa nilai SEALED yang tersimpan, bukan plaintextnya.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** kvStore palsu: menyimpan RECORD (`{ key, value }`), sama seperti Dexie. */
const kv = new Map<string, { key: string; value: unknown }>()
const localStore = new Map<string, string>()

/** "Vault" palsu: at-rest di sini tidak reversibel dari isi kvStore (plaintext
 * hanya ada di map ini) — jadi test bisa membuktikan yang tersimpan = token. */
;(globalThis as Record<string, unknown>).__ktVault = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: vi.fn((k: string) => localStore.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => { localStore.set(k, v) }),
  removeItem: vi.fn((k: string) => { localStore.delete(k) }),
  clear: vi.fn(() => localStore.clear()),
})
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
})

vi.mock('../db', () => ({
  db: {
    kvStore: {
      get: vi.fn(async (key: string) => kv.get(key)),
      put: vi.fn(async (item: { key: string; value: unknown }) => { kv.set(item.key, item) }),
      delete: vi.fn(async (key: string) => { kv.delete(key) }),
    },
  },
}))
vi.mock('../keychainDb', () => ({
  migrateKeychainAtRestEncryption: vi.fn(async () => {}),
  encryptValueAtRest: vi.fn(async (value: string) => {
    const vault = (globalThis as Record<string, unknown>).__ktVault as Map<string, string>
    const token = `ENC1:tok-${vault.size + 1}`
    vault.set(token, value)
    return token
  }),
  decryptValueAtRest: vi.fn(async (value: string) => {
    const vault = (globalThis as Record<string, unknown>).__ktVault as Map<string, string>
    return vault.get(value) ?? null
  }),
}))
vi.mock('../sodiumInitializer', () => ({ getSodium: vi.fn(async () => ({})) }))

const fakeAuthState = { user: null as null | { id: string } }
;(globalThis as Record<string, unknown>).__nyxAuthStore = {
  getState: () => fakeAuthState,
}

import {
  saveKtIdentifier,
  getKtIdentifier,
  clearKtIdentifier,
  __resetAutoUnlockIdentityForTest,
} from '../keyStorage'

const ID_HASH_A = 'A'.repeat(43)
const ID_HASH_B = 'B'.repeat(43)
const SLOT_A = 'nyx_kt_identifier:user-A'
const SLOT_B = 'nyx_kt_identifier:user-B'

const asUser = (id: string) => { fakeAuthState.user = { id } }

beforeEach(() => {
  kv.clear()
  localStore.clear()
  ;(globalThis as Record<string, unknown>).__ktVault = new Map<string, string>()
  fakeAuthState.user = null
  __resetAutoUnlockIdentityForTest()
})

/** Nilai ter-seal yang benar-benar tersimpan di kvStore (bukan plaintext). */
const storedValue = (slot: string): unknown => kv.get(slot)?.value

describe('identifier KT — penyimpanan ter-seal & scoped per user', () => {
  it('menyimpan ter-seal (bukan plaintext) di slot user aktif', async () => {
    asUser('user-A')
    await saveKtIdentifier(ID_HASH_A)

    const sealed = storedValue(SLOT_A)
    expect(typeof sealed).toBe('string')
    expect(String(sealed).startsWith('ENC1:')).toBe(true)
    // Plaintext TIDAK ada di kvStore — hanya token yang bisa dibuka masterSeed.
    expect(JSON.stringify([...kv.values()])).not.toContain(ID_HASH_A)
    expect(await getKtIdentifier()).toBe(ID_HASH_A)
  })

  it('akun B tidak mewarisi identifier akun A', async () => {
    asUser('user-A')
    await saveKtIdentifier(ID_HASH_A)

    asUser('user-B')
    expect(await getKtIdentifier()).toBeUndefined()

    await saveKtIdentifier(ID_HASH_B)
    expect(await getKtIdentifier()).toBe(ID_HASH_B)

    asUser('user-A')
    expect(await getKtIdentifier()).toBe(ID_HASH_A)
  })

  it('clearKtIdentifier (logout) hanya membuang slot user aktif', async () => {
    asUser('user-A')
    await saveKtIdentifier(ID_HASH_A)
    asUser('user-B')
    await saveKtIdentifier(ID_HASH_B)

    asUser('user-A')
    await clearKtIdentifier()

    expect(kv.has(SLOT_A)).toBe(false)
    asUser('user-B')
    expect(await getKtIdentifier()).toBe(ID_HASH_B)
  })

  it('register: userId eksplisit dipakai saat user belum ada di store', async () => {
    fakeAuthState.user = null
    await saveKtIdentifier(ID_HASH_A, 'user-new')
    expect(storedValue('nyx_kt_identifier:user-new')).toBeDefined()
    expect(storedValue('nyx_kt_identifier:anon')).toBeUndefined()
  })

  it('vault terkunci (dekripsi gagal) → undefined, bukan melempar', async () => {
    asUser('user-A')
    await saveKtIdentifier(ID_HASH_A)
    const keychain = await import('../keychainDb')
    vi.mocked(keychain.decryptValueAtRest).mockResolvedValueOnce(null)

    await expect(getKtIdentifier()).resolves.toBeUndefined()
  })
})

describe('wiring store auth — identifier disimpan & dilampirkan', () => {
  const authSource = () => readFileSync(path.join(here, '../../store/auth.ts'), 'utf8')

  it('login & register menyimpan identifier, logout membersihkannya', () => {
    const source = authSource()
    const saves = source.match(/await saveKtIdentifier\(/g) ?? []
    expect(saves.length, 'dua jalur: login + register').toBe(2)
    expect(source).toMatch(/await saveKtIdentifier\(usernameHash, res\.user\.id\)/)
    expect(source).toMatch(/await clearKtIdentifier\(\)/)
    // lockApp memanggil clearKeys() (slot auto-unlock) — identifier TIDAK ikut
    // dibuang di sana; disimpan agar unlock tanpa login ulang tetap bisa menulis log.
    const lockApp = source.slice(source.indexOf('lockApp: async () => {'), source.indexOf('setDecryptedKeys: async'));
    expect(lockApp).not.toMatch(/clearKtIdentifier/)
  })

  it('upload bundle melampirkan identifier hanya bila tersedia', () => {
    const source = authSource()
    expect(source).toMatch(/const ktIdentifier = await getKtIdentifier\(\);/)
    expect(source).toMatch(/\.\.\.\(ktIdentifier \? \{ usernameHash: ktIdentifier \} : \{\}\)/)
    // Body bundle tetap memuat material kunci yang sudah ada (tidak ada regresi).
    const bundleBody = source.slice(source.indexOf('const bundle = {'), source.indexOf('/api/keys/prekey-bundle'));
    for (const field of ['identityKey', 'pqIdentityKey', 'signingKey', 'signedPreKey']) {
      expect(bundleBody).toContain(field)
    }
  })
})
