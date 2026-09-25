// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { isPlainObject } from '@utils/typeGuards';
import { 
  startAuthentication, 
  startRegistration, 
  RegistrationResponseJSON, 
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import { getSodium } from './sodiumInitializer';

/**
 * Interface khusus untuk memetakan hasil ekstensi PRF WebAuthn secara Type-Safe
 */
interface PRFClientExtensionResults {
  prf?: {
    enabled?: boolean;
    results?: {
      first: ArrayBuffer;
      second?: ArrayBuffer;
    };
  };
}

/**
 * Cek apakah browser mendukung WebAuthn
 */
export function browserSupportsWebAuthn(): boolean {
  return !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function' &&
    typeof window.PublicKeyCredential.isConditionalMediationAvailable === 'function'
  );
}

async function getPrfSalt(): Promise<Uint8Array> {
  const sodium = await getSodium();
  const encoder = new TextEncoder();
  const data = encoder.encode("NYX_CYPHERPUNK_LOCAL_UNLOCK_SALT_V1");
  return sodium.crypto_generichash(32, data, null);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function encryptData(text: string, keyBuffer: ArrayBuffer): Promise<{ ciphertext: string, iv: string }> {
  const sodium = await getSodium();
  const key = new Uint8Array(keyBuffer);
  // Ensure the key is exactly 32 bytes for XChaCha20Poly1305
  const finalKey = sodium.crypto_generichash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, key, null);
  const iv = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const encodedText = new TextEncoder().encode(text);
  
  const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(encodedText, null, null, iv, finalKey);
  
  return { 
    ciphertext: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL), 
    iv: sodium.to_base64(iv, sodium.base64_variants.ORIGINAL) 
  };
}

async function decryptData(ciphertextB64: string, ivB64: string, keyBuffer: ArrayBuffer): Promise<string> {
  const sodium = await getSodium();
  const key = new Uint8Array(keyBuffer);
  const finalKey = sodium.crypto_generichash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, key, null);
  const iv = sodium.from_base64(ivB64, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.from_base64(ciphertextB64, sodium.base64_variants.ORIGINAL);
  
  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, encrypted, null, iv, finalKey);
  return new TextDecoder().decode(decrypted);
}

// ===========================================================================
// BIO VAULT STORAGE — per-credential, bukan tunggal per-origin
// ===========================================================================
// [FIX SILENT-VAULT-OVERWRITE] Sebelumnya `nyx_bio_vault` berisi SATU entry
// untuk seluruh origin. Akibatnya:
//   1. Dua akun yang enroll biometric di browser yang sama → enroll kedua
//      MENIMPA vault akun pertama secara diam-diam.
//   2. Login PRF yang gagal dekrip memicu `localStorage.removeItem`
//      (jalur biometric_corrupt) yang menghapus vault milik credential lain.
//
// Struktur baru: `nyx_bio_vault_v2` = map credentialId → { ciphertext, iv }.
// Key = credential ID WebAuthn (base64url, tersedia di RegistrationResponseJSON.id
// maupun AuthenticationResponseJSON.id) sehingga:
//   - enroll berbeda akun = entry berbeda (tidak saling menimpa);
//   - credential yang bermasalah bisa dihapus SELEKTIF.
//
// Legacy `nyx_bio_vault` (string tunggal) dimigrasikan on-read ke entry pertama
// yang tersimpan, tanpa memutus unlock yang sudah berjalan.

const BIO_VAULT_KEY = 'nyx_bio_vault_v2';
const BIO_VAULT_LEGACY_KEY = 'nyx_bio_vault';

interface BioVaultEntry {
  ciphertext: string;
  iv: string;
}

type BioVaultMap = Record<string, BioVaultEntry>;

function readVaultMap(): BioVaultMap {
  const map: BioVaultMap = {};
  try {
    const raw = localStorage.getItem(BIO_VAULT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (
            typeof k === 'string' && k.length > 0 &&
            isPlainObject(v) &&
            typeof v.ciphertext === 'string' && typeof v.iv === 'string'
          ) {
            map[k] = { ciphertext: v.ciphertext, iv: v.iv };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Biometric] Failed to parse bio vault map, ignoring:', e);
  }

  // Migrasi legacy one-shot: angkat entry tunggal lama ke map (dipertahankan
  // sampai credential-nya dikenali — dipakai sebagai fallback di unlock).
  if (Object.keys(map).length === 0) {
    try {
      const legacyRaw = localStorage.getItem(BIO_VAULT_LEGACY_KEY);
      if (legacyRaw) {
        const parsed: unknown = JSON.parse(legacyRaw);
        if (isPlainObject(parsed) && typeof parsed.ciphertext === 'string' && typeof parsed.iv === 'string') {
          map['__legacy__'] = { ciphertext: parsed.ciphertext, iv: parsed.iv };
        }
      }
    } catch {
      // legacy vault korup — abaikan
    }
  }

  return map;
}

function writeVaultMap(map: BioVaultMap): void {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(BIO_VAULT_KEY);
    } else {
      localStorage.setItem(BIO_VAULT_KEY, JSON.stringify(map));
    }
  } catch (e) {
    console.error('[Biometric] Failed to persist bio vault map:', e);
  }
}

