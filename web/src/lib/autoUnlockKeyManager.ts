import { getSodium } from './sodiumInitializer';

/**
 * Fungsi untuk mengenkripsi kunci auto-unlock sebelum disimpan ke localStorage
 * @param key Kunci auto-unlock yang akan dienkripsi
 * @param password Password pengguna atau informasi perangkat untuk membuat kunci enkripsi
 * @returns Kunci auto-unlock yang telah dienkripsi dalam format Base64
 */
export async function encryptAutoUnlockKey(key: string, password: string): Promise<string> {
  const sodium = await getSodium();
  
  // Buat salt acak untuk mencegah rainbow table attacks
  const salt = sodium.randombytes_buf(32);
  
  // Derive key dari password dan salt
  const encryptionKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string(password),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_DEFAULT
  );
  
  // Buat nonce acak
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  
  // Enkripsi kunci auto-unlock
  const encryptedKey = sodium.crypto_secretbox_easy(
    sodium.from_string(key),
    nonce,
    encryptionKey
  );
  
  // Gabungkan salt, nonce, dan encrypted key
  const result = new Uint8Array(salt.length + nonce.length + encryptedKey.length);
  result.set(salt, 0);
  result.set(nonce, salt.length);
  result.set(encryptedKey, salt.length + nonce.length);
  
  return sodium.to_base64(result, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Fungsi untuk mendekripsi kunci auto-unlock dari localStorage
 * @param encryptedKey Kunci auto-unlock yang telah dienkripsi dalam format Base64
 * @param password Password pengguna atau informasi perangkat untuk membuat kunci dekripsi
 * @returns Kunci auto-unlock yang telah didekripsi, atau null jika gagal
 */
export async function decryptAutoUnlockKey(encryptedKey: string, password: string): Promise<string | null> {
  const sodium = await getSodium();
  
  try {
    // Decode dari Base64
    const combined = sodium.from_base64(encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    
    // Ekstrak bagian-bagian
    const salt = combined.slice(0, 32);
    const nonce = combined.slice(32, 32 + sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.slice(32 + sodium.crypto_secretbox_NONCEBYTES);
    
    // Derive key dari password dan salt
    const decryptionKey = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      sodium.from_string(password),
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_ALG_DEFAULT
    );
    
    // Dekripsi kunci auto-unlock
    const decryptedKey = sodium.crypto_secretbox_open_easy(
      ciphertext,
      nonce,
      decryptionKey
    );
    
    if (decryptedKey === null) {
      return null;
    }
    
    return sodium.to_string(decryptedKey);
  } catch (error) {
    console.error("Failed to decrypt auto-unlock key:", error);
    return null;
  }
}

/**
 * Fungsi untuk menyimpan kunci auto-unlock dengan enkripsi
 * @param key Kunci auto-unlock yang akan disimpan
 * @param password Password pengguna atau informasi perangkat
 */
export async function saveEncryptedAutoUnlockKey(key: string, password: string): Promise<void> {
  const encryptedKey = await encryptAutoUnlockKey(key, password);
  localStorage.setItem('device_auto_unlock_key_encrypted', encryptedKey);
  // Hapus versi tidak terenkripsi jika ada
  localStorage.removeItem('device_auto_unlock_key');
}

/**
 * Fungsi untuk mengambil kunci auto-unlock yang telah dienkripsi
 * @param password Password pengguna atau informasi perangkat
 * @returns Kunci auto-unlock yang telah didekripsi, atau null jika gagal
 */
export async function getDecryptedAutoUnlockKey(password: string): Promise<string | null> {
  const encryptedKey = localStorage.getItem('device_auto_unlock_key_encrypted');
  if (!encryptedKey) {
    return null;
  }
  
  return await decryptAutoUnlockKey(encryptedKey, password);
}

/**
 * Fungsi untuk memeriksa apakah kunci auto-unlock tersedia (dalam bentuk terenkripsi)
 * @returns true jika kunci auto-unlock tersedia, false jika tidak
 */
export function hasEncryptedAutoUnlockKey(): boolean {
  return localStorage.getItem('device_auto_unlock_key_encrypted') !== null;
}