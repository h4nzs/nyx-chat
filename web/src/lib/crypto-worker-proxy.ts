// web/src/lib/crypto-worker-proxy.ts
import CryptoWorker from '../workers/crypto.worker.ts?worker';
import { v4 as uuidv4 } from 'uuid';

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
    const id = uuidv4();
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
  const result = await sendToWorker<Uint8Array>('DERIVE_KEY', { password, salt: Array.from(salt) });
  return new Uint8Array(result);
};

/**
 * Mengenkripsi Private Keys (atau data sensitif lain)
 * Output: String (JSON representation of IV + Ciphertext)
 */
export const encryptWithKey = async (keyBytes: Uint8Array, data: any): Promise<string> => {
  return sendToWorker<string>('ENCRYPT_DATA', { keyBytes: Array.from(keyBytes), data });
};

/**
 * Mendekripsi Data
 * Output: Original Data (Object / String)
 */
export const decryptWithKey = async (keyBytes: Uint8Array, encryptedString: string): Promise<any> => {
  return sendToWorker<any>('DECRYPT_DATA', { keyBytes: Array.from(keyBytes), encryptedString });
};


// Define the type locally since the original file is gone.
export type RetrievedKeys = {
  encryption: Uint8Array;
  signing: Uint8Array;
  signedPreKey: Uint8Array;
  masterSeed?: Uint8Array;
};
export type RetrieveKeysResult =
  | { success: true; keys: RetrievedKeys }
  | { success: false; reason: 'incorrect_password' | 'legacy_bundle' | 'keys_not_found' | 'decryption_failed' | 'app_secret_missing' };


export async function getRecoveryPhrase(encryptedDataStr: string, password: string): Promise<string> {
  return sendToWorker('getRecoveryPhrase', { encryptedDataStr, password });
}

export async function registerAndGenerateKeys(password: string): Promise<{
  encryptionPublicKeyB64: string;
  signingPublicKeyB64: string;
  encryptedPrivateKeys: string;
  phrase: string;
}> {
  return sendToWorker('registerAndGenerateKeys', { password });
}

export async function generateNewKeys(password: string): Promise<{
    encryptionPublicKeyB64: string;
    signingPublicKeyB64: string;
    encryptedPrivateKeys: string;
}> {
  // This reuses the same worker logic as registration, but we only need a subset of the returned data.
  const { encryptionPublicKeyB64, signingPublicKeyB64, encryptedPrivateKeys } = await sendToWorker<{
    encryptionPublicKeyB64: string;
    signingPublicKeyB64: string;
    encryptedPrivateKeys: string;
  }>('registerAndGenerateKeys', { password });
  return { encryptionPublicKeyB64, signingPublicKeyB64, encryptedPrivateKeys };
}

export async function restoreFromPhrase(phrase: string, password: string): Promise<{
  encryptionPublicKeyB64: string,
  signingPublicKeyB64: string,
  encryptedPrivateKeys: string,
}> {
  return sendToWorker('restoreFromPhrase', { phrase, password });
}

export async function reEncryptBundleFromMasterKey(masterKey: Uint8Array, newPassword: string): Promise<{
  encryptedPrivateKeys: string;
  encryptionPublicKeyB64: string;
  signingPublicKeyB64: string;
}> {
  return sendToWorker('reEncryptBundleFromMasterKey', { masterKey: Array.from(masterKey), newPassword });
}

export async function retrievePrivateKeys(encryptedDataStr: string, password:string): Promise<RetrieveKeysResult> {
    const result = await sendToWorker<RetrieveKeysResult>('retrievePrivateKeys', { encryptedDataStr, password });
    if (result.success) {
      // Convert arrays back to Uint8Array
      return {
        ...result,
        keys: {
          encryption: new Uint8Array(result.keys.encryption),
          signing: new Uint8Array(result.keys.signing),
          signedPreKey: new Uint8Array(result.keys.signedPreKey),
          masterSeed: result.keys.masterSeed ? new Uint8Array(result.keys.masterSeed) : undefined,
        }
      };
    }
    return result;
}

export async function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): Promise<string> {
    return sendToWorker('generateSafetyNumber', { myPublicKey: Array.from(myPublicKey), theirPublicKey: Array.from(theirPublicKey) });
}

export function worker_generate_random_key(): Promise<Uint8Array> {
    return sendToWorker('generate_random_key', {});
}

// --- Internal Crypto Primitives Proxy Functions ---

export function worker_crypto_secretbox_xchacha20poly1305_easy(message: string | Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_easy', { message: typeof message === 'string' ? message : Array.from(message), nonce: Array.from(nonce), key: Array.from(key) });
}

export function worker_crypto_secretbox_xchacha20poly1305_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_open_easy', { ciphertext: Array.from(ciphertext), nonce: Array.from(nonce), key: Array.from(key) });
}

export function worker_crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal', { message: Array.from(message), publicKey: Array.from(publicKey) });
}

export function worker_crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal_open', { ciphertext: Array.from(ciphertext), publicKey: Array.from(publicKey), privateKey: Array.from(privateKey) });
}

export function worker_x3dh_initiator(payload: {
    myIdentityKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirSignedPreKey: Uint8Array,
    theirSigningKey: Uint8Array,
    signature: Uint8Array
}): Promise<{ sessionKey: Uint8Array, ephemeralPublicKey: string }> {
    return sendToWorker('x3dh_initiator', {
      myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
      theirIdentityKey: Array.from(payload.theirIdentityKey),
      theirSignedPreKey: Array.from(payload.theirSignedPreKey),
      theirSigningKey: Array.from(payload.theirSigningKey),
      signature: Array.from(payload.signature)
    });
}

export function worker_x3dh_recipient(payload: {
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirEphemeralKey: Uint8Array
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient', {
      myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
      mySignedPreKey: { privateKey: Array.from(payload.mySignedPreKey.privateKey) },
      theirIdentityKey: Array.from(payload.theirIdentityKey),
      theirEphemeralKey: Array.from(payload.theirEphemeralKey)
    });
}

export function worker_file_encrypt(fileBuffer: ArrayBuffer): Promise<{ encryptedData: ArrayBuffer, iv: Uint8Array, key: Uint8Array }> {
    return sendToWorker('file_encrypt', { fileBuffer });
}

export function worker_file_decrypt(combinedData: ArrayBuffer, keyBytes: Uint8Array): Promise<ArrayBuffer> {
    return sendToWorker('file_decrypt', { combinedData, keyBytes: Array.from(keyBytes) });
}