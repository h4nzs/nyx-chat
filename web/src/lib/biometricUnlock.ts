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

async function getPrfSalt(): Promise<Uint8Array> {
  const sodium = await getSodium();
  const encoder = new TextEncoder();
  const data = encoder.encode("NYX_CYPHERPUNK_LOCAL_UNLOCK_SALT_V1");
  return sodium.crypto_generichash(32, data);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
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
  const finalKey = sodium.crypto_generichash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, key);
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
  const finalKey = sodium.crypto_generichash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, key);
  const iv = sodium.from_base64(ivB64, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.from_base64(ciphertextB64, sodium.base64_variants.ORIGINAL);
  
  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, encrypted, null, iv, finalKey);
  return new TextDecoder().decode(decrypted);
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
           localStorage.setItem('nyx_bio_vault', JSON.stringify({ ciphertext, iv }));
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
): Promise<{ authResp: AuthenticationResponseJSON, recoveryPhrase: string | null }> {
  const vaultStr = localStorage.getItem('nyx_bio_vault');
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

  if (vaultStr) {
      try {
          const vault = JSON.parse(vaultStr) as { ciphertext: string, iv: string };
          const extensionResults = asseResp.clientExtensionResults as PRFClientExtensionResults;
          const keyBuffer = extensionResults.prf?.results?.first;
          
          if (keyBuffer) {
              recoveryPhrase = await decryptData(vault.ciphertext, vault.iv, keyBuffer);
          }
      } catch (e) {
          console.error("[Biometric] Decryption failed:", e);
      }
  }

  return { authResp: asseResp as AuthenticationResponseJSON, recoveryPhrase };
}
