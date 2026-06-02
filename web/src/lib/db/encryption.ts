import { getSodium } from '../sodiumInitializer';

let lsk: Uint8Array | null = null;

export function setLSK(key: Uint8Array) {
  lsk = key;
}

export function clearLSK() {
  if (lsk) {
    lsk.fill(0); // Wipe memory
    lsk = null;
  }
}

export async function encryptField(data: string | Uint8Array): Promise<Uint8Array> {
  if (!lsk) throw new Error('Vault Locked: LSK not initialized.');
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  
  const plainText = typeof data === 'string' ? data : data;
  
  const cipherText = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plainText,
    null,
    null,
    nonce,
    lsk
  );

  const combined = new Uint8Array(nonce.length + cipherText.length);
  combined.set(nonce);
  combined.set(cipherText, nonce.length);
  return combined;
}

export async function decryptField(encrypted: Uint8Array): Promise<Uint8Array | string> {
  if (!lsk) throw new Error('Vault Locked: LSK not initialized.');
  const sodium = await getSodium();
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  
  if (encrypted.length < nonceBytes) throw new Error('Ciphertext too short.');

  const nonce = encrypted.slice(0, nonceBytes);
  const cipherText = encrypted.slice(nonceBytes);

  try {
    const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      cipherText,
      null,
      nonce,
      lsk
    );
    
    // Try to return as string if possible, otherwise return Uint8Array
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
    } catch {
        return decrypted;
    }
  } catch (err) {
    console.error('[encryption] Decryption failed:', err);
    throw new Error('Decryption failed. Incorrect LSK or corrupted data.');
  }
}
