// web/src/lib/crypto-worker-proxy.ts
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import CryptoWorker from '../workers/crypto.worker.ts?worker';
import type { DoubleRatchetState } from '@nyx/shared';
import type { 
  CryptoBuffer, 
  SodiumKeyPair, 
  GroupRatchetState,
  GroupRatchetHeader,
  DoubleRatchetHeader
} from '../types/crypto-common';
import { v4 as uuidv4 } from 'uuid';

const worker = new CryptoWorker();

// Utility function to safely convert any CryptoBuffer to an Array of numbers for postMessage
function toArray(buffer: CryptoBuffer): number[] {
    return Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

// Map untuk nyimpen Promise yang nunggu balasan worker
const pendingRequests = new Map<string, { resolve: (val: unknown) => void; reject: (err: unknown) => void }>();

worker.onmessage = (e) => {
  const { id, success, result, error } = e.data;
  if (pendingRequests.has(id)) {
    const { resolve, reject } = pendingRequests.get(id)!;
    if (success) resolve(result);
    else reject(new Error(error));
    pendingRequests.delete(id);
  }
};

function sendToWorker<T>(type: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = uuidv4();
    pendingRequests.set(id, { resolve: resolve as (val: unknown) => void, reject });
    worker.postMessage({ id, type, payload });
  });
}

// === PUBLIC API ===

/**
 * Membuat Key Encryption Key (KEK) dari Password User
 * Output: Uint8Array (32 bytes)
 */
export const deriveKeyFromPassword = async (password: string, salt: CryptoBuffer): Promise<Uint8Array> => {
  const result = await sendToWorker<Uint8Array>('DERIVE_KEY', { password, salt: toArray(salt) });
  return new Uint8Array(result);
};

/**
 * Mengenkripsi Private Keys (atau data sensitif lain)
 * Output: String (JSON representation of IV + Ciphertext)
 */
export const encryptWithKey = async (keyBytes: CryptoBuffer, data: unknown): Promise<string> => {
  return sendToWorker<string>('ENCRYPT_DATA', { keyBytes: toArray(keyBytes), data });
};

/**
 * Mendekripsi Data
 * Output: Original Data (Object / String)
 */
export const decryptWithKey = async (keyBytes: CryptoBuffer, encryptedString: string): Promise<unknown> => {
  return sendToWorker<unknown>('DECRYPT_DATA', { keyBytes: toArray(keyBytes), encryptedString });
};

// Define the type locally since the original file is gone.
export type RetrievedKeys = {
  encryption: Uint8Array;
  pqEncryption?: Uint8Array;
  signing: Uint8Array;
  signedPreKey: Uint8Array;
  pqSignedPreKey?: Uint8Array;
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
  pqEncryptionPublicKeyB64: string;
  signingPublicKeyB64: string;
  encryptedPrivateKeys: string;
  phrase: string;
}> {
  return sendToWorker('registerAndGenerateKeys', { password });
}

export async function generateNewKeys(password: string): Promise<{
    encryptionPublicKeyB64: string;
    pqEncryptionPublicKeyB64: string;
    signingPublicKeyB64: string;
    encryptedPrivateKeys: string;
}> {
  const { encryptionPublicKeyB64, pqEncryptionPublicKeyB64, signingPublicKeyB64, encryptedPrivateKeys } = await sendToWorker<{
    encryptionPublicKeyB64: string;
    pqEncryptionPublicKeyB64: string;
    signingPublicKeyB64: string;
    encryptedPrivateKeys: string;
  }>('registerAndGenerateKeys', { password });
  return { encryptionPublicKeyB64, pqEncryptionPublicKeyB64, signingPublicKeyB64, encryptedPrivateKeys };
}

export async function restoreFromPhrase(phrase: string, password: string): Promise<{
  encryptionPublicKeyB64: string,
  pqEncryptionPublicKeyB64: string,
  signingPublicKeyB64: string,
  encryptedPrivateKeys: string,
}> {
  return sendToWorker('restoreFromPhrase', { phrase, password });
}

export async function recoverAccountWithSignature(
  phrase: string,
  newPassword: string,
  identifier: string,
  timestamp: number,
  nonce: string
): Promise<{
  encryptionPublicKeyB64: string,
  pqEncryptionPublicKeyB64: string,
  signingPublicKeyB64: string,
  encryptedPrivateKeys: string,
  signatureB64: string
}> {
  return sendToWorker('recoverAccountWithSignature', { phrase, newPassword, identifier, timestamp, nonce });
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
  return sendToWorker('reEncryptBundleFromMasterKey', { masterKey: toArray(masterKey), newPassword });
}

