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
  // `isConditionalMediationAvailable` tidak ada hubungannya dengan PRF (itu
  // untuk autofill passkey) — mensyaratkannya membuat browser yang bisa
  // unlock dilaporkan "tidak didukung", sehingga tombol biometric hilang
  // padahal `credentials.get()` + PRF berjalan normal.
  return !!(
    window.PublicKeyCredential &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
  );
}

/**
 * Salt PRF **legacy**: satu nilai statis untuk semua credential. Hanya dipakai
 * untuk membaca vault lama yang belum menyimpan salt per-credential (lihat
 * `entry.salt`). Vault baru memakai salt acak per credential supaya PRF output
 * tidak identik antar-kredensial dan tidak bisa direplay dari credential lain.
 */
async function getPrfSalt(): Promise<Uint8Array> {
  const sodium = await getSodium();
  const encoder = new TextEncoder();
  const data = encoder.encode("NYX_CYPHERPUNK_LOCAL_UNLOCK_SALT_V1");
  return sodium.crypto_generichash(32, data, null);
}

/** Salt PRF acak 32 byte untuk enroll baru (disimpan bersama vault entry). */
async function randomPrfSalt(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(32);
}

/**
 * Turunkan kunci vault dari output PRF + credential ID.
 *
 * Domain separation penting: tanpa label + credential ID, output PRF mentah
 * dari credential yang sama akan menjadi kunci yang sama untuk keperluan lain
 * (dan dua credential dengan salt sama menghasilkan kunci identik).
 */
async function deriveVaultKey(prfOutput: ArrayBuffer, credentialId: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const label = new TextEncoder().encode('NYX_BIO_VAULT_V2|prf|');
  const idBytes = new TextEncoder().encode(credentialId);
  const prfBytes = new Uint8Array(prfOutput);
  const input = new Uint8Array(label.length + idBytes.length + 1 + prfBytes.length);
  input.set(label, 0);
  input.set(idBytes, label.length);
  input[label.length + idBytes.length] = 0;
  input.set(prfBytes, label.length + idBytes.length + 1);
  return sodium.crypto_generichash(32, input, null);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function encryptData(text: string, prfOutput: ArrayBuffer, credentialId: string): Promise<{ ciphertext: string, iv: string }> {
  const sodium = await getSodium();
  const finalKey = await deriveVaultKey(prfOutput, credentialId);
  const iv = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const encodedText = new TextEncoder().encode(text);
  
  const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(encodedText, null, null, iv, finalKey);
  
  return { 
    ciphertext: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL), 
    iv: sodium.to_base64(iv, sodium.base64_variants.ORIGINAL) 
  };
}

async function decryptData(
  ciphertextB64: string,
  ivB64: string,
  prfOutput: ArrayBuffer,
  credentialId: string,
  legacyKdf = false
): Promise<string> {
  const sodium = await getSodium();
  // Entry lama (tanpa `salt`) dienkripsi dengan KDF versi pertama: hash PRF
  // mentah tanpa domain separation. Menukar KDF akan membuat vault lama tidak
  // bisa dibuka, jadi jalur lama dipertahankan hanya untuk entry tersebut.
  const finalKey = legacyKdf
    ? sodium.crypto_generichash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, new Uint8Array(prfOutput), null)
    : await deriveVaultKey(prfOutput, credentialId);
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
// Vault format lama (`nyx_bio_vault`, string tunggal) tidak dibaca lagi
// (`docs/38`): pengguna dengan vault itu akan ditawari enroll ulang, bukan
// dibukakan kunci yang formatnya tidak bisa dipertahankan.

const BIO_VAULT_KEY = 'nyx_bio_vault_v2';

interface BioVaultEntry {
  ciphertext: string;
  iv: string;
  /**
   * Salt PRF per-credential (base64). Kosong pada entry lama → pakai salt
   * legacy statis saat unlock, sehingga vault lama tetap bisa dibuka.
   */
  salt?: string;
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
            map[k] = {
              ciphertext: v.ciphertext,
              iv: v.iv,
              ...(typeof v.salt === 'string' && v.salt.length > 0 ? { salt: v.salt } : {})
            };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Biometric] Failed to parse bio vault map, ignoring:', e);
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
 * Apakah ada bio vault terdaftar (map per-credential)?
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
  } catch (e) {
    console.error('[Biometric] Failed to clear bio vaults:', e);
  }
}