/**
 * Apakah ada bio vault terdaftar (map v2 ATAU legacy)?
 * Dipakai UI untuk menampilkan status "biometric aktif".
 */
export function hasAnyBioVault(): boolean {
  return Object.keys(readVaultMap()).length > 0;
}

/**
 * Hapus entry vault untuk credential tertentu — SELEKTIF, tidak mengganggu
 * credential lain. Dipakai saat PRF gagal dekrip (kunci korup/mismatch) agar
 * hanya credential bermasalah yang dibuang.
 */
export function removeBioVaultEntry(credentialId: string): void {
  const map = readVaultMap();
  delete map[credentialId];
  writeVaultMap(map);
}

/**
 * Hapus seluruh bio vault (semua credential) — khusus panic wipe / nuke.
 */
export function clearAllBioVaults(): void {
  try {
    localStorage.removeItem(BIO_VAULT_KEY);
    localStorage.removeItem(BIO_VAULT_LEGACY_KEY);
  } catch (e) {
    console.error('[Biometric] Failed to clear bio vaults:', e);
  }
}

/**
 * 1. SETUP BIOMETRIC
 */
export async function setupBiometricUnlock(
  // Terima objek mentah dari API agar kompatibel dengan pemanggilan dari SettingsPage
  rawOptions: Record<string, unknown> | PublicKeyCredentialCreationOptionsJSON, 
  recoveryPhrase: string
): Promise<RegistrationResponseJSON> {
  const salt = await getPrfSalt();
  
  // Bungkus ke dalam objek optionsJSON sesuai kebutuhan internal startRegistration terbaru
  const authOptions = {
    optionsJSON: {
      ...rawOptions,
      extensions: { 
          ...(rawOptions.extensions as Record<string, unknown> || {}),
          prf: { eval: { first: salt } } 
      } as unknown // Bypass strict TS check for PRF extension
    } as PublicKeyCredentialCreationOptionsJSON
  };

  // Type assertion untuk menghindari bentrok versi library WebAuthn
  const attResp = await startRegistration(authOptions as unknown as Parameters<typeof startRegistration>[0]);  
  const extensionResults = attResp.clientExtensionResults as PRFClientExtensionResults;
  const prfSupported = extensionResults.prf?.enabled;
  
  if (prfSupported) {
      // 1. Cek apakah Authenticator (misal Mac TouchID) sudah langsung memberikan kunci PRF saat Registrasi
      const keyBuffer = extensionResults.prf?.results?.first;
      
      if (!keyBuffer) {
          throw new Error("Biometric registration requires a separate authentication step to complete setup. Please re-authenticate to enable vault encryption.");
      }

      if (keyBuffer) {
           const { ciphertext, iv } = await encryptData(recoveryPhrase, keyBuffer);
           // [FIX SILENT-VAULT-OVERWRITE] simpan per-credentialId — enroll akun
           // kedua TIDAK lagi menimpa vault akun pertama.
           const map = readVaultMap();
           delete map['__legacy__']; // credential baru terdaftar; legacy fallback tidak lagi diperlukan utk enroll ini
           map[attResp.id] = { ciphertext, iv };
           writeVaultMap(map);
      } else {
           throw new Error("Otentikator tidak mengembalikan kunci PRF.");
      }
  } else {
      throw new Error("Perangkat tidak mendukung WebAuthn PRF.");
  }
  
  return attResp as RegistrationResponseJSON;
}

/**
 * 2. UNLOCK BIOMETRIC
 */
export async function unlockWithBiometric(
  // Terima objek mentah dari API agar kompatibel dengan pemanggilan dari Login Page
  rawOptions: Record<string, unknown> | PublicKeyCredentialRequestOptionsJSON
): Promise<{ authResp: AuthenticationResponseJSON, recoveryPhrase: string | null, credentialId: string | null }> {
  const salt = await getPrfSalt();
  
  const authOptions = {
    optionsJSON: {
      ...rawOptions,
      extensions: { 
          ...(rawOptions.extensions as Record<string, unknown> || {}),
          prf: { eval: { first: salt } } 
      } as unknown // Bypass strict TS check for PRF extension
    } as PublicKeyCredentialRequestOptionsJSON
  };

  const asseResp = await startAuthentication(authOptions as unknown as Parameters<typeof startAuthentication>[0]);
  let recoveryPhrase: string | null = null;

  const credentialId = asseResp.id;
  const vaultMap = readVaultMap();
  // Entry credential ini dulu; fallback legacy (migrasi) bila belum ada entry v2.
  const vault = vaultMap[credentialId] || vaultMap['__legacy__'];

  if (vault) {
      try {
          const extensionResults = asseResp.clientExtensionResults as PRFClientExtensionResults;
          const keyBuffer = extensionResults.prf?.results?.first;
          
          if (keyBuffer) {
              recoveryPhrase = await decryptData(vault.ciphertext, vault.iv, keyBuffer);
          }
      } catch (e) {
          console.error("[Biometric] Decryption failed:", e);
      }
  }

  return { authResp: asseResp as AuthenticationResponseJSON, recoveryPhrase, credentialId };
}
