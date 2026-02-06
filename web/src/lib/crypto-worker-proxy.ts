// web/src/lib/crypto-worker-proxy.ts

// Lazy initialization of the worker
let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), {
      type: 'module',
    });

    // Attach event handlers
    worker.onmessage = handleWorkerMessage;
    worker.onerror = handleWorkerError;
    worker.onmessageerror = handleWorkerMessageError;
  }
  return worker;
}

// A map to store resolvers for pending requests
const pendingRequests = new Map<number, { 
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timerId: number; 
}>();
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


// --- Worker Event Handlers ---

// Handle successfully processed messages from the worker
const handleWorkerMessage = (event: MessageEvent) => {
  try {
    // 1. Validate incoming data structure
    if (typeof event.data !== 'object' || event.data === null || typeof event.data.id === 'undefined' || !event.data.type) {
      console.warn("[Crypto Worker] Received malformed message:", event.data);
      return;
    }
    const { type, id, result, error } = event.data;

    // 2. Look up the pending promise
    const promise = pendingRequests.get(id);
    if (!promise) {
      // This can happen if the request timed out before the worker responded.
      console.warn(`[Crypto Worker] Received response for timed out or unknown request id: ${id}, type: ${type}`);
      return;
    }
    
    // 3. Clear the timeout now that we have a response.
    clearTimeout(promise.timerId);

    // 4. Handle message based on type
    if (type.endsWith('_result')) {
      promise.resolve(result);
    } else if (type === 'error') {
      promise.reject(new Error(error || 'An unknown error occurred in the crypto worker'));
    } else {
      // This case should ideally not be reached if the worker is well-behaved.
      const unexpectedError = new Error(`[Crypto Worker] Received unexpected message type '${type}' for request id: ${id}`);
      console.error(unexpectedError);
      promise.reject(unexpectedError);
    }
    
    // 5. Clean up the pending request
    pendingRequests.delete(id);

  } catch(e) {
    // Catch any synchronous errors within the handler itself
    console.error("[Crypto Worker] Error in onmessage handler:", e);
  }
};

// Handle unhandled exceptions in the worker
const handleWorkerError = (event: ErrorEvent) => {
  console.error(
    `[Crypto Worker] Unhandled Error: ${event.message}\n` +
    `  File: ${event.filename}\n` +
    `  Line: ${event.lineno}, Col: ${event.colno}\n`,
    event.error
  );
  
  // Reject all pending promises as the worker is in a broken state
  pendingRequests.forEach((promise) => {
    clearTimeout(promise.timerId);
    promise.reject(new Error("Crypto worker encountered an unrecoverable error."));
  });
  pendingRequests.clear();
  event.preventDefault(); // Prevent the default browser error handling (e.g., logging to console)
};

// Handle messages that can't be deserialized
const handleWorkerMessageError = (event: MessageEvent) => {
  console.error("[Crypto Worker] Failed to deserialize message:", event);
};


// --- Core Proxy Logic ---

/**
 * A generic function to call a command on the crypto worker.
 * @param type The command type to execute on the worker.
 * @param payload The data required for the command.
 * @returns A promise that resolves with the result from the worker.
 */
function callWorker<T = any>(type: string, payload: any): Promise<T> {
  const id = requestIdCounter++;
  return new Promise((resolve, reject) => {
    // Fail fast if VITE_APP_SECRET is missing for operations that need it.
    const appSecret = import.meta.env.VITE_APP_SECRET;
    if (type !== 'init' && type !== 'generateSafetyNumber' && !appSecret) {
      return reject(new Error("VITE_APP_SECRET is not defined."));
    }

    const timerId = window.setTimeout(() => {
      // The promise will be rejected, and we clean up the map entry.
      if (pendingRequests.has(id)) {
        reject(new Error(`Request '${type}' with id ${id} timed out.`));
        pendingRequests.delete(id);
      }
    }, 30000); // 30 second timeout

    pendingRequests.set(id, { resolve, reject, timerId });
    
    // Lazy get worker and post message
    getWorker().postMessage({ type, payload: { ...payload, appSecret }, id });
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

export function worker_generate_random_key(): Promise<Uint8Array> {
    return callWorker('generate_random_key', {});
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