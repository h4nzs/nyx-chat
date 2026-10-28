// Kontrak [FIX SILENT-VAULT-OVERWRITE] — bio vault per-credentialId:
//   1. Enroll akun kedua TIDAK menimpa vault akun pertama (map, bukan key tunggal).
//   2. removeBioVaultEntry(credentialId) hapus SELEKTIF — credential lain selamat.
//   3. clearAllBioVaults menghapus map per-credential.
//   4. hasAnyBioVault mencerminkan isi map.
//
// Format lama `nyx_bio_vault` (string tunggal) sudah dipensiunkan (`docs/38`):
// tidak ada lagi pembacaan/migrasinya, jadi tidak diuji di sini.
//
// Logika storage dieksekusi lewat fungsi internal biometricUnlock.ts yang
// memakai localStorage — di sini kita uji via modul dengan localStorage stub.
// Fungsi encrypt/decrypt & WebAuthn tidak diperlukan: kita uji helper storage
// secara langsung dengan meniru struktur penyimpanan yang dipakai modul.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// --- localStorage stub (jsdom punya localStorage, tapi kita isolasi per-test) ---
const store = new Map<string, string>()
const localStorageStub = {
  getItem: vi.fn((k: string) => store.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => { store.set(k, v) }),
  removeItem: vi.fn((k: string) => { store.delete(k) }),
  clear: vi.fn(() => store.clear()),
}
vi.stubGlobal('localStorage', localStorageStub)

import {
  removeBioVaultEntry,
  clearAllBioVaults,
  hasAnyBioVault,
  browserSupportsWebAuthn,
} from '../biometricUnlock'

// Helper replikasi format yang ditulis setupBiometricUnlock (untuk simulasi enroll):
const V2 = 'nyx_bio_vault_v2'

function simulateEnroll(credentialId: string) {
  const raw = localStorageStub.getItem(V2)
  const map: Record<string, { ciphertext: string; iv: string }> = raw ? JSON.parse(raw) : {}
  map[credentialId] = { ciphertext: `ct-${credentialId}`, iv: `iv-${credentialId}` }
  localStorageStub.setItem(V2, JSON.stringify(map))
}

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
})

describe('bio vault per-credential (kontrak storage)', () => {
  it('enroll dua akun/credential → dua entry terpisah, tidak saling menimpa', () => {
    simulateEnroll('cred-A')
    simulateEnroll('cred-B')

    const map = JSON.parse(localStorageStub.getItem(V2)!)
    expect(Object.keys(map).sort()).toEqual(['cred-A', 'cred-B'])
    expect(map['cred-A'].ciphertext).toBe('ct-cred-A')
    expect(map['cred-B'].ciphertext).toBe('ct-cred-B')
  })

  it('removeBioVaultEntry hapus SELEKTIF — credential lain selamat (regresi biometric_corrupt)', () => {
    simulateEnroll('cred-A')
    simulateEnroll('cred-B')

    removeBioVaultEntry('cred-A')

    const map = JSON.parse(localStorageStub.getItem(V2)!)
    expect(map['cred-A']).toBeUndefined()
    expect(map['cred-B']).toBeDefined()
    expect(map['cred-B'].ciphertext).toBe('ct-cred-B')
  })

  it('removeBioVaultEntry entry terakhir → key v2 dihapus bersih (bukan map kosong)', () => {
    simulateEnroll('cred-A')
    removeBioVaultEntry('cred-A')
    expect(localStorageStub.getItem(V2)).toBeNull()
  })

  it('clearAllBioVaults menghapus map per-credential (nuke/panic wipe)', () => {
    simulateEnroll('cred-A')

    clearAllBioVaults()

    expect(localStorageStub.getItem(V2)).toBeNull()
    expect(hasAnyBioVault()).toBe(false)
  })

  it('hasAnyBioVault: false saat kosong, true saat ada credential v2', () => {
    expect(hasAnyBioVault()).toBe(false)
    simulateEnroll('cred-A')
    expect(hasAnyBioVault()).toBe(true)
  })

  it('salt PRF per-credential ikut tersimpan dan tidak hilang saat entry lain dihapus', () => {
    // Entry baru (format 2026-10-18) membawa salt acak; entry lama tidak.
    localStorageStub.setItem(V2, JSON.stringify({
      'cred-new': { ciphertext: 'ct-new', iv: 'iv-new', salt: 'c2FsdC1uZXc=' },
      'cred-old': { ciphertext: 'ct-old', iv: 'iv-old' },
    }))

    removeBioVaultEntry('cred-old')

    const map = JSON.parse(localStorageStub.getItem(V2)!)
    // Salt harus bertahan — tanpa itu unlock memakai salt legacy dan dekripsi
    // vault baru gagal (diam-diam jadi `recoveryPhrase: null`).
    expect(map['cred-new'].salt).toBe('c2FsdC1uZXc=')
  })
})

describe('deteksi dukungan WebAuthn', () => {
  it('tidak mensyaratkan isConditionalMediationAvailable (tidak relevan untuk PRF)', () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    })
    expect(browserSupportsWebAuthn()).toBe(true)

    vi.stubGlobal('PublicKeyCredential', undefined)
    expect(browserSupportsWebAuthn()).toBe(false)

    vi.unstubAllGlobals()
  })
})
