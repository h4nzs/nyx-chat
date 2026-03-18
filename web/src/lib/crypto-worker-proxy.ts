// web/src/lib/crypto-worker-proxy.ts
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import CryptoWorker from '../workers/crypto.worker.ts?worker';
import type { DoubleRatchetState } from '../types/core';
import type { 
  CryptoBuffer, 
  SodiumKeyPair, 
  GroupRatchetState,
  GroupRatchetHeader,
  DoubleRatchetHeader
} from '../types/crypto-common';
import { v4 as uuidv4 } from 'uuid';

const worker = new CryptoWorker();
function toArray(buffer: CryptoBuffer): number[] {
    return Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}


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
export const deriveKeyFromPassword = async (password: string, salt: CryptoBuffer): Promise<Uint8Array> => {
  const result = await sendToWorker<Uint8Array>('DERIVE_KEY', { password, salt: Array.from(salt) });
  return new Uint8Array(result);
};

/**
 * Mengenkripsi Private Keys (atau data sensitif lain)
 * Output: String (JSON representation of IV + Ciphertext)
 */
export const encryptWithKey = async (keyBytes: CryptoBuffer, data: any): Promise<string> => {
  return sendToWorker<string>('ENCRYPT_DATA', { keyBytes: Array.from(keyBytes), data });
};

/**
 * Mendekripsi Data
 * Output: Original Data (Object / String)
 */
