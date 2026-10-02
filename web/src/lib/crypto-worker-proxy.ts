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
const uuidv4 = () => crypto.randomUUID();

const worker = new CryptoWorker();

// Kirim buffer sebagai typed array langsung (structured clone efisien) —
// JANGAN konversi ke number[] (Array.from) karena sangat lambat & boros memori.
function asBuffer(buffer: CryptoBuffer): Uint8Array {
    return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

// Bungkus hasil ArrayBuffer/Uint8Array tanpa copy bila sudah berupa Uint8Array.
function asU8(value: unknown): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
}

// Map untuk nyimpen Promise yang nunggu balasan worker
interface PendingRequest {
  resolve: (val: unknown) => void;
  reject: (err: unknown) => void;
  startedAt: number;
  type: string;
  timeoutId?: ReturnType<typeof setTimeout>;
}
const pendingRequests = new Map<string, PendingRequest>();

worker.onmessage = (e) => {
  const { id, success, result, error } = e.data;
  const pending = pendingRequests.get(id);
  if (!pending) return;
  const { resolve, reject, startedAt, type, timeoutId } = pending;
  if (timeoutId) clearTimeout(timeoutId);
  if (import.meta.env.DEV) {
    const duration = performance.now() - startedAt;
    if (duration > 50) {
      console.debug(`[perf:crypto] ${type} roundtrip ${duration.toFixed(1)}ms`);
    }
  }
  if (success) resolve(result);
  else reject(new Error(error));
  pendingRequests.delete(id);
};

const DEFAULT_TIMEOUT_MS = 120000; // 2 menit (worker hang => reject, bukan hang selamanya)

function sendToWorker<T>(type: string, payload: unknown, transfer?: Transferable[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = uuidv4();
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Crypto worker timeout for ${type} after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: resolve as (val: unknown) => void,
      reject,
      startedAt: performance.now(),
      type,
      timeoutId
    });
    worker.postMessage({ id, type, payload }, transfer || []);
  });
}

// === PUBLIC API ===

/**
 * Membuat Key Encryption Key (KEK) dari Password User
 * Output: Uint8Array (32 bytes)
 */
export const deriveKeyFromPassword = async (password: string, salt: CryptoBuffer): Promise<Uint8Array> => {
  const result = await sendToWorker<Uint8Array>('DERIVE_KEY', { password, salt: asBuffer(salt) });
  return new Uint8Array(result);
};

/**
 * Mengenkripsi Private Keys (atau data sensitif lain)
 * Output: String (JSON representation of IV + Ciphertext)
 */
export const encryptWithKey = async (keyBytes: CryptoBuffer, data: unknown): Promise<string> => {
  return sendToWorker<string>('ENCRYPT_DATA', { keyBytes: asBuffer(keyBytes), data });
};

/**
 * Mendekripsi Data
 * Output: Original Data (Object / String)
 */
export const decryptWithKey = async (keyBytes: CryptoBuffer, encryptedString: string): Promise<unknown> => {
  return sendToWorker<unknown>('DECRYPT_DATA', { keyBytes: asBuffer(keyBytes), encryptedString });
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
  return sendToWorker('minePoW', { salt, difficulty }, undefined, 300000);
}

export async function hashUsername(username: string): Promise<string> {
  return sendToWorker('hashUsername', { username });
}

export async function reEncryptBundleFromMasterKey(masterKey: Uint8Array, newPassword: string): Promise<{
  encryptedPrivateKeys: string;
  encryptionPublicKeyB64: string;
  signingPublicKeyB64: string;
}> {
  return sendToWorker('reEncryptBundleFromMasterKey', { masterKey: asBuffer(masterKey), newPassword });
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
    return sendToWorker('generateSafetyNumber', { myPublicKey: asBuffer(myPublicKey), theirPublicKey: asBuffer(theirPublicKey) });
}

export function worker_generate_random_key(): Promise<Uint8Array> {
    return sendToWorker('generate_random_key', {});
}

// --- Internal Crypto Primitives Proxy Functions ---

