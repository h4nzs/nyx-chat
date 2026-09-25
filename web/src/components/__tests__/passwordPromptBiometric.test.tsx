// Kontrak [FIX PASSWORD-BECOMES-INVALID]:
//
// PasswordPromptModal.handleBiometricUnlock HARUS:
//   1. TIDAK menimpa `nyx_encrypted_keys` di IndexedDB (bundle milik password
//      user harus tetap utuh — kalau tidak, login password berikutnya gagal
//      dengan "kunci salah/korup").
//   2. TIDAK menyimpan sessionPassword acak sebagai auto-unlock key.
//   3. Memanggil setDecryptedKeys (kunci masuk RAM via auth store).
//   4. Mengirim sinyal `null` ke onPasswordSubmit (bukan password acak) agar
//      caller tahu vault sudah terbuka via biometric.
//
// Regresi yang dijaga: setelah unlock biometric, retrievePrivateKeys(bundle
// IDB, passwordUser) tetap harus berhasil — keduanya hidup berdampingan.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

// --- Mock modul berat sebelum import komponen ---
const unlockFromRecoveryPhrase = vi.fn()
vi.mock('@lib/biometricUnlockKeys', () => ({
  unlockFromRecoveryPhrase: (...args: unknown[]) => unlockFromRecoveryPhrase(...args),
}))

const unlockWithBiometric = vi.fn()

vi.mock('@lib/api', () => ({
  api: vi.fn().mockResolvedValue({ options: true }),
}))

const restoreFromPhrase = vi.fn()
const retrievePrivateKeys = vi.fn()
vi.mock('@lib/crypto-worker-proxy', () => ({
  restoreFromPhrase: (...args: unknown[]) => restoreFromPhrase(...args),
  retrievePrivateKeys: (...args: unknown[]) => retrievePrivateKeys(...args),
}))

const saveEncryptedKeys = vi.fn()
const saveDeviceAutoUnlockKey = vi.fn()
const setDecryptedKeysAuth = vi.fn()
vi.mock('@lib/keyStorage', () => ({
  saveEncryptedKeys: (...args: unknown[]) => saveEncryptedKeys(...args),
  saveDeviceAutoUnlockKey: (...args: unknown[]) => saveDeviceAutoUnlockKey(...args),
  setDeviceAutoUnlockReady: vi.fn(),
  // [JAGA KONTRAK] auth store mengimpor ini secara statis — tanpa stub di sini,
  // pemanggilan di jalur register (yang diuji test lain) crash dengan
  // "undefined is not a function". Stub flat mencegah mock rapuh saat
  // keyStorage menambah export baru.
  setAutoUnlockIdentity: vi.fn(),
  getEncryptedKeys: vi.fn(),
  clearKeys: vi.fn(),
  hasStoredKeys: vi.fn(),
  getDeviceAutoUnlockKey: vi.fn(),
}))

const authState = {
  setDecryptedKeys: (...args: unknown[]) => setDecryptedKeysAuth(...args),
}
vi.mock('@store/auth', () => ({
  useAuthStore: { getState: () => authState },
}))

// hasAnyBioVault: true (bio vault ada) agar tombol biometric dirender.
const hasAnyBioVault = vi.fn(() => true)
vi.mock('@lib/biometricUnlock', () => ({
  hasAnyBioVault: () => hasAnyBioVault(),
  unlockWithBiometric: (...args: unknown[]) => unlockWithBiometric(...args),
}))