export const decryptWithKey = async (keyBytes: CryptoBuffer, encryptedString: string): Promise<any> => {
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
  timestamp: number,
  nonce: string
): Promise<{
  encryptionPublicKeyB64: string,
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

export function worker_crypto_secretbox_xchacha20poly1305_easy(message: string | CryptoBuffer, nonce: CryptoBuffer, key: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_easy', { message: typeof message === 'string' ? message : Array.from(message), nonce: Array.from(nonce), key: Array.from(key) });
}

export function worker_crypto_secretbox_xchacha20poly1305_open_easy(ciphertext: CryptoBuffer, nonce: CryptoBuffer, key: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_open_easy', { ciphertext: Array.from(ciphertext), nonce: Array.from(nonce), key: Array.from(key) });
}

export function worker_crypto_box_seal(message: CryptoBuffer, publicKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal', { message: Array.from(message), publicKey: Array.from(publicKey) });
}

export function worker_crypto_box_seal_open(ciphertext: CryptoBuffer, publicKey: CryptoBuffer, privateKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal_open', { ciphertext: Array.from(ciphertext), publicKey: Array.from(publicKey), privateKey: Array.from(privateKey) });
}

export function worker_x3dh_initiator(payload: {
    myIdentityKey: SodiumKeyPair,
    theirIdentityKey: CryptoBuffer,
    theirSignedPreKey: CryptoBuffer,
    theirSigningKey: CryptoBuffer,
    signature: CryptoBuffer,
    theirOneTimePreKey?: CryptoBuffer
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
    myIdentityKey: SodiumKeyPair,
    mySignedPreKey: SodiumKeyPair,
    theirIdentityKey: CryptoBuffer,
    theirEphemeralKey: CryptoBuffer,
    myOneTimePreKey?: SodiumKeyPair
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient', {
      myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
      mySignedPreKey: { privateKey: toArray(payload.mySignedPreKey.privateKey) },
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

export function worker_encrypt_session_key(sessionKey: Uint8Array, masterSeed: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('encrypt_session_key', { 
        sessionKey: Array.from(sessionKey), 
        masterSeed: Array.from(masterSeed) 
    });
}

export function worker_decrypt_session_key(encryptedKey: Uint8Array, masterSeed: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('decrypt_session_key', { 
        encryptedKey: Array.from(encryptedKey), 
        masterSeed: Array.from(masterSeed) 
    });
}

export function worker_generate_otpk_batch(count: number, startId: number, masterSeed: CryptoBuffer): Promise<Array<{ keyId: number, publicKey: string, encryptedPrivateKey: Uint8Array }>> {
    return sendToWorker('generate_otpk_batch', { count, startId, masterSeed: Array.from(masterSeed) });
}

export function worker_x3dh_recipient_regenerate(payload: {
    keyId: number,
    masterSeed: CryptoBuffer,
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    theirIdentityKey: Uint8Array,
    theirEphemeralKey: Uint8Array
}): Promise<Uint8Array> {
    return sendToWorker('x3dh_recipient_regenerate', { 
        keyId: payload.keyId, 
        masterSeed: Array.from(payload.masterSeed),
        myIdentityKey: { privateKey: Array.from(payload.myIdentityKey.privateKey) },
        mySignedPreKey: { privateKey: toArray(payload.mySignedPreKey.privateKey) },
        theirIdentityKey: Array.from(payload.theirIdentityKey),
        theirEphemeralKey: Array.from(payload.theirEphemeralKey)
    });
}

// --- DOUBLE RATCHET PROXY FUNCTIONS ---



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
    mySignedPreKey: { publicKey: Uint8Array, privateKey: Uint8Array },
    theirRatchetPublicKey: Uint8Array
}): Promise<DoubleRatchetState> {
    return sendToWorker('dr_init_bob', {
        sk: toArray(payload.sk),
        mySignedPreKey: {
            publicKey: toArray(payload.mySignedPreKey.publicKey!),
            privateKey: toArray(payload.mySignedPreKey.privateKey)
        },
        theirRatchetPublicKey: toArray(payload.theirRatchetPublicKey)
    });
}

export function worker_dr_ratchet_encrypt(payload: {
    serializedState: DoubleRatchetState,
    plaintext: CryptoBuffer | string
}): Promise<{ state: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: Uint8Array, mk: Uint8Array }> {
    return sendToWorker<{ state: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: any, mk: any }>('dr_ratchet_encrypt', {
        serializedState: payload.serializedState,
        plaintext: typeof payload.plaintext === 'string' ? payload.plaintext : Array.from(payload.plaintext)
    }).then(res => ({
        ...res,
        ciphertext: new Uint8Array(res.ciphertext),
        mk: new Uint8Array(res.mk)
    }));
}

export function worker_dr_ratchet_decrypt(payload: {
    serializedState: DoubleRatchetState,
    header: any,
    ciphertext: Uint8Array
}): Promise<{ state: DoubleRatchetState, plaintext: Uint8Array, skippedKeys: { dh: string, epk?: string, n: number, mk: string }[], mk: Uint8Array }> {
    return sendToWorker<{ state: DoubleRatchetState, plaintext: any, skippedKeys: any[], mk: any }>('dr_ratchet_decrypt', {
        serializedState: payload.serializedState,
        header: payload.header,
        ciphertext: Array.from(payload.ciphertext)
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
  return sendToWorker<{ state: GroupRatchetState, header: GroupRatchetHeader, ciphertext: any, signature: string, mk: any }>('group_ratchet_encrypt', { 
    serializedState, 
    plaintext: typeof plaintext === 'string' ? plaintext : Array.from(plaintext),
    signingPrivateKey: Array.from(signingPrivateKey) 
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
): Promise<{ state: GroupRatchetState, plaintext: Uint8Array, skippedKeys: any[], mk: Uint8Array }> {
  return sendToWorker<{ state: GroupRatchetState, plaintext: any, skippedKeys: any[], mk: any }>('group_ratchet_decrypt', { 
    serializedState, 
    header, 
    ciphertext: Array.from(ciphertext), 
    signature, 
    senderSigningPublicKey: Array.from(senderSigningPublicKey) 
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
  return sendToWorker<{ plaintext: any }>('group_decrypt_skipped', {
    mk,
    headerN,
    ciphertext: Array.from(ciphertext),
    signature,
    senderSigningPublicKey: Array.from(senderSigningPublicKey)
  }).then(res => ({
    plaintext: new Uint8Array(res.plaintext)
  }));
}