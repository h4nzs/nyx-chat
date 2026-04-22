import { 
  startAuthentication, 
  startRegistration, 
  RegistrationResponseJSON, 
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';

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
  const encoder = new TextEncoder();
  const data = encoder.encode("NYX_CYPHERPUNK_LOCAL_UNLOCK_SALT_V1");
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
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
  const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  
  return { 
    ciphertext: bufferToBase64(encrypted), 
    iv: bufferToBase64(iv.buffer) 
  };
}

async function decryptData(ciphertextB64: string, ivB64: string, keyBuffer: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const encrypted = base64ToBuffer(ciphertextB64);
  
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

/**
 * 1. SETUP BIOMETRIC
 */
export async function setupBiometricUnlock(
  // Terima objek mentah dari API agar kompatibel dengan pemanggilan dari SettingsPage
  rawOptions: Record<string, unknown> | PublicKeyCredentialCreationOptionsJSON, 
  recoveryPhrase: string, 
  getLoginOptions: () => Promise<PublicKeyCredentialRequestOptionsJSON>
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
