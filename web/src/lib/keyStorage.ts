// web/src/lib/keyStorage.ts
import { KVRepository, clearLSK, setLSK } from './db/index';
import { deriveLSK, getLocalSalt } from './db/localCrypto';
import { sha256, argon2id } from 'hash-wasm';
import { getSodium } from './sodiumInitializer';

const STORAGE_KEYS = {
  ENCRYPTED_KEYS: 'nyx_encrypted_keys',
  DEVICE_AUTO_UNLOCK_KEY: 'nyx_device_auto_unlock_key',
  DEVICE_AUTO_UNLOCK_READY: 'nyx_device_auto_unlock_ready',
  PANIC_HASH: 'nyx_panic_hash',
};

// Helper for KV operations - now using KVRepository
const get = async <T>(key: string): Promise<T | null> => {
  return KVRepository.get<T>(key);
};

const set = async (key: string, value: unknown) => {
  await KVRepository.set(key, value);
};

const del = async (key: string) => {
  await KVRepository.delete(key);
};

const arrayBufferToBase64 = (buffer: Uint8Array) => {
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return window.btoa(binary);
};

const base64ToArrayBuffer = (base64: string) => {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
};

const hexToUint8Array = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid Argon2id hex format: Length must be even");
  }
  if (/[^0-9a-fA-F]/.test(hex)) {
    throw new Error("Invalid Argon2id hex format: Contains non-hex characters");
  }
  const matches = hex.match(/.{1,2}/g);
  if (!matches) {
    throw new Error("Invalid Argon2id hex format: No hex pairs found");
  }
  
  const bytes = matches.map((byte, index) => {
    const parsed = parseInt(byte, 16);
    if (isNaN(parsed)) {
      throw new Error(`Invalid Argon2id hex format: Non-hex character at pair ${index} (${byte})`);
    }
    return parsed;
  });
  
  return new Uint8Array(bytes);
};

// FIX 2: Pindahkan Panic Hash ke IndexedDB (kvStore) agar tersentralisasi
export const setPanicPassword = async (password: string) => {
  if (!password) {
    await del(STORAGE_KEYS.PANIC_HASH);
    return;
  }
  
  const sodium = await getSodium();
  const saltBytes = sodium.randombytes_buf(16);
  const salt = arrayBufferToBase64(saltBytes);
  const params = {
    iterations: 2,
    memorySize: 19456,
    parallelism: 1,
    hashLength: 32
  };
  
  const hashHex = (await argon2id({
    password,
    salt: saltBytes,
    ...params
  })) as unknown as string;
  
  const hashBytes = hexToUint8Array(hashHex);
  const hash = arrayBufferToBase64(hashBytes);

  const record = {
    alg: "NYX_PANIC_VERIFY_V1",
    salt,
    params,
    hash
  };
  
  await set(STORAGE_KEYS.PANIC_HASH, JSON.stringify(record));
};

export const checkPanicPassword = async (password: string): Promise<boolean> => {
  const storedRecordStr = await get<string>(STORAGE_KEYS.PANIC_HASH);
  if (!storedRecordStr) return false;
  
  try {
    if (!storedRecordStr.startsWith('{')) {
      const hash = await sha256(password);
      return hash === storedRecordStr;
    }
    
    const record = JSON.parse(storedRecordStr);
    if (record.alg !== "NYX_PANIC_VERIFY_V1") return false;
    
    const saltBytes = base64ToArrayBuffer(record.salt);
    const derivedHashHex = (await argon2id({
      password,
      salt: saltBytes,
      ...record.params
    })) as string;
    
    const derivedHashBytes = hexToUint8Array(derivedHashHex);
    const derivedHash = arrayBufferToBase64(derivedHashBytes);
    
    return derivedHash === record.hash;
  } catch (e) {
    console.error("Error verifying panic password", e);
    return false;
  }
};

/**
 * Menyimpan Encrypted Private Keys ke PGlite
 */
export const saveEncryptedKeys = async (keysData: string) => {
  try {
    await set(STORAGE_KEYS.ENCRYPTED_KEYS, keysData);
  } catch (error) {
    console.error('Failed to save keys to PGlite:', error);
    throw new Error('Storage failure');
  }
};

/**
 * Mengambil Encrypted Private Keys dari PGlite
 */
export const getEncryptedKeys = async (): Promise<string | undefined> => {
  try {
    const val = await get<string>(STORAGE_KEYS.ENCRYPTED_KEYS);
    return val || undefined;
  } catch (error) {
    console.error('Failed to retrieve keys from PGlite:', error);
    return undefined;
  }
};

