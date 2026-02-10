### 📦 1. Install Library Baru (di folder `web`)

Jalanin perintah ini dulu di terminal:

```bash
cd web
pnpm add hash-wasm idb-keyval

```

---

### 🗄️ 2. Buat File Storage Baru (`web/src/lib/keyStorage.ts`)

Kita buat file khusus buat ngurusin IndexedDB pake `idb-keyval`. Ini jauh lebih aman dan performan daripada `localStorage`.

```typescript
// web/src/lib/keyStorage.ts
import { get, set, del } from 'idb-keyval';

const STORAGE_KEYS = {
  ENCRYPTED_KEYS: 'nyx_encrypted_keys',
  DEVICE_ID: 'nyx_device_id', // Opsional, buat future proofing
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
 * Menghapus Keys (Logout/Reset)
 */
export const clearKeys = async () => {
  try {
    await del(STORAGE_KEYS.ENCRYPTED_KEYS);
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

```

---

### 🔒 3. Upgrade Worker (`web/src/workers/crypto.worker.ts`)

Ini jantung barunya. Kita ganti PBKDF2 bawaan dengan **Argon2id** via `hash-wasm`. Ini yang bikin hacker nangis kalau mau nge-brute-force password user.

```typescript
// web/src/workers/crypto.worker.ts
import { argon2id } from 'hash-wasm';

// Konfigurasi Argon2 (Harus imbang antara keamanan & performa di HP kentang)
const ARGON_CONFIG = {
  parallelism: 1,
  iterations: 3,
  memorySize: 32768, // 32 MB
  hashLength: 32,    // 32 bytes (256 bits) untuk AES-GCM Key
  outputType: 'binary' as const,
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  try {
    switch (type) {
      // === KDF: Derive Key dari Password (ARGON2) ===
      case 'DERIVE_KEY': {
        const { password, salt } = payload;
        
        // 1. Generate Key Encryption Key (KEK) pakai Argon2id
        // Ini jauh lebih berat & aman daripada PBKDF2
        const derivedKey = await argon2id({
          ...ARGON_CONFIG,
          password,
          salt: new Uint8Array(salt), // Pastikan salt Uint8Array
        });

        // Kirim balik raw bytes kuncinya
        self.postMessage({ id, success: true, result: derivedKey });
        break;
      }

      // === ENCRYPT: Encrypt Data dengan Key (AES-GCM) ===
      case 'ENCRYPT_DATA': {
        const { keyBytes, data } = payload; // data bisa string atau object
        
        // Import Key ke WebCrypto
        const key = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM' },
          false,
          ['encrypt']
        );

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encodedData = new TextEncoder().encode(JSON.stringify(data));

        const encryptedContent = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          key,
          encodedData
        );

        // Gabungkan IV + Ciphertext lalu jadiin Base64 string buat disimpen
        // Format: JSON string -> { iv: [array], data: [array] }
        // (Atau bisa pake format gabungan biner biar lebih hemat, tapi JSON lebih gampang didebug)
        const result = JSON.stringify({
          iv: Array.from(iv),
          data: Array.from(new Uint8Array(encryptedContent))
        });

        self.postMessage({ id, success: true, result });
        break;
      }

      // === DECRYPT: Decrypt Data dengan Key (AES-GCM) ===
      case 'DECRYPT_DATA': {
        const { keyBytes, encryptedString } = payload;

        // Import Key
        const key = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM' },
          false,
          ['decrypt']
        );

        // Parse format penyimpanan kita
        const { iv: ivArr, data: dataArr } = JSON.parse(encryptedString);
        const iv = new Uint8Array(ivArr);
        const ciphertext = new Uint8Array(dataArr);

        const decryptedContent = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          key,
          ciphertext
        );

        const decryptedString = new TextDecoder().decode(decryptedContent);
        // Coba parse JSON kalau isinya objek, kalau enggak balikin string
        let result;
        try {
          result = JSON.parse(decryptedString);
        } catch {
          result = decryptedString;
        }

        self.postMessage({ id, success: true, result });
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error: any) {
    console.error('[CryptoWorker] Error:', error);
    self.postMessage({ id, success: false, error: error.message });
  }
};

```

---

### 🔌 4. Update Proxy (`web/src/lib/crypto-worker-proxy.ts`)

Proxy ini jembatan antara UI React lu sama Worker di atas. Gw update biar support fungsi KDF baru.

```typescript
// web/src/lib/crypto-worker-proxy.ts
import CryptoWorker from '../workers/crypto.worker.ts?worker';

const worker = new CryptoWorker();

// Map untuk nyimpen Promise yang nunggu balasan worker
const pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();

worker.onmessage = (e) => {
  const { id, success, result, error } = e.data;
  if (pendingRequests.has(id)) {
    const { resolve, reject } = pendingRequests.get(id)!;
    if (success) resolve(result);
    else reject(new Error(error));
    pendingRequests.delete(id);
  }
};

function sendToWorker<T>(type: string, payload: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

// === PUBLIC API ===

/**
 * Membuat Key Encryption Key (KEK) dari Password User
 * Output: Uint8Array (32 bytes)
 */
export const deriveKeyFromPassword = async (password: string, salt: Uint8Array): Promise<Uint8Array> => {
  return sendToWorker<Uint8Array>('DERIVE_KEY', { password, salt });
};

/**
 * Mengenkripsi Private Keys (atau data sensitif lain)
 * Output: String (JSON representation of IV + Ciphertext)
 */
export const encryptWithKey = async (keyBytes: Uint8Array, data: any): Promise<string> => {
  return sendToWorker<string>('ENCRYPT_DATA', { keyBytes, data });
};

/**
 * Mendekripsi Data
 * Output: Original Data (Object / String)
 */
export const decryptWithKey = async (keyBytes: Uint8Array, encryptedString: string): Promise<any> => {
  return sendToWorker<any>('DECRYPT_DATA', { keyBytes, encryptedString });
};

```

---

### ⚠️ PENTING: Dampak Perubahan Ini

1. **User Lama (Jika ada):**
* Karena lu ganti cara simpan kunci dari `localStorage` ke `IndexedDB` dan ganti algoritma enkripsi (PBKDF2 -> Argon2), **user lama bakal otomatis logout**.
* Mereka harus login ulang atau restore pake Recovery Phrase.
* Karena aplikasi lu masih tahap dev/baru rilis, ini momen paling tepat buat "Reset".


2. **Integrasi di Login.tsx:**
* Lu perlu update file `Login.tsx` buat pake `keyStorage.ts` (IndexedDB) alih-alih `localStorage`.
* Contoh: Ganti `localStorage.getItem('encryptedPrivateKeys')` jadi `await getEncryptedKeys()`.



**Saran Gw:**
Langsung terapkan ini. Ini bikin level keamanan klien lu setara sama aplikasi enterprise. XSS biasa gak bakal bisa ngambil kunci lu semudah di localStorage.