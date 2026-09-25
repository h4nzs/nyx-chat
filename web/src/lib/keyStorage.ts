import { isPlainObject } from '@utils/typeGuards';
// web/src/lib/keyStorage.ts
import { db } from './db';
import { sha256 } from 'hash-wasm';
import { getSodium } from './sodiumInitializer';

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
    binary += String.fromCharCode(buffer[i] ?? 0);
  }
  return window.btoa(binary);
};

// FIX 2: Pindahkan Panic Hash ke IndexedDB (kvStore) agar tersentralisasi.
// Argon2id dijalankan di crypto worker — bukan main thread (jangan blocking UI).
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

  const { workerPanicHash } = await import('./crypto-worker-proxy');
  const hash = await workerPanicHash(password, salt, params.iterations, params.memorySize, params.parallelism);

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
    
    const _parsedRec = JSON.parse(storedRecordStr); if (!isPlainObject(_parsedRec)) return false; const record = _parsedRec as { alg: string; salt: string; params: { iterations: number; memorySize: number; parallelism: number; hashLength: number }; hash: string };
    if (record.alg !== "NYX_PANIC_VERIFY_V1") return false;
    
    const { workerPanicHash } = await import('./crypto-worker-proxy');
    const derivedHash = await workerPanicHash(password, record.salt, record.params.iterations, record.params.memorySize, record.params.parallelism);
    
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

// Nilai obfuscated selalu b64 → ketika di-XOR balik menghasilkan ASCII printable.
// Nilai legacy plain (pra-obfuscation) umumnya gagal atob atau menghasilkan
// byte tak-printable — dipakai untuk membedakan keduanya TANPA heuristik
// panjang/char '=' yang salah mengklasifikasi key obfuscated pendek.
const isPrintableAscii = (s: string): boolean =>
  s.length > 0 && [...s].every(c => {
    const code = c.charCodeAt(0);
    return code >= 32 && code <= 126;
  });

// Coba deobfuscate dulu; jika hasilnya bukan printable ASCII, anggap stored
// adalah legacy plain dan kembalikan apa adanya. Format frozen — jangan ubah
// skema XOR/mask (lihat OBFUSCATION_MASK).
const resolveStoredAutoUnlockKey = (stored: string): string | undefined => {
  const deobf = deobfuscate(stored);
  if (deobf && isPrintableAscii(deobf)) return deobf;
  return isPrintableAscii(stored) ? stored : undefined;
};

// ===========================================================================
// AUTO-UNLOCK KEY — keyed per user [FIX #5]
// ===========================================================================
// Sebelumnya hanya satu slot sessionStorage global (nyx_device_auto_unlock_key).
// Saat dua akun dipakai bergantian di tab yang sama, auto-unlock key milik
// akun A bisa terpaksa untuk bundle akun B (gagal dekrip) — dan lebih buruk,
// akun B bisa MENIMPA slot milik akun A saat login. Kini setiap user punya
// slot sendiri, di-scope per userId.
//
// Identitas user diambil otomatis: auth store dulu (sumber hidup), fallback ke
// localStorage 'user' (untuk alur restart sebelum store terisi, mis. tryAutoUnlock
// di bootstrap — bootstrap selalu set user SEBELUM memanggil tryAutoUnlock).

const getActiveUserId = (): string | null => {
  try {
    // 1. Auth store (import dinamis untuk menghindari cycle module).
    //    eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = (globalThis as Record<string, unknown>).__nyxAuthStore as
      | { getState: () => { user?: { id?: string } | null } }
      | undefined;
    const uid = mod?.getState?.().user?.id;
    if (uid) return uid;
  } catch { /* fallthrough */ }
  try {
    // 2. Fallback localStorage 'user' (dipersist di login/bootstrap).
    const raw = localStorage.getItem('user');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed) && typeof parsed.id === 'string' && parsed.id) return parsed.id;
    }
  } catch { /* fallthrough */ }
  return null;
};

