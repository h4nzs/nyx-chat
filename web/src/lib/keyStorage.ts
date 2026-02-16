// web/src/lib/keyStorage.ts
import { get, set, del } from 'idb-keyval';
import { clearAllKeys as clearSessionKeys } from './keychainDb';

const STORAGE_KEYS = {
  ENCRYPTED_KEYS: 'nyx_encrypted_keys',
  DEVICE_AUTO_UNLOCK_KEY: 'nyx_device_auto_unlock_key', // Mengganti localStorage key
  DEVICE_AUTO_UNLOCK_READY: 'nyx_device_auto_unlock_ready', // Flag untuk auto-unlock
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

/**
 * Menyimpan kunci auto-unlock perangkat ke IndexedDB
 */
export const saveDeviceAutoUnlockKey = async (key: string) => {
  try {
    await set(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY, key);
  } catch (error) {
    console.error('Failed to save device auto unlock key to IndexedDB:', error);
    throw new Error('Storage failure');
  }
};

/**
 * Mengambil kunci auto-unlock perangkat dari IndexedDB
 */
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
 * Menghapus Keys (Logout/Reset)
 */
export const clearKeys = async () => {
  try {
    // Clear session keys first
    await clearSessionKeys();
    
    await del(STORAGE_KEYS.ENCRYPTED_KEYS);
    await del(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
    await del(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY);
  } catch (error) {
    console.error('Failed to clear keys:', error);
  }
};

/**
 * Cek apakah user punya keys tersimpan (buat logic redirect login)
 */
export const hasStoredKeys = async (): Promise<boolean> => {
  const keys = await getEncryptedKeys();
  return !!keys;
};

