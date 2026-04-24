// web/src/lib/keyStorage.ts
import { db } from './db';
// FIX 1: Perbaikan case-sensitivity nama file agar aman di build Linux/Vercel
import { clearAllKeys as clearSessionKeys } from './keychainDb';
import { sha256, argon2id } from 'hash-wasm';

const STORAGE_KEYS = {
  ENCRYPTED_KEYS: 'nyx_encrypted_keys',
  DEVICE_AUTO_UNLOCK_KEY: 'nyx_device_auto_unlock_key',
  DEVICE_AUTO_UNLOCK_READY: 'nyx_device_auto_unlock_ready',
  PANIC_HASH: 'nyx_panic_hash',
};

// Helper for KV operations
const get = async <T>(key: string): Promise<T | undefined> => {
  const item = await db.kvStore.get(key);
  return item?.value as T | undefined;
};

const set = async (key: string, value: unknown) => {
  await db.kvStore.put({ key, value });
};

const del = async (key: string) => {
  await db.kvStore.delete(key);
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
  
  const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
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
 * Menyimpan Encrypted Private Keys ke IndexedDB
 */
export const saveEncryptedKeys = async (keysData: string) => {
  try {
    await set(STORAGE_KEYS.ENCRYPTED_KEYS, keysData);
  } catch (error) {
    console.error('Failed to save keys to IndexedDB:', error);
    throw new Error('Storage failure');
  }
};

/**
 * Mengambil Encrypted Private Keys dari IndexedDB
 */
export const getEncryptedKeys = async (): Promise<string | undefined> => {
  try {
    return await get<string>(STORAGE_KEYS.ENCRYPTED_KEYS);
  } catch (error) {
    console.error('Failed to retrieve keys from IndexedDB:', error);
    return undefined;
  }
};

export const saveDeviceAutoUnlockKey = async (key: string) => {
  try {
    await set(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY, key);
  } catch (error) {
    console.error('Failed to save device auto unlock key to IndexedDB:', error);
    throw new Error('Storage failure');
  }
};

export const getDeviceAutoUnlockKey = async (): Promise<string | undefined> => {
  try {
    return await get<string>(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
  } catch (error) {
    console.error('Failed to retrieve device auto unlock key from IndexedDB:', error);
    return undefined;
  }
};

/**
 * Menetapkan status siap auto-unlock perangkat ke IndexedDB
 */
export const setDeviceAutoUnlockReady = async (isReady: boolean) => {
  try {
    await set(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY, isReady);
  } catch (error) {
    console.error('Failed to set device auto unlock ready status to IndexedDB:', error);
  }
};

/**
 * Mengambil status siap auto-unlock perangkat dari IndexedDB
 */
export const getDeviceAutoUnlockReady = async (): Promise<boolean> => {
  try {
    const isReady = await get<boolean>(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY);
    return !!isReady; // Pastikan selalu boolean
  } catch (error) {
    console.error('Failed to get device auto unlock ready status from IndexedDB:', error);
    return false;
  }
};

/**
 * Menghapus Keys (Logout Biasa)
 * Hanya menghapus kunci dekripsi lokal, tapi mempertahankan database history (keychain-db)
 * agar user tidak kehilangan chat saat login kembali.
 */
export const clearKeys = async () => {
  try {
    await del(STORAGE_KEYS.ENCRYPTED_KEYS);
    await del(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
    await del(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY);
  } catch (error) {
    console.error('Failed to clear keys:', error);
  }
};

/**
 * NUCLEAR WIPE (Emergency Eject)
 * Menghapus SEMUA jejak data dari browser ini.
 * - Menghapus Session Keys & History (IndexedDB)
 * - Menghapus Master Keys (IDB-Keyval)
 * - Menghapus LocalStorage & SessionStorage
 */
export const nuclearWipe = async () => {
  try {
    console.warn("INITIATING NUCLEAR WIPE...");
    
    // 1. Hapus Kunci Master
    await clearKeys();
    
    // 2. Hapus History & Session Keys (The Vault)
    await clearSessionKeys();
    
    // 3. Hapus Bio Vault (WebAuthn PRF Storage)
    localStorage.removeItem('nyx_bio_vault');
    
    // 4. Hapus sisa LocalStorage (User Profile, Settings, dll)
    localStorage.clear();
    sessionStorage.clear();
    
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