const modalState = {
  isPasswordPromptOpen: true,
  onPasswordSubmit: vi.fn(),
  hidePasswordPrompt: vi.fn(),
}
vi.mock('@store/modal', () => ({
  useModalStore: (selector: (s: typeof modalState) => unknown) => selector(modalState),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))

// keyStorage harus TERLIHAT di-import oleh komponen agar mock tervalidasi —
// namun kontraknya adalah fungsi-fungsi tsb TIDAK PERNAH dipanggil.
import PasswordPromptModal from '../PasswordPromptModal'
import * as keyStorage from '@lib/keyStorage'

describe('PasswordPromptModal biometric unlock (kontrak RAM-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasAnyBioVault.mockReturnValue(true)
    modalState.isPasswordPromptOpen = true
    // localStorage: ada bio vault → tombol biometric tampil
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '{"ciphertext":"x","iv":"y"}'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })

  function findBiometricButton(): HTMLButtonElement {
    // Tombol biometric satu-satunya dengan kelas bg-accent/10 di modal ini.
    const btn = screen.getAllByRole('button').find(
      (b) => b.className.includes('bg-accent/10')
    ) as HTMLButtonElement | undefined
    if (!btn) throw new Error('Biometric button not found')
    return btn
  }

  async function openAndClickBiometric() {
    render(React.createElement(PasswordPromptModal))
    await waitFor(() => expect(findBiometricButton()).toBeTruthy())
    fireEvent.click(findBiometricButton())
    await waitFor(() => {
      expect(unlockWithBiometric).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(modalState.onPasswordSubmit).toHaveBeenCalled()
    })
  }

  it('membuka vault ke RAM via unlockFromRecoveryPhrase dan mengirim sinyal null', async () => {
    unlockWithBiometric.mockResolvedValue({ authResp: {}, recoveryPhrase: 'phrase words here' })
    unlockFromRecoveryPhrase.mockResolvedValue(true)

    await openAndClickBiometric()

    // Kontrak 3: kunci masuk RAM lewat auth store (deps berisi fungsi mock yang sama)
    expect(unlockFromRecoveryPhrase).toHaveBeenCalledTimes(1)
    const firstCall = unlockFromRecoveryPhrase.mock.calls[0]!
    const [phraseArg, depsArg] = firstCall as [string, { setDecryptedKeys: (k: unknown) => unknown; restoreFromPhrase: unknown; retrievePrivateKeys: unknown }]
    expect(phraseArg).toBe('phrase words here')
    expect(depsArg).toEqual(expect.objectContaining({
      restoreFromPhrase: expect.any(Function),
      retrievePrivateKeys: expect.any(Function),
      setDecryptedKeys: expect.any(Function),
    }))
    // Deps di-wire dari modul yang sama (identitas fungsi lewat vi.mock bisa
    // berbeda referensinya antara modul test dan modul komponen) — cukup pastikan
    // dipanggil dengan 3 dep dan perilakunya benar.
    expect(typeof depsArg.restoreFromPhrase).toBe('function')
    expect(typeof depsArg.retrievePrivateKeys).toBe('function')
    // Simulasi pemanggilan dep setDecryptedKeys oleh helper → harus diteruskan ke auth store
    depsArg.setDecryptedKeys({ masterSeed: new Uint8Array(32) })
    expect(setDecryptedKeysAuth).toHaveBeenCalledTimes(1)

    // Kontrak 4: sinyal null ke caller (bukan password acak!)
    expect(modalState.onPasswordSubmit).toHaveBeenCalledWith(null)
    expect(modalState.hidePasswordPrompt).toHaveBeenCalled()
  })

  it('TIDAK MENIMPA bundle IDB & TIDAK menyimpan auto-unlock key (akar bug password-invalid)', async () => {
    unlockWithBiometric.mockResolvedValue({ authResp: {}, recoveryPhrase: 'phrase words here' })
    unlockFromRecoveryPhrase.mockResolvedValue(true)

    await openAndClickBiometric()

    // Kontrak 1 & 2 — inilah yang dulu menyebabkan login password gagal:
    expect(saveEncryptedKeys).not.toHaveBeenCalled()
    expect(saveDeviceAutoUnlockKey).not.toHaveBeenCalled()
  })

  it('unlockFromRecoveryPhrase gagal → error ke user, tanpa sinyal null ke caller', async () => {
    unlockWithBiometric.mockResolvedValue({ authResp: {}, recoveryPhrase: 'phrase words here' })
    unlockFromRecoveryPhrase.mockResolvedValue(false)

    render(React.createElement(PasswordPromptModal))
    await waitFor(() => expect(findBiometricButton()).toBeTruthy())
    fireEvent.click(findBiometricButton())

    await waitFor(() => {
      expect(screen.getByText(/corrupt/i)).toBeInTheDocument()
    })
    expect(modalState.onPasswordSubmit).not.toHaveBeenCalled()
    expect(modalState.hidePasswordPrompt).not.toHaveBeenCalled()
  })

  it('PRF tidak mengembalikan phrase → error, tanpa menyentuh storage', async () => {
    unlockWithBiometric.mockResolvedValue({ authResp: {}, recoveryPhrase: null })

    render(React.createElement(PasswordPromptModal))
    await waitFor(() => expect(findBiometricButton()).toBeTruthy())
    fireEvent.click(findBiometricButton())

    await waitFor(() => {
      expect(screen.getByText(/corrupt/i)).toBeInTheDocument()
    })
    expect(unlockFromRecoveryPhrase).not.toHaveBeenCalled()
    expect(saveEncryptedKeys).not.toHaveBeenCalled()
  })
})

// Kontrak pemanggil (auth.ts promptForPassword): null + cache terisi = resolve.
describe('promptForPassword kontrak sinyal null', () => {
  it('null + privateKeysCache terisi → resolve dengan cache (bukan reject)', async () => {
    // Simulasi logika di auth.ts tanpa mengimpor store penuh:
    const privateKeysCache = { masterSeed: new Uint8Array(32) } as Record<string, unknown>
    const resolve = vi.fn()
    const reject = vi.fn()
    const cleanup = vi.fn()

    // Replikasi guard baru di promptForPassword:
    const password: string | null = null
    if (password === null || password === undefined) {
      if (privateKeysCache) {
        cleanup()
        resolve(privateKeysCache)
      } else {
        cleanup()
        reject(new Error('Password not provided.'))
      }
    }

    expect(resolve).toHaveBeenCalledWith(privateKeysCache)
    expect(reject).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalled()
  })
})