/** base64url untuk challenge/credential id (SimpleWebAuthn memakai base64url). */
function bufferToBase64URL(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomChallenge(): string {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  return bufferToBase64URL(challenge);
}

function prfEnabled(response: { clientExtensionResults?: unknown }): boolean {
  return (response.clientExtensionResults as PRFClientExtensionResults | undefined)?.prf?.enabled === true;
}

function prfFirst(response: { clientExtensionResults?: unknown }): ArrayBuffer | null {
  const first = (response.clientExtensionResults as PRFClientExtensionResults | undefined)?.prf?.results?.first;
  return first ?? null;
}

/**
 * Evaluasi PRF lewat assertion **lokal**.
 *
 * Banyak authenticator (Chrome/Android, sebagian security key) hanya
 * mengembalikan `prf.results` pada `get()`, bukan saat `create()` — dulu ini
 * melempar error "requires a separate authentication step" yang tidak bisa
 * ditindaklanjuti user. Challenge dibuat acak di sini karena hasilnya hanya
 * dipakai untuk menurunkan kunci vault di perangkat ini (tidak ada yang dikirim
 * ke server), jadi tidak ada batas kepercayaan yang dilewati. `allowCredentials`
 * berisi satu credential supaya browser langsung ke credential itu, bukan
 * menampilkan pemilih passkey.
 */
async function evaluatePrfAssertion(input: {
  rpId?: string;
  credentialId: string;
  transports?: string[];
  salt: Uint8Array;
}): Promise<ArrayBuffer> {
  const optionsJSON = {
    challenge: randomChallenge(),
    ...(input.rpId ? { rpId: input.rpId } : {}),
    allowCredentials: [{ id: input.credentialId, type: 'public-key' as const, transports: input.transports }],
    userVerification: 'required' as const,
    timeout: 60000,
    extensions: { prf: { eval: { first: input.salt } } }
  };
  const response = await startAuthentication({
    optionsJSON
  } as unknown as Parameters<typeof startAuthentication>[0]);
  const first = prfFirst(response);
  if (!first) throw new Error('PRF_UNAVAILABLE');
  return first;
}

/** Simpan phrase terenkripsi untuk satu credential + salt PRF-nya. */
async function storeBioVault(
  credentialId: string,
  recoveryPhrase: string,
  prfOutput: ArrayBuffer,
  saltB64: string
): Promise<void> {
  const { ciphertext, iv } = await encryptData(recoveryPhrase, prfOutput, credentialId);
  // [FIX SILENT-VAULT-OVERWRITE] simpan per-credentialId — enroll akun kedua
  // TIDAK menimpa vault akun pertama.
  const map = readVaultMap();
  map[credentialId] = { ciphertext, iv, salt: saltB64 };
  writeVaultMap(map);
}

/**
 * 1. SETUP BIOMETRIC (credential BARU — hanya untuk akun tanpa authenticator)
 */
export async function setupBiometricUnlock(
  // Terima objek mentah dari API agar kompatibel dengan pemanggilan dari SettingsPage
  rawOptions: Record<string, unknown> | PublicKeyCredentialCreationOptionsJSON,
  recoveryPhrase: string
): Promise<RegistrationResponseJSON> {
  const sodium = await getSodium();
  const salt = await randomPrfSalt();
  const saltB64 = sodium.to_base64(salt, sodium.base64_variants.ORIGINAL);

  // Bungkus ke dalam objek optionsJSON sesuai kebutuhan internal startRegistration terbaru
  const authOptions = {
    optionsJSON: {
      ...rawOptions,
      extensions: {
          ...(rawOptions.extensions as Record<string, unknown>),
          prf: { eval: { first: salt } }
      } as unknown // Bypass strict TS check for PRF extension
    } as PublicKeyCredentialCreationOptionsJSON
  };

  // Type assertion untuk menghindari bentrok versi library WebAuthn
  const attResp = await startRegistration(authOptions as unknown as Parameters<typeof startRegistration>[0]);
  if (!prfEnabled(attResp)) {
      throw new Error("Perangkat tidak mendukung WebAuthn PRF.");
  }

  let prf = prfFirst(attResp);
  if (!prf) {
      prf = await evaluatePrfAssertion({
        rpId: (rawOptions as { rp?: { id?: string } }).rp?.id,
        credentialId: attResp.id,
        transports: attResp.response.transports,
        salt
      });
  }

  await storeBioVault(attResp.id, recoveryPhrase, prf, saltB64);
  return attResp as RegistrationResponseJSON;
}

/**
 * 1b. SETUP BIOMETRIC pada credential yang SUDAH ADA (mis. credential attestation
 * saat pendaftaran) — tidak membuat passkey kedua di Google/Apple Password Manager.
 */
export async function setupBiometricUnlockWithExistingCredentials(
  input: { rpID: string; credentials: Array<{ id: string; transports?: string[] }> },
  recoveryPhrase: string
): Promise<{ credentialId: string }> {
  if (input.credentials.length === 0) throw new Error('NO_WEBAUTHN_CREDENTIAL');

  const sodium = await getSodium();
  const salt = await randomPrfSalt();
  const saltB64 = sodium.to_base64(salt, sodium.base64_variants.ORIGINAL);

  const optionsJSON = {
    challenge: randomChallenge(),
    rpId: input.rpID,
    allowCredentials: input.credentials.map((credential) => ({
      id: credential.id,
      type: 'public-key' as const,
      transports: credential.transports
    })),
    userVerification: 'required' as const,
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } }
  };

  const response = await startAuthentication({
    optionsJSON
  } as unknown as Parameters<typeof startAuthentication>[0]);
  const prf = prfFirst(response);
  if (!prf) throw new Error('PRF_UNAVAILABLE');

  await storeBioVault(response.id, recoveryPhrase, prf, saltB64);
  return { credentialId: response.id };
}