const OBFUSCATION_MASK = "NX_AUTH_MASK_2026";

const obfuscate = (text: string): string => {
  const chars = text.split('').map((c, i) => 
    String.fromCharCode(c.charCodeAt(0) ^ OBFUSCATION_MASK.charCodeAt(i % OBFUSCATION_MASK.length))
  );
  return btoa(chars.join(''));
};

const deobfuscate = (b64: string): string => {
  try {
    const chars = atob(b64).split('').map((c, i) => 
      String.fromCharCode(c.charCodeAt(0) ^ OBFUSCATION_MASK.charCodeAt(i % OBFUSCATION_MASK.length))
    );
    return chars.join('');
  } catch {
    return '';
  }
};

export const saveDeviceAutoUnlockKey = async (password: string, userId?: string) => {
  try {
    // 1. Persist password (obfuscated) for browser auto-unlock
    sessionStorage.setItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY, obfuscate(password));

    // 2. Derive and Inject LSK into DatabaseManager
    if (userId) {
       const salt = await getLocalSalt(userId);
       const lsk = await deriveLSK(password, salt);
       setLSK(lsk);
       console.log('[keyStorage] LSK derived and injected.');
    }
  } catch (error) {
    console.error('Failed to save device auto unlock key/LSK');
    throw new Error('Storage failure');
  }
};

export const getDeviceAutoUnlockKey = async (): Promise<string | undefined> => {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
    if (!stored) return undefined;
    
    // Backward compatibility check for un-obfuscated legacy keys
    if (!stored.includes('=') && stored.length < 50) return stored; 
    
    return deobfuscate(stored) || undefined;
  } catch (error) {
    console.error('Failed to retrieve device auto unlock key');
    return undefined;
  }
};

/**
 * Menetapkan status siap auto-unlock perangkat ke IndexedDB
 */
export const setDeviceAutoUnlockReady = async (isReady: boolean) => {
  try {
    sessionStorage.setItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY, isReady ? 'true' : 'false');
  } catch (error) {
    console.error('Failed to set device auto unlock ready status to sessionStorage:', error);
  }
};

/**
 * Mengambil status siap auto-unlock perangkat dari IndexedDB
 */
export const getDeviceAutoUnlockReady = async (): Promise<boolean> => {
  try {
    const isReady = sessionStorage.getItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY);
    return isReady === 'true'; // Pastikan selalu boolean
  } catch (error) {
    console.error('Failed to get device auto unlock ready status from sessionStorage:', error);
    return false;
  }
};

/**
 * Menghapus Keys (Logout Biasa)
 * Hanya menghapus kunci dekripsi lokal, tapi mempertahankan database history
 * agar user tidak kehilangan chat saat login kembali.
 */
export const clearKeys = async () => {
  try {
    // 1. Wipe LSK from memory
    clearLSK();

    // 2. Remove encrypted keys from DB
    await set(STORAGE_KEYS.ENCRYPTED_KEYS, null);
    await del(STORAGE_KEYS.ENCRYPTED_KEYS);
    
    sessionStorage.removeItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
    sessionStorage.removeItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY);
  } catch (error) {
    console.error('Failed to clear keys:', error);
  }
};

/**
 * NUCLEAR WIPE (Emergency Eject)
 * Menghapus SEMUA jejak data dari browser ini.
 */
export const nuclearWipe = async () => {
  try {
    console.warn("INITIATING NUCLEAR WIPE...");
    
    // 1. Wipe memory & master keys
    await clearKeys();
    
    // 2. Bio Vault
    localStorage.removeItem('nyx_bio_vault');
    
    // 3. Clear everything else
    localStorage.clear();
    sessionStorage.clear();
    
    // 4. Delete PGlite data from OPFS
    if (navigator.storage && navigator.storage.getDirectory) {
        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry('nyx-chat-pg', { recursive: true }).catch(() => {});
        } catch (e) {}
    }
    
    // 5. Delete PGlite IDB fallback
    if (typeof indexedDB !== 'undefined') {
        indexedDB.deleteDatabase('/nyx-chat-pg'); // PGlite idb:// prefix usually creates this name or similar
        indexedDB.deleteDatabase('nyx-chat-pg');
    }

    console.warn("NUCLEAR WIPE COMPLETE.");
  } catch (error) {
    console.error('Nuclear wipe failed partially:', error);
  }
};

/**
 * Cek apakah user punya keys tersimpan (buat logic redirect login)
 */
export const hasStoredKeys = async (): Promise<boolean> => {
  const keys = await getEncryptedKeys();
  return !!keys;
};