/** Set identitas user aktif untuk scoping auto-unlock key (register flow: user belum ada di store/localStorage saat save). Berlaku SEKALI — setelah itu identitas kembali dibaca dari auth store/localStorage. */
let pendingIdentity: string | null = null;
export const setAutoUnlockIdentity = (userId: string) => {
  pendingIdentity = userId;
};
const consumeScopedKey = (base: string): string => {
  if (pendingIdentity) {
    const uid = pendingIdentity;
    pendingIdentity = null; // one-shot
    return `${base}:${uid}`;
  }
  const uid = getActiveUserId() ?? 'anon';
  return `${base}:${uid}`;
};

export const saveDeviceAutoUnlockKey = async (key: string) => {
  try {
    const obfKey = obfuscate(key);
    // Auto-unlock key HANYA hidup di sessionStorage (berakhir saat tab ditutup).
    // Tidak lagi dipersist ke IndexedDB — service worker tidak melakukan dekripsi
    // notifikasi (konten didekripsi app-side), jadi persistence permanen tidak diperlukan
    // dan hanya menambah surface bagi penyerang dengan akses disk lokal.
    sessionStorage.setItem(consumeScopedKey(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY), obfKey);
    // Bersihkan nilai lama yang pernah dipersist ke IndexedDB (migrasi)
    await del(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);

    // Sesi sudah ter-unlock → jalankan migrasi enkripsi at-rest keychain
    // (fire-and-forget; idempotent; antre di write queue keychain)
    import('./keychainDb')
      .then(m => m.migrateKeychainAtRestEncryption())
      .catch(e => console.warn('[KeyStorage] Keychain at-rest migration failed:', e));
  } catch (error) {
    console.error('Failed to save device auto unlock key');
    throw new Error('Storage failure');
  }
};

export const getDeviceAutoUnlockKey = async (): Promise<string | undefined> => {
  try {
    // GET tidak boleh mengonsumsi pendingIdentity (itu untuk operasi SET di
    // register). Baca scoped pakai identitas aktif saja.
    const scopedReadKey = `${STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY}:${getActiveUserId() ?? 'anon'}`;
    const stored = sessionStorage.getItem(scopedReadKey);
    if (!stored) {
      // Migrasi: key legacy global (tanpa scope) tetap dikenali agar sesi yang
      // sudah jalan tidak terputus setelah update. Dibaca sekali, tidak ditulis balik.
      const legacy = sessionStorage.getItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
      if (!legacy) return undefined;
      return resolveStoredAutoUnlockKey(legacy);
    }

    return resolveStoredAutoUnlockKey(stored);
  } catch (error) {
    console.error('Failed to retrieve device auto unlock key');
    return undefined;
  }
};

/**
 * Menetapkan status siap auto-unlock perangkat (sessionStorage, keyed per user).
 */
export const setDeviceAutoUnlockReady = async (isReady: boolean) => {
  try {
    sessionStorage.setItem(consumeScopedKey(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY), isReady ? 'true' : 'false');
  } catch (error) {
    console.error('Failed to set device auto unlock ready status to sessionStorage:', error);
  }
};

/**
 * Mengambil status siap auto-unlock perangkat (sessionStorage, keyed per user).
 */
export const getDeviceAutoUnlockReady = async (): Promise<boolean> => {
  try {
    const isReady = sessionStorage.getItem(consumeScopedKey(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY));
    // Legacy global fallback (migrasi).
    if (isReady === null) {
      return sessionStorage.getItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY) === 'true';
    }
    return isReady === 'true';
  } catch (error) {
    console.error('Failed to get device auto unlock ready status from sessionStorage:', error);
    return false;
  }
};

/**
 * Menghapus auto-unlock key milik USER AKTIF saja — logout akun A tidak
 * menghapus sesi unlock akun B di tab yang sama.
 */
export const clearKeys = async () => {
  try {
    sessionStorage.removeItem(consumeScopedKey(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY));
    sessionStorage.removeItem(consumeScopedKey(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY));
    // Bersihkan juga sisa persistence IDB dari versi lama + key global legacy
    await del(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
    sessionStorage.removeItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_KEY);
    sessionStorage.removeItem(STORAGE_KEYS.DEVICE_AUTO_UNLOCK_READY);
  } catch (error) {
    console.error('Failed to clear session keys:', error);
  }
};

/**
 * Cek apakah user punya keys tersimpan (buat logic redirect login)
 */
export const hasStoredKeys = async (): Promise<boolean> => {
  const keys = await getEncryptedKeys();
  return !!keys;
};