export function worker_crypto_secretbox_xchacha20poly1305_easy(message: string | CryptoBuffer, nonce: CryptoBuffer, key: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_easy', { message: typeof message === 'string' ? message : asBuffer(message), nonce: asBuffer(nonce), key: asBuffer(key) });
}

export function worker_crypto_secretbox_xchacha20poly1305_open_easy(ciphertext: CryptoBuffer, nonce: CryptoBuffer, key: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_secretbox_xchacha20poly1305_open_easy', { ciphertext: asBuffer(ciphertext), nonce: asBuffer(nonce), key: asBuffer(key) });
}

export function worker_crypto_box_seal(message: CryptoBuffer, publicKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal', { message: asBuffer(message), publicKey: asBuffer(publicKey) });
}

export function worker_crypto_box_seal_open(ciphertext: CryptoBuffer, publicKey: CryptoBuffer, privateKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('crypto_box_seal_open', { ciphertext: asBuffer(ciphertext), publicKey: asBuffer(publicKey), privateKey: asBuffer(privateKey) });
}

export function worker_pq_box_seal(message: CryptoBuffer | string, pqPublicKey: CryptoBuffer, classicalPublicKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('pq_box_seal', { 
        message: typeof message === 'string' ? message : asBuffer(message), 
        pqPublicKey: asBuffer(pqPublicKey), 
        classicalPublicKey: asBuffer(classicalPublicKey) 
    });
}

