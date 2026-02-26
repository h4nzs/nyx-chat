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

export async function recoverAccountWithSignature(
  phrase: string, 
  newPassword: string, 
  identifier: string, 
  timestamp: number
): Promise<{
  encryptionPublicKeyB64: string,
  signingPublicKeyB64: string,
  encryptedPrivateKeys: string,
  signatureB64: string
}> {
  return sendToWorker('recoverAccountWithSignature', { phrase, newPassword, identifier, timestamp });
}

export async function encryptProfile(profileJsonString: string, profileKeyB64: string): Promise<string> {
  return sendToWorker('encryptProfile', { profileJsonString, profileKeyB64 });
}

export async function decryptProfile(encryptedProfileB64: string, profileKeyB64: string): Promise<string> {
  return sendToWorker('decryptProfile', { encryptedProfileB64, profileKeyB64 });
}

export async function generateProfileKey(): Promise<string> {
  return sendToWorker('generateProfileKey', {});
}

export async function minePoW(salt: string, difficulty: number): Promise<{ nonce: number; hash: string }> {
  return sendToWorker('minePoW', { salt, difficulty });
}

export async function hashUsername(username: string): Promise<string> {
  return sendToWorker('hashUsername', { username });
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
    signature: Uint8Array,
    theirOneTimePreKey?: Uint8Array // New: Optional OTPK from Bob
}): Promise<{ sessionKey: Uint8Array, ephemeralPublicKey: string }> {
    return sendToWorker('x3dh_initiator', {
      myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
      theirIdentityKey: Array.from(payload.theirIdentityKey),
      theirSignedPreKey: Array.from(payload.theirSignedPreKey),
      theirSigningKey: Array.from(payload.theirSigningKey),
      signature: Array.from(payload.signature),
      theirOneTimePreKey: payload.theirOneTimePreKey ? Array.from(payload.theirOneTimePreKey) : undefined
    });
}

export function worker_x3dh_recipient(payload: {
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirEphemeralKey: Uint8Array,
    myOneTimePreKey?: { privateKey: Uint8Array } // New: Optional OTPK Private Key
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient', {
      myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
      mySignedPreKey: { privateKey: Array.from(payload.mySignedPreKey.privateKey) },
      theirIdentityKey: Array.from(payload.theirIdentityKey),
      theirEphemeralKey: Array.from(payload.theirEphemeralKey),
      myOneTimePreKey: payload.myOneTimePreKey ? Array.from(payload.myOneTimePreKey.privateKey) : undefined
    });
}

export function worker_file_encrypt(fileBuffer: ArrayBuffer): Promise<{ encryptedData: ArrayBuffer, iv: Uint8Array, key: Uint8Array }> {
    return sendToWorker('file_encrypt', { fileBuffer });
}

export function worker_file_decrypt(combinedData: ArrayBuffer, keyBytes: Uint8Array): Promise<ArrayBuffer> {
    return sendToWorker('file_decrypt', { combinedData, keyBytes: Array.from(keyBytes) });
}

export function worker_encrypt_session_key(sessionKey: Uint8Array, masterSeed: Uint8Array): Promise<Uint8Array> {
    return sendToWorker('encrypt_session_key', { 
        sessionKey: Array.from(sessionKey), 
        masterSeed: Array.from(masterSeed) 
    });
}

export function worker_decrypt_session_key(encryptedKey: Uint8Array, masterSeed: Uint8Array): Promise<Uint8Array> {
    return sendToWorker('decrypt_session_key', { 
        encryptedKey: Array.from(encryptedKey), 
        masterSeed: Array.from(masterSeed) 
    });
}

export function worker_generate_otpk_batch(count: number, startId: number, masterSeed: Uint8Array): Promise<Array<{ keyId: number, publicKey: string, encryptedPrivateKey: Uint8Array }>> {
    return sendToWorker('generate_otpk_batch', { count, startId, masterSeed: Array.from(masterSeed) });
}

export function worker_x3dh_recipient_regenerate(payload: {
    keyId: number,
    masterSeed: Uint8Array,
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirEphemeralKey: Uint8Array
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient_regenerate', { 
        keyId: payload.keyId, 
        masterSeed: Array.from(payload.masterSeed),
        myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
        mySignedPreKey: { privateKey: Array.from(payload.mySignedPreKey.privateKey) },
        theirIdentityKey: Array.from(payload.theirIdentityKey),
        theirEphemeralKey: Array.from(payload.theirEphemeralKey)
    });
}

// --- DOUBLE RATCHET PROXY FUNCTIONS ---

export interface SerializedRatchetState {
    RK: string;
    CKs: string | null;
    CKr: string | null;
    DHs: { publicKey: string, privateKey: string };
    DHr: string | null;
    Ns: number;
    Nr: number;
    PN: number;
}

export function worker_dr_init_alice(payload: {
    sk: Uint8Array,
    theirSignedPreKeyPublic: Uint8Array
}): Promise<SerializedRatchetState> {
    return sendToWorker('dr_init_alice', { 
        sk: Array.from(payload.sk), 
        theirSignedPreKeyPublic: Array.from(payload.theirSignedPreKeyPublic) 
    });
}

export function worker_dr_init_bob(payload: {
    sk: Uint8Array,
    mySignedPreKey: { publicKey: Uint8Array, privateKey: Uint8Array },
    theirRatchetPublicKey: Uint8Array
}): Promise<SerializedRatchetState> {
    return sendToWorker('dr_init_bob', {
        sk: Array.from(payload.sk),
        mySignedPreKey: {
            publicKey: Array.from(payload.mySignedPreKey.publicKey),
            privateKey: Array.from(payload.mySignedPreKey.privateKey)
        },
        theirRatchetPublicKey: Array.from(payload.theirRatchetPublicKey)
    });
}

export function worker_dr_ratchet_encrypt(payload: {
    serializedState: SerializedRatchetState,
    plaintext: Uint8Array | string
}): Promise<{ state: SerializedRatchetState, header: any, ciphertext: Uint8Array, mk: Uint8Array }> {
    return sendToWorker<{ state: SerializedRatchetState, header: any, ciphertext: any, mk: any }>('dr_ratchet_encrypt', {
        serializedState: payload.serializedState,
        plaintext: typeof payload.plaintext === 'string' ? payload.plaintext : Array.from(payload.plaintext)
    }).then(res => ({
        ...res,
        ciphertext: new Uint8Array(res.ciphertext),
        mk: new Uint8Array(res.mk)
    }));
}

export function worker_dr_ratchet_decrypt(payload: {
    serializedState: SerializedRatchetState,
    header: any,
    ciphertext: Uint8Array
}): Promise<{ state: SerializedRatchetState, plaintext: Uint8Array, skippedKeys: { dh: string, n: number, mk: string }[], mk: Uint8Array }> {
    return sendToWorker<{ state: SerializedRatchetState, plaintext: any, skippedKeys: any[], mk: any }>('dr_ratchet_decrypt', {
        serializedState: payload.serializedState,
        header: payload.header,
        ciphertext: Array.from(payload.ciphertext)
    }).then(res => ({
        ...res,
        plaintext: new Uint8Array(res.plaintext),
        mk: new Uint8Array(res.mk)
    }));
}