export async function retrievePrivateKeys(encryptedDataStr: string, password:string): Promise<RetrieveKeysResult> {
    const result = await sendToWorker<RetrieveKeysResult>('retrievePrivateKeys', { encryptedDataStr, password });
    if (result.success) {
      return {
        ...result,
        keys: {
          encryption: new Uint8Array(result.keys.encryption),
          pqEncryption: result.keys.pqEncryption ? new Uint8Array(result.keys.pqEncryption) : undefined,
          signing: new Uint8Array(result.keys.signing),
          signedPreKey: new Uint8Array(result.keys.signedPreKey),
          pqSignedPreKey: result.keys.pqSignedPreKey ? new Uint8Array(result.keys.pqSignedPreKey) : undefined,
          masterSeed: result.keys.masterSeed ? new Uint8Array(result.keys.masterSeed) : undefined,
        }
      };
    }
    return result;
}

export async function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): Promise<string> {
    return sendToWorker('generateSafetyNumber', { myPublicKey: toArray(myPublicKey), theirPublicKey: toArray(theirPublicKey) });
}

export function worker_generate_random_key(): Promise<Uint8Array> {
    return sendToWorker('generate_random_key', {});
}

// --- Internal Crypto Primitives Proxy Functions ---

export function worker_crypto_secretbox_xchacha20poly1305_easy(message: string | CryptoBuffer, nonce: CryptoBuffer, key: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_easy', { message: typeof message === 'string' ? message : toArray(message), nonce: toArray(nonce), key: toArray(key) });
}

export function worker_crypto_secretbox_xchacha20poly1305_open_easy(ciphertext: CryptoBuffer, nonce: CryptoBuffer, key: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_open_easy', { ciphertext: toArray(ciphertext), nonce: toArray(nonce), key: toArray(key) });
}

export function worker_crypto_box_seal(message: CryptoBuffer, publicKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal', { message: toArray(message), publicKey: toArray(publicKey) });
}

export function worker_crypto_box_seal_open(ciphertext: CryptoBuffer, publicKey: CryptoBuffer, privateKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal_open', { ciphertext: toArray(ciphertext), publicKey: toArray(publicKey), privateKey: toArray(privateKey) });
}

export function worker_pq_box_seal(message: CryptoBuffer | string, pqPublicKey: CryptoBuffer, classicalPublicKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('pq_box_seal', { 
        message: typeof message === 'string' ? message : toArray(message), 
        pqPublicKey: toArray(pqPublicKey), 
        classicalPublicKey: toArray(classicalPublicKey) 
    });
}

export function worker_pq_box_seal_open(combinedPayload: CryptoBuffer, pqPrivateKey: CryptoBuffer, classicalPrivateKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('pq_box_seal_open', { 
        combinedPayload: toArray(combinedPayload), 
        pqPrivateKey: toArray(pqPrivateKey), 
        classicalPrivateKey: toArray(classicalPrivateKey) 
    });
}

// --- PQ-X3DH INITIALIZATION PROXY FUNCTIONS ---

export function worker_x3dh_initiator(payload: {
    mySigningKey: SodiumKeyPair,
    theirIdentityKey: CryptoBuffer,
    theirPqIdentityKey: CryptoBuffer,
    theirSignedPreKey: CryptoBuffer,
    theirPqSignedPreKey: CryptoBuffer,
    theirSigningKey: CryptoBuffer,
    signature: CryptoBuffer,
    theirOneTimePreKey?: CryptoBuffer,
    theirPqOneTimePreKey?: CryptoBuffer
}): Promise<{ sessionKey: Uint8Array, initiatorCiphertexts: string }> {
    return sendToWorker('x3dh_initiator', {
      mySigningKey: { privateKey: toArray(payload.mySigningKey.privateKey) },
      theirIdentityKey: toArray(payload.theirIdentityKey),
      theirPqIdentityKey: toArray(payload.theirPqIdentityKey),
      theirSignedPreKey: toArray(payload.theirSignedPreKey),
      theirPqSignedPreKey: toArray(payload.theirPqSignedPreKey),
      theirSigningKey: toArray(payload.theirSigningKey),
      signature: toArray(payload.signature),
      theirOneTimePreKey: payload.theirOneTimePreKey ? toArray(payload.theirOneTimePreKey) : undefined,
      theirPqOneTimePreKey: payload.theirPqOneTimePreKey ? toArray(payload.theirPqOneTimePreKey) : undefined
    });
}