export function worker_pq_box_seal_open(combinedPayload: CryptoBuffer, pqPrivateKey: CryptoBuffer, classicalPrivateKey: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('pq_box_seal_open', { 
        combinedPayload: asBuffer(combinedPayload), 
        pqPrivateKey: asBuffer(pqPrivateKey), 
        classicalPrivateKey: asBuffer(classicalPrivateKey) 
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
    pqSignature: CryptoBuffer,
    theirOneTimePreKey?: CryptoBuffer,
    theirPqOneTimePreKey?: CryptoBuffer
}): Promise<{ sessionKey: Uint8Array, initiatorCiphertexts: Uint8Array }> {
    return sendToWorker<{ sessionKey: ArrayBuffer, initiatorCiphertexts: ArrayBuffer }>('x3dh_initiator', {
      mySigningKey: { privateKey: asBuffer(payload.mySigningKey.privateKey) },
      theirIdentityKey: asBuffer(payload.theirIdentityKey),
      theirPqIdentityKey: payload.theirPqIdentityKey ? asBuffer(payload.theirPqIdentityKey) : undefined,
      theirSignedPreKey: asBuffer(payload.theirSignedPreKey),
      theirPqSignedPreKey: payload.theirPqSignedPreKey ? asBuffer(payload.theirPqSignedPreKey) : undefined,
      theirSigningKey: asBuffer(payload.theirSigningKey),
      signature: asBuffer(payload.signature),
      pqSignature: payload.pqSignature ? asBuffer(payload.pqSignature) : undefined,
      theirOneTimePreKey: payload.theirOneTimePreKey ? asBuffer(payload.theirOneTimePreKey) : undefined,
      theirPqOneTimePreKey: payload.theirPqOneTimePreKey ? asBuffer(payload.theirPqOneTimePreKey) : undefined
    }).then(res => ({
        sessionKey: asU8(res.sessionKey),
        initiatorCiphertexts: asU8(res.initiatorCiphertexts)
    }));
}

export function worker_x3dh_recipient(payload: {
    myIdentityKey: SodiumKeyPair,
    mySignedPreKey: SodiumKeyPair,
    myPqIdentityKey: SodiumKeyPair,
    myPqSignedPreKey: SodiumKeyPair,
    theirSigningKey: CryptoBuffer,
    initiatorCiphertexts: Uint8Array,
    myOneTimePreKey?: { privateKey: CryptoBuffer }
}): Promise<Uint8Array> {
    const transfer: Transferable[] = [payload.initiatorCiphertexts.buffer];
    
    return sendToWorker<ArrayBuffer>('x3dh_recipient', {
      myIdentityKey: { privateKey: asBuffer(payload.myIdentityKey.privateKey) },
      mySignedPreKey: { privateKey: asBuffer(payload.mySignedPreKey.privateKey) },
      myPqIdentityKey: { privateKey: asBuffer(payload.myPqIdentityKey.privateKey) },
      myPqSignedPreKey: { privateKey: asBuffer(payload.myPqSignedPreKey.privateKey) },
      theirSigningKey: asBuffer(payload.theirSigningKey),
      initiatorCiphertexts: payload.initiatorCiphertexts,
      myOneTimePreKey: payload.myOneTimePreKey ? { privateKey: asBuffer(payload.myOneTimePreKey.privateKey) } : undefined
    }, transfer).then(res => new Uint8Array(res));
}

export function worker_x3dh_recipient_regenerate(payload: {
    keyId: number,
    masterSeed: CryptoBuffer,
    myIdentityKey: { privateKey: Uint8Array },
    mySignedPreKey: { privateKey: Uint8Array },
    myPqIdentityKey: { privateKey: Uint8Array },
    myPqSignedPreKey: { privateKey: Uint8Array },
    theirSigningKey: CryptoBuffer,
    initiatorCiphertexts: Uint8Array
}): Promise<Uint8Array> {
    const transfer: Transferable[] = [payload.initiatorCiphertexts.buffer];

    return sendToWorker<ArrayBuffer>('x3dh_recipient_regenerate', { 
        keyId: payload.keyId, 
        masterSeed: asBuffer(payload.masterSeed),
        myIdentityKey: { privateKey: asBuffer(payload.myIdentityKey.privateKey) },
        mySignedPreKey: { privateKey: asBuffer(payload.mySignedPreKey.privateKey) },
        myPqIdentityKey: { privateKey: asBuffer(payload.myPqIdentityKey.privateKey) },
        myPqSignedPreKey: { privateKey: asBuffer(payload.myPqSignedPreKey.privateKey) },
        theirSigningKey: asBuffer(payload.theirSigningKey),
        initiatorCiphertexts: payload.initiatorCiphertexts
    }, transfer).then(res => new Uint8Array(res));
}

// --- LARGE FILE STREAMING PROXY FUNCTIONS ---

export async function worker_file_encrypt(fileBuffer: ArrayBuffer | Blob): Promise<{ combinedData: ArrayBuffer, key: Uint8Array }> {
    // Blob → ArrayBuffer lalu TRANSFER (zero-copy) ke worker — menghemat 1 salinan
    // penuh ukuran file. Blob caller tetap utuh (Blob immutable).
    const buffer = fileBuffer instanceof Blob ? await fileBuffer.arrayBuffer() : fileBuffer;
    return sendToWorker('file_encrypt', { fileBuffer: buffer }, [buffer], 600000);
}

export function worker_file_decrypt(combinedData: ArrayBuffer | Blob, keyBytes: Uint8Array): Promise<ArrayBuffer> {
    return sendToWorker('file_decrypt', { combinedData, keyBytes: asBuffer(keyBytes) }, undefined, 600000);
}

export function worker_encrypt_session_key(sessionKey: Uint8Array, masterSeed: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('encrypt_session_key', { 
        sessionKey: asBuffer(sessionKey), 
        masterSeed: asBuffer(masterSeed) 
    });
}

// --- CANONICAL XChaCha20-Poly1305 ENVELOPE (dedup 5 implementasi) ---

/**
 * Enkripsi string dengan XChaCha20-Poly1305.
 * Output: base64url(nonce(24) || ciphertext) — format kanonik NYX.
 */
export function workerXChaChaSeal(keyB64: string, plaintext: string): Promise<string> {
    return sendToWorker<string>('xchacha_seal', { keyB64, plaintext });
}

/**
 * Dekripsi payload dari workerXChaChaSeal. Melempar error bila format/autentikasi gagal.
 */
export function workerXChaChaOpen(keyB64: string, sealedB64: string): Promise<string> {
    return sendToWorker<string>('xchacha_open', { keyB64, sealedB64 });
}

/**
 * Panic password hash (Argon2id) — dijalankan di worker, bukan main thread.
 * Output: base64 (ORIGINAL variant) dari 32 byte hash — kompatibel dengan format lama.
 */
export function workerPanicHash(password: string, saltB64: string, iterations: number, memorySize: number, parallelism: number): Promise<string> {
    return sendToWorker<string>('panic_hash', { password, saltB64, iterations, memorySize, parallelism }, undefined, 120000);
}

export function worker_decrypt_session_key(encryptedKey: Uint8Array, masterSeed: CryptoBuffer): Promise<Uint8Array> {
    return sendToWorker('decrypt_session_key', { 
        encryptedKey: asBuffer(encryptedKey), 
        masterSeed: asBuffer(masterSeed) 
    });
}

export function worker_generate_otpk_batch(count: number, startId: number, masterSeed: CryptoBuffer): Promise<Array<{ keyId: number, publicKey: string, pqPublicKey?: string, encryptedPrivateKey: Uint8Array }>> {
    return sendToWorker('generate_otpk_batch', { count, startId, masterSeed: asBuffer(masterSeed) });
}

// --- POST-QUANTUM DOUBLE RATCHET PROXY FUNCTIONS ---

export function worker_dr_init_alice(payload: {
    sk: Uint8Array,
    theirPqSignedPreKeyPublic: Uint8Array
}): Promise<DoubleRatchetState> {
    return sendToWorker('dr_init_alice', {
        sk: asBuffer(payload.sk),
        theirPqSignedPreKeyPublic: asBuffer(payload.theirPqSignedPreKeyPublic)
    });
}

export function worker_dr_init_bob(payload: {
    sk: Uint8Array,
    myPqSignedPreKey: { publicKey: Uint8Array, privateKey: Uint8Array }
}): Promise<DoubleRatchetState> {
    return sendToWorker('dr_init_bob', {
        sk: asBuffer(payload.sk),
        myPqSignedPreKey: {
            publicKey: asBuffer(payload.myPqSignedPreKey.publicKey),
            privateKey: asBuffer(payload.myPqSignedPreKey.privateKey)
        }
    });
}
export function worker_dr_ratchet_encrypt(payload: {
    serializedState: DoubleRatchetState,
    plaintext: CryptoBuffer | string
}): Promise<{ state: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: Uint8Array, mk: Uint8Array }> {
    return sendToWorker<{ state: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: ArrayBuffer, mk: ArrayBuffer }>('dr_ratchet_encrypt', {
        serializedState: payload.serializedState,
        plaintext: typeof payload.plaintext === 'string' ? payload.plaintext : asBuffer(payload.plaintext)
    }).then(res => ({
        ...res,
        ciphertext: asU8(res.ciphertext),
        mk: asU8(res.mk)
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
        ciphertext: asBuffer(payload.ciphertext)
    }).then(res => ({
        ...res,
        plaintext: asU8(res.plaintext),
        mk: asU8(res.mk)
    }));
}

// --- GROUP RATCHET PROXY FUNCTIONS ---

export async function groupInitSenderKey(): Promise<{ senderKeyB64: string; chainIdB64: string; metadataKeyB64: string }> {
  return sendToWorker('group_init_sender_key', {});
}

export async function groupRatchetEncrypt(
  serializedState: GroupRatchetState,
  plaintext: string | CryptoBuffer,
  signingPrivateKey: CryptoBuffer
): Promise<{ state: GroupRatchetState, header: GroupRatchetHeader, ciphertext: Uint8Array, signature: string, mk: Uint8Array }> {
  return sendToWorker<{ state: GroupRatchetState, header: GroupRatchetHeader, ciphertext: ArrayBuffer, signature: string, mk: ArrayBuffer }>('group_ratchet_encrypt', { 
    serializedState, 
    plaintext: typeof plaintext === 'string' ? plaintext : asBuffer(plaintext),
    signingPrivateKey: asBuffer(signingPrivateKey) 
  }).then(res => ({
      ...res,
      ciphertext: asU8(res.ciphertext),
      mk: asU8(res.mk)
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
    ciphertext: asBuffer(ciphertext), 
    signature, 
    senderSigningPublicKey: asBuffer(senderSigningPublicKey) 
  }).then(res => ({
      ...res,
      plaintext: asU8(res.plaintext),
      mk: asU8(res.mk)
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
    ciphertext: asBuffer(ciphertext),
    signature,
    senderSigningPublicKey: asBuffer(senderSigningPublicKey)
  }).then(res => ({
    plaintext: asU8(res.plaintext)
  }));
}

// --- BURNER PROTOCOL (PQ-DR) PROXY FUNCTIONS ---

import type { BurnerDoubleRatchetState, BurnerDoubleRatchetHeader } from '../workers/crypto.worker';

export function worker_burner_dr_init_guest(payload: {
  hostClassicalPk: CryptoBuffer;
  hostPqPk: CryptoBuffer;
}): Promise<{ state: BurnerDoubleRatchetState; guestClassicalPk: string }> {
  return sendToWorker<{ state: BurnerDoubleRatchetState; guestClassicalPk: string }>('burner_dr_init_guest', {
    hostClassicalPk: asBuffer(payload.hostClassicalPk),
    hostPqPk: asBuffer(payload.hostPqPk)
  });
}

export function worker_burner_dr_init_host(payload: {
  guestClassicalPk: CryptoBuffer;
  hostClassicalSk: CryptoBuffer;
  savedCt: CryptoBuffer;
  hostPqSk: CryptoBuffer;
}): Promise<{ state: BurnerDoubleRatchetState }> {
  return sendToWorker<{ state: BurnerDoubleRatchetState }>('burner_dr_init_host', {
    guestClassicalPk: asBuffer(payload.guestClassicalPk),
    hostClassicalSk: asBuffer(payload.hostClassicalSk),
    savedCt: asBuffer(payload.savedCt),
    hostPqSk: asBuffer(payload.hostPqSk)
  });
}

export function worker_burner_dr_encrypt(payload: {
  state: BurnerDoubleRatchetState;
  plaintext: string | CryptoBuffer;
}): Promise<{ state: BurnerDoubleRatchetState; header: BurnerDoubleRatchetHeader; ciphertext: Uint8Array; mk: Uint8Array }> {
  return sendToWorker<{ state: BurnerDoubleRatchetState; header: BurnerDoubleRatchetHeader; ciphertext: ArrayBuffer; mk: ArrayBuffer }>('burner_dr_encrypt', {
    state: payload.state,
    plaintext: typeof payload.plaintext === 'string' ? payload.plaintext : asBuffer(payload.plaintext)
  }).then(res => ({
    ...res,
    ciphertext: new Uint8Array(res.ciphertext),
    mk: new Uint8Array(res.mk)
  }));
}

export function worker_burner_dr_decrypt(payload: {
  state: BurnerDoubleRatchetState;
  header: BurnerDoubleRatchetHeader;
  ciphertext: CryptoBuffer;
}): Promise<{ state: BurnerDoubleRatchetState; plaintext: Uint8Array; skippedKeys: { kemPk: string; n: number; mk: string }[]; mk: Uint8Array }> {
  return sendToWorker<{ state: BurnerDoubleRatchetState; plaintext: ArrayBuffer; skippedKeys: { kemPk: string; n: number; mk: string }[]; mk: ArrayBuffer }>('burner_dr_decrypt', {
    state: payload.state,
    header: payload.header,
    ciphertext: asBuffer(payload.ciphertext)
  }).then(res => ({
    ...res,
    plaintext: new Uint8Array(res.plaintext),
    mk: new Uint8Array(res.mk)
  }));
}
// [26.8.1] Blind RSA (RFC 9474) credential helpers — group membership.
// Server hanya melihat blinded message; finalisasi memakai `inv` yang tidak
// pernah meninggalkan klien.

export function worker_credential_blind(payload: {
  publicJwk: JsonWebKey;
  message: string;
}): Promise<{ preparedMsgB64: string; blindedMsgB64: string; inv: string }> {
  return sendToWorker<{ preparedMsgB64: string; blindedMsgB64: string; inv: string }>('credential_blind', payload);
}

export function worker_credential_finalize(payload: {
  publicJwk: JsonWebKey;
  preparedMsgB64: string;
  blindSigB64: string;
  inv: string;
}): Promise<{ preparedMsgB64: string; signatureB64: string }> {
  return sendToWorker<{ preparedMsgB64: string; signatureB64: string }>('credential_finalize', payload);
}
