// web/src/lib/crypto-worker-proxy.ts

// Create a new worker instance.
// The `?worker` query is a Vite-specific feature that bundles the script as a worker.
const worker = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), {
  type: 'module',
});

// A map to store resolvers for pending requests
const pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
let requestIdCounter = 0;

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


// Handle messages from the worker
worker.onmessage = (event: MessageEvent) => {
  const { type, id, result, error } = event.data;

  const promise = pendingRequests.get(id);
  if (!promise) return;

  if (type.endsWith('_result')) {
    promise.resolve(result);
  } else if (type === 'error') {
    promise.reject(new Error(error));
  }
  
  pendingRequests.delete(id);
};

/**
 * A generic function to call a command on the crypto worker.
 * @param type The command type to execute on the worker.
 * @param payload The data required for the command.
 * @returns A promise that resolves with the result from the worker.
 */
function callWorker<T = any>(type: string, payload: any): Promise<T> {
  const id = requestIdCounter++;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    
    // Pass the app secret to the worker for crypto operations
    const appSecret = import.meta.env.VITE_APP_SECRET;
    worker.postMessage({ type, payload: { ...payload, appSecret }, id });

    // Optional: Add a timeout to prevent promises from hanging indefinitely
    setTimeout(() => {
        if(pendingRequests.has(id)){
            reject(new Error(`Request ${type} with id ${id} timed out.`));
            pendingRequests.delete(id);
        }
    }, 30000); // 30 second timeout
  });
}

// --- Initialization ---
export const initializeCryptoWorker = () => callWorker('init', {});

export async function getRecoveryPhrase(encryptedDataStr: string, password: string): Promise<string> {
  return callWorker('getRecoveryPhrase', { encryptedDataStr, password });
}

export async function registerAndGenerateKeys(password: string): Promise<{
  encryptionPublicKeyB64: string;
  signingPublicKeyB64: string;
  encryptedPrivateKeys: string;
  phrase: string;
}> {
  return callWorker('registerAndGenerateKeys', { password });
}

export async function generateNewKeys(password: string): Promise<{
    encryptionPublicKeyB64: string;
    signingPublicKeyB64: string;
    encryptedPrivateKeys: string;
}> {
  // This reuses the same worker logic as registration, but we only need a subset of the returned data.
  const { encryptionPublicKeyB64, signingPublicKeyB64, encryptedPrivateKeys } = await callWorker('registerAndGenerateKeys', { password });
  return { encryptionPublicKeyB64, signingPublicKeyB64, encryptedPrivateKeys };
}

export async function restoreFromPhrase(phrase: string, password: string): Promise<{
  encryptionPublicKeyB64: string,
  signingPublicKeyB64: string,
  encryptedPrivateKeys: string,
}> {
  return callWorker('restoreFromPhrase', { phrase, password });
}

export async function reEncryptBundleFromMasterKey(masterKey: Uint8Array, newPassword: string): Promise<{
  encryptedPrivateKeys: string;
  encryptionPublicKeyB64: string;
  signingPublicKeyB64: string;
}> {
  return callWorker('reEncryptBundleFromMasterKey', { masterKey, newPassword });
}

export async function retrievePrivateKeys(encryptedDataStr: string, password:string): Promise<RetrieveKeysResult> {
    return callWorker('retrievePrivateKeys', { encryptedDataStr, password });
}

export async function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): Promise<string> {
    return callWorker('generateSafetyNumber', { myPublicKey, theirPublicKey });
}

// --- Internal Crypto Primitives Proxy Functions ---

export function worker_crypto_secretbox_easy(message: string | Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    return callWorker('crypto_secretbox_easy', { message, nonce, key });
}

export function worker_crypto_secretbox_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    return callWorker('crypto_secretbox_open_easy', { ciphertext, nonce, key });
}

export function worker_crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
    return callWorker('crypto_box_seal', { message, publicKey });
}

export function worker_crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    return callWorker('crypto_box_seal_open', { ciphertext, publicKey, privateKey });
}

export function worker_x3dh_initiator(payload: {
    myIdentityKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirSignedPreKey: Uint8Array,
    theirSigningKey: Uint8Array,
    signature: Uint8Array
}): Promise<{ sessionKey: Uint8Array, ephemeralPublicKey: string }> {
    return callWorker('x3dh_initiator', payload);
}

export function worker_x3dh_recipient(payload: {
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirEphemeralKey: Uint8Array
}): Promise<Uint8Array> {
    return callWorker('x3dh_recipient', payload);
}

export function worker_file_encrypt(fileBuffer: ArrayBuffer): Promise<{ encryptedData: ArrayBuffer, iv: Uint8Array, key: Uint8Array }> {
    return callWorker('file_encrypt', { fileBuffer });
}

export function worker_file_decrypt(combinedData: ArrayBuffer, keyBytes: Uint8Array): Promise<ArrayBuffer> {
    return callWorker('file_decrypt', { combinedData, keyBytes });
}