export function worker_x3dh_recipient(payload: {
    myIdentityKey: SodiumKeyPair,
    mySignedPreKey: SodiumKeyPair,
    myPqIdentityKey: SodiumKeyPair,
    myPqSignedPreKey: SodiumKeyPair,
    theirSigningKey: CryptoBuffer,
    initiatorCiphertexts: string,
    myOneTimePreKey?: { privateKey: CryptoBuffer }
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient', {
      myIdentityKey: { privateKey: toArray(payload.myIdentityKey.privateKey) },
      mySignedPreKey: { privateKey: toArray(payload.mySignedPreKey.privateKey) },
      myPqIdentityKey: { privateKey: toArray(payload.myPqIdentityKey.privateKey) },
      myPqSignedPreKey: { privateKey: toArray(payload.myPqSignedPreKey.privateKey) },
      theirSigningKey: toArray(payload.theirSigningKey),
      initiatorCiphertexts: payload.initiatorCiphertexts,
      myOneTimePreKey: payload.myOneTimePreKey ? { privateKey: toArray(payload.myOneTimePreKey.privateKey) } : undefined
    });
}

export function worker_x3dh_recipient_regenerate(payload: {
    keyId: number,
    masterSeed: CryptoBuffer,
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    myPqIdentityKey: { privateKey: Uint8Array },
    myPqSignedPreKey: { privateKey: Uint8Array },
    theirSigningKey: CryptoBuffer,
    initiatorCiphertexts: string
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient_regenerate', { 
        keyId: payload.keyId, 
        masterSeed: toArray(payload.masterSeed),
        myIdentityKey: { privateKey: toArray(payload.myIdentityKey.privateKey) },
        mySignedPreKey: { privateKey: toArray(payload.mySignedPreKey.privateKey) },
        myPqIdentityKey: { privateKey: toArray(payload.myPqIdentityKey.privateKey) },
        myPqSignedPreKey: { privateKey: toArray(payload.myPqSignedPreKey.privateKey) },
        theirSigningKey: toArray(payload.theirSigningKey),
        initiatorCiphertexts: payload.initiatorCiphertexts
    });
}

// --- LARGE FILE STREAMING PROXY FUNCTIONS ---

export function worker_file_encrypt(fileBuffer: ArrayBuffer): Promise<{ combinedData: ArrayBuffer, key: Uint8Array }> {
    return sendToWorker('file_encrypt', { fileBuffer });
}

export function worker_file_decrypt(combinedData: ArrayBuffer, keyBytes: Uint8Array): Promise<ArrayBuffer> {
    return sendToWorker('file_decrypt', { combinedData, keyBytes: toArray(keyBytes) });
}

export function worker_encrypt_session_key(sessionKey: Uint8Array, masterSeed: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('encrypt_session_key', { 
        sessionKey: toArray(sessionKey), 
        masterSeed: toArray(masterSeed) 
    });
}

export function worker_decrypt_session_key(encryptedKey: Uint8Array, masterSeed: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('decrypt_session_key', { 
        encryptedKey: toArray(encryptedKey), 
        masterSeed: toArray(masterSeed) 
    });
}

export function worker_generate_otpk_batch(count: number, startId: number, masterSeed: CryptoBuffer): Promise<Array<{ keyId: number, publicKey: string, pqPublicKey?: string, encryptedPrivateKey: Uint8Array }>> {
    return sendToWorker('generate_otpk_batch', { count, startId, masterSeed: toArray(masterSeed) });
}

// --- POST-QUANTUM DOUBLE RATCHET PROXY FUNCTIONS ---

export function worker_dr_init_alice(payload: {
    sk: Uint8Array,
    theirSignedPreKeyPublic: Uint8Array
}): Promise<DoubleRatchetState> {
    return sendToWorker('dr_init_alice', { 
        sk: toArray(payload.sk), 
        theirSignedPreKeyPublic: toArray(payload.theirSignedPreKeyPublic) 
    });
}

export function worker_dr_init_bob(payload: {
    sk: Uint8Array,
    mySignedPreKey: { publicKey: Uint8Array, privateKey: Uint8Array }
}): Promise<DoubleRatchetState> {
    return sendToWorker('dr_init_bob', {
        sk: toArray(payload.sk),
        mySignedPreKey: {
            publicKey: toArray(payload.mySignedPreKey.publicKey),
            privateKey: toArray(payload.mySignedPreKey.privateKey)
        }
    });
}

export function worker_dr_ratchet_encrypt(payload: {
    serializedState: DoubleRatchetState,
    plaintext: CryptoBuffer | string
}): Promise<{ state: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: Uint8Array, mk: Uint8Array }> {
    return sendToWorker<{ state: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: ArrayBuffer, mk: ArrayBuffer }>('dr_ratchet_encrypt', {
        serializedState: payload.serializedState,
        plaintext: typeof payload.plaintext === 'string' ? payload.plaintext : toArray(payload.plaintext)
    }).then(res => ({
        ...res,
        ciphertext: new Uint8Array(res.ciphertext),
        mk: new Uint8Array(res.mk)
    }));
}

export function worker_dr_ratchet_decrypt(payload: {
    serializedState: DoubleRatchetState,
    header: DoubleRatchetHeader,
    ciphertext: Uint8Array
}): Promise<{ state: DoubleRatchetState, plaintext: Uint8Array, skippedKeys: { kemPk: string, n: number, mk: string }[], mk: Uint8Array }> {
    return sendToWorker<{ state: DoubleRatchetState, plaintext: ArrayBuffer, skippedKeys: { kemPk: string, n: number, mk: string }[], mk: ArrayBuffer }>('dr_ratchet_decrypt', {
        serializedState: payload.serializedState,
        header: payload.header,
        ciphertext: toArray(payload.ciphertext)
    }).then(res => ({
        ...res,
        plaintext: new Uint8Array(res.plaintext),
        mk: new Uint8Array(res.mk)
    }));
}

// --- GROUP RATCHET PROXY FUNCTIONS ---

export async function groupInitSenderKey(): Promise<{ senderKeyB64: string }> {
  return sendToWorker('group_init_sender_key', {});
}

export async function groupRatchetEncrypt(
  serializedState: GroupRatchetState,
  plaintext: string | CryptoBuffer,
  signingPrivateKey: CryptoBuffer
): Promise<{ state: GroupRatchetState, header: GroupRatchetHeader, ciphertext: Uint8Array, signature: string, mk: Uint8Array }> {
  return sendToWorker<{ state: GroupRatchetState, header: GroupRatchetHeader, ciphertext: ArrayBuffer, signature: string, mk: ArrayBuffer }>('group_ratchet_encrypt', { 
    serializedState, 
    plaintext: typeof plaintext === 'string' ? plaintext : toArray(plaintext),
    signingPrivateKey: toArray(signingPrivateKey) 
  }).then(res => ({
      ...res,
      ciphertext: new Uint8Array(res.ciphertext),
      mk: new Uint8Array(res.mk)
  }));
}

export async function groupRatchetDecrypt(
  serializedState: GroupRatchetState,
  header: GroupRatchetHeader,
  ciphertext: CryptoBuffer,
  signature: string,
  senderSigningPublicKey: CryptoBuffer
): Promise<{ state: GroupRatchetState, plaintext: Uint8Array, skippedKeys: { n: number; mk: string }[], mk: Uint8Array }> {
  return sendToWorker<{ state: GroupRatchetState, plaintext: ArrayBuffer, skippedKeys: { n: number; mk: string }[], mk: ArrayBuffer }>('group_ratchet_decrypt', { 
    serializedState, 
    header, 
    ciphertext: toArray(ciphertext), 
    signature, 
    senderSigningPublicKey: toArray(senderSigningPublicKey) 
  }).then(res => ({
      ...res,
      plaintext: new Uint8Array(res.plaintext),
      mk: new Uint8Array(res.mk)
  }));
}

export async function groupDecryptSkipped(
  mk: string,
  headerN: number,
  ciphertext: CryptoBuffer,
  signature: string,
  senderSigningPublicKey: CryptoBuffer
): Promise<{ plaintext: Uint8Array }> {
  return sendToWorker<{ plaintext: ArrayBuffer }>('group_decrypt_skipped', {
    mk,
    headerN,
    ciphertext: toArray(ciphertext),
    signature,
    senderSigningPublicKey: toArray(senderSigningPublicKey)
  }).then(res => ({
    plaintext: new Uint8Array(res.plaintext)
  }));
}