/**
 * 2. UNLOCK BIOMETRIC
 */
export async function unlockWithBiometric(
  // Terima objek mentah dari API agar kompatibel dengan pemanggilan dari Login Page
  rawOptions: Record<string, unknown> | PublicKeyCredentialRequestOptionsJSON
): Promise<{ authResp: AuthenticationResponseJSON, recoveryPhrase: string | null, credentialId: string | null }> {
  const vaultMap = readVaultMap();
  const legacySalt = await getPrfSalt();

  // Salt PRF berbeda per credential; karena credential yang dipilih baru
  // diketahui SETELAH assertion, gunakan `evalByCredential` (satu salt per ID
  // yang ada di vault). Entry lama tanpa salt tetap memakai salt legacy.
  const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
  for (const [id, entry] of Object.entries(vaultMap)) {
    evalByCredential[id] = { first: entry.salt ? base64ToBuffer(entry.salt) : legacySalt.buffer as ArrayBuffer };
  }
  const hasPerCredentialSalt = Object.keys(evalByCredential).length > 0;

  const authOptions = {
    optionsJSON: {
      ...rawOptions,
      extensions: {
          ...(rawOptions.extensions as Record<string, unknown>),
          prf: hasPerCredentialSalt
            ? { evalByCredential }
            : { eval: { first: legacySalt } }
      } as unknown // Bypass strict TS check for PRF extension
    } as PublicKeyCredentialRequestOptionsJSON
  };

  const asseResp = await startAuthentication(authOptions as unknown as Parameters<typeof startAuthentication>[0]);
  let recoveryPhrase: string | null = null;

  const credentialId = asseResp.id;
  // Hanya entry credential ini yang boleh membuka vault — tidak ada fallback
  // ke vault lama/credential lain.
  const vault = vaultMap[credentialId];

  if (vault) {
      try {
          const keyBuffer = prfFirst(asseResp);
          if (keyBuffer) {
              recoveryPhrase = await decryptData(
                vault.ciphertext,
                vault.iv,
                keyBuffer,
                credentialId,
                vault.salt === undefined
              );
          }
      } catch (e) {
          console.error("[Biometric] Decryption failed:", e);
      }
  }

  return { authResp: asseResp as AuthenticationResponseJSON, recoveryPhrase, credentialId };
}
