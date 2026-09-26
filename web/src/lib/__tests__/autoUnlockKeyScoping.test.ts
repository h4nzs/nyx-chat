// Kontrak [FIX #5] — auto-unlock key keyed per user:
//   1. Dua akun bergantian di tab sama TIDAK saling menimpa slot auto-unlock.
//   2. clearKeys/logout akun A tidak menghapus slot akun B.
//   3. Key di-scope `nyx_device_auto_unlock_key:<userId>` di sessionStorage.
//   4. Legacy key global (tanpa scope) tetap terbaca (migrasi) saat scoped kosong.
//   5. Tanpa identitas → fallback 'anon' (perilaku terbatas, tidak crash).
//
// keyStorage membaca identitas via globalThis.__nyxAuthStore (di-set auth store)
// dan fallback localStorage 'user'. Di sini keduanya di-stub langsung.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const sessionStore = new Map<string, string>()
const localStore = new Map<string, string>()

vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((k: string) => sessionStore.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => { sessionStore.set(k, v) }),
  removeItem: vi.fn((k: string) => { sessionStore.delete(k) }),
  clear: vi.fn(() => sessionStore.clear()),
})
vi.stubGlobal('localStorage', {
  getItem: vi.fn((k: string) => localStore.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => { localStore.set(k, v) }),
  removeItem: vi.fn((k: string) => { localStore.delete(k) }),
  clear: vi.fn(() => localStore.clear()),
})

// Stub IDB deps keyStorage (kvStore + keychainDb migration) — tidak dipakai logika yang dites.
vi.mock('../db', () => ({
  db: { kvStore: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) } },
}))
vi.mock('../keychainDb', () => ({
  migrateKeychainAtRestEncryption: vi.fn(async () => {}),
}))
// Path mock harus dari folder file test ini (__tests__/): '../sodiumInitializer'
// menunjuk src/lib/sodiumInitializer.ts yang benar-benar di-import target.
vi.mock('../sodiumInitializer', () => ({
  getSodium: vi.fn(async () => ({})),
}))

// Simulasi auth store global — identitas diubah per-test.
const fakeAuthState = { user: null as null | { id: string } }
;(globalThis as Record<string, unknown>).__nyxAuthStore = {
  getState: () => fakeAuthState,
}

import {
  saveDeviceAutoUnlockKey,
  getDeviceAutoUnlockKey,
  setDeviceAutoUnlockReady,
  clearKeys,
  setAutoUnlockIdentity,
  __resetAutoUnlockIdentityForTest,
} from '../keyStorage'

const KEY_A = 'nyx_device_auto_unlock_key:user-A'
const KEY_B = 'nyx_device_auto_unlock_key:user-B'
const READY_A = 'nyx_device_auto_unlock_ready:user-A'

function asUser(id: string) {
  fakeAuthState.user = { id }
}

beforeEach(() => {
  sessionStore.clear()
  localStore.clear()
  fakeAuthState.user = null
  // [Temuan #4] pendingIdentity adalah state module-level one-shot — tanpa reset
  // eksplisit, identity dari test sebelumnya bocor ke test berikutnya dan bisa
  // membuat assertion pass secara semu (mis. key ditulis ke slot user yang salah
  // tapi assertion kebetulan cocok). Reset di sini menjamin setiap test mulai
  // dari state identitas yang bersih.
  __resetAutoUnlockIdentityForTest()
})

describe('auto-unlock key per user (kontrak [FIX #5])', () => {
  it('save untuk user A menulis ke slot scoped, bukan global', async () => {
    asUser('user-A')
    await saveDeviceAutoUnlockKey('password-A')

    expect(sessionStore.has(KEY_A)).toBe(true)
    expect(sessionStore.has('nyx_device_auto_unlock_key')).toBe(false)
    expect(await getDeviceAutoUnlockKey()).toBe('password-A')
  })

  it('dua akun bergantian → slot terpisah, tidak saling menimpa', async () => {
    asUser('user-A')
    await saveDeviceAutoUnlockKey('password-A')

    asUser('user-B')
    await saveDeviceAutoUnlockKey('password-B')

    // Slot A tidak tertimpa oleh login B.
    expect(sessionStore.get(KEY_A)).toBeDefined()
    expect(sessionStore.get(KEY_B)).toBeDefined()

    // Masing-masing membaca nilainya sendiri.
    asUser('user-A')
    expect(await getDeviceAutoUnlockKey()).toBe('password-A')
    asUser('user-B')
    expect(await getDeviceAutoUnlockKey()).toBe('password-B')
  })

  it('clearKeys (logout) user A TIDAK menghapus slot user B', async () => {
    asUser('user-A')
    await saveDeviceAutoUnlockKey('password-A')
    await setDeviceAutoUnlockReady(true)

    asUser('user-B')
    await saveDeviceAutoUnlockKey('password-B')

    // Logout user A
    asUser('user-A')
    await clearKeys()

    expect(sessionStore.has(KEY_A)).toBe(false)
    expect(sessionStore.has(READY_A)).toBe(false)
    // User B utuh.
    asUser('user-B')
    expect(await getDeviceAutoUnlockKey()).toBe('password-B')
  })

  it('legacy key global (tanpa scope) tetap terbaca saat scoped kosong (migrasi)', async () => {
    asUser('user-A')
    // Simulasi key dari versi lama (global, obfuscated dengan mask modul — kita
    // simpan versi polos pendek yang lolos jalur backward-compat).
    sessionStore.set('nyx_device_auto_unlock_key', 'legacy-plain-key')

    expect(await getDeviceAutoUnlockKey()).toBe('legacy-plain-key')
  })

  it('register flow: setAutoUnlockIdentity dipakai saat user belum ada di store/localStorage', async () => {
    fakeAuthState.user = null
    localStore.delete('user')
    setAutoUnlockIdentity('user-new')

    await saveDeviceAutoUnlockKey('password-new')
    expect(sessionStore.has('nyx_device_auto_unlock_key:user-new')).toBe(true)

    // getDeviceAutoUnlockKey memakai pendingIdentity yang sudah dikonsumsi —
    // jatuh ke identitas aktif (null → 'anon') → tidak menemukan key user-new.
    // Ini perilaku register nyata: get tidak dipanggil sebelum user tersimpan.
    // Verifikasi nilai tersimpan via slot scoped (bukan fallback anon).
    expect(sessionStore.get('nyx_device_auto_unlock_key:user-new')).toBeDefined()
    expect(sessionStore.has('nyx_device_auto_unlock_key:anon')).toBe(false)

    // Simulasi register selesai: user tersimpan di auth store → baca normal.
    asUser('user-new')
    expect(await getDeviceAutoUnlockKey()).toBe('password-new')

    // User lain tidak melihat slot milik user-new.
    asUser('user-A')
    expect(await getDeviceAutoUnlockKey()).toBeUndefined()
  })

  it('ready flag juga scoped per user', async () => {
    asUser('user-A')
    await setDeviceAutoUnlockReady(true)
    asUser('user-B')
    // B belum pernah set → false (bukan mewarisi true milik A).
    expect(sessionStore.has('nyx_device_auto_unlock_ready:user-B')).toBe(false)
  })
})
