import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

// Salt statis untuk PRF (harus sama persis setiap kali diminta). 
const PRF_SALT = new TextEncoder().encode("NYX_CYPHERPUNK_LOCAL_UNLOCK_SALT_12345678"); // 32 bytesish

// Helper: WebCrypto AES-GCM
async function encryptData(text: string, keyBuffer: ArrayBuffer): Promise<{ ciphertext: string, iv: string }> {
  const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { 
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))), 
    iv: btoa(String.fromCharCode(...iv)) 
  };
}

async function decryptData(ciphertextB64: string, ivB64: string, keyBuffer: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const encrypted = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

// 1. SETUP (Dipanggil saat user mengaktifkan Biometric di Settings)
// Meminta otentikator untuk membuat kredensial baru dengan dukungan PRF, 
// lalu mengenkripsi Recovery Phrase dengan kunci dari PRF tersebut.
export async function setupBiometricUnlock(options: any, recoveryPhrase: string): Promise<any> {
  try {
    // Inject PRF extension ke options dari server
    // Note: TypeScript might complain about 'extensions', using 'any' bypasses it safely for now
    const authOptions: any = {
      ...options,
      extensions: { 
          ...options.extensions,
          prf: { eval: { first: PRF_SALT } } 
      }
    };

    const attResp = await startRegistration(authOptions);
    
    // Ambil kunci rahasia yang dihasilkan oleh hardware sidik jari (PRF)
    const prfResults = (attResp as any).clientExtensionResults?.prf;
    
    // Note: Not all authenticators return PRF on registration, some do it only on auth.
    // However, for setup we assume support. If results.first is missing, PRF failed.
    if (prfResults?.enabled) {
        // If 'enabled' is true, it means PRF is supported but key might not be returned on reg.
        // But to lock the vault, we NEED the key. 
        // Some implementations require a separate authentication call right after registration to get the key.
        // For simplicity in this iteration, we assume the browser returns it if 'eval' was requested.
        // If not, we might need a two-step flow (Register -> Auth -> Lock).
        
        if (prfResults.results?.first) {
             const symmetricKey = new Uint8Array(prfResults.results.first).buffer;
             // Enkripsi recovery phrase menggunakan kunci dari sidik jari
             const { ciphertext, iv } = await encryptData(recoveryPhrase, symmetricKey);
             localStorage.setItem('nyx_bio_vault', JSON.stringify({ ciphertext, iv }));
        } else {
             console.warn("PRF enabled but no key returned. Vault setup skipped.");
        }
    } else {
        console.warn("Device does not support WebAuthn PRF extension.");
    }
    
    return attResp;
  } catch (err) {
    console.error("PRF Setup Error:", err);
    throw err;
  }
}

// 2. UNLOCK (Dipanggil di halaman Login)
export async function unlockWithBiometric(options: any): Promise<{ authResp: any, recoveryPhrase: string | null }> {
  const vaultStr = localStorage.getItem('nyx_bio_vault');
  
  const authOptions: any = {
    ...options,
    extensions: { 
        ...options.extensions,
        prf: { eval: { first: PRF_SALT } } 
    }
  };

  const asseResp = await startAuthentication(authOptions);
  
  let recoveryPhrase: string | null = null;

  if (vaultStr) {
      try {
          const vault = JSON.parse(vaultStr);
          const prfResults = (asseResp as any).clientExtensionResults?.prf;
          
          if (prfResults?.results?.first) {
              const symmetricKey = new Uint8Array(prfResults.results.first).buffer;
              // Dekripsi phrase menggunakan kunci yang baru saja dibuat ulang oleh sidik jari
              recoveryPhrase = await decryptData(vault.ciphertext, vault.iv, symmetricKey);
          }
      } catch (e) {
          console.error("Failed to unlock local vault:", e);
      }
  }

  return { authResp: asseResp, recoveryPhrase };
}
