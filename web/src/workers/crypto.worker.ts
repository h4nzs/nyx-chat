// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// web/src/workers/crypto.worker.ts
import type _sodium from 'libsodium-wrappers';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { argon2id } from 'hash-wasm';
import type { DoubleRatchetState } from '@nyx/shared';
import type { 
  CryptoBuffer, 
  SodiumKeyPair, 
  GroupRatchetState, 
  GroupRatchetHeader,
  DoubleRatchetHeader
} from '../types/crypto-common';

import { getSodium } from '../lib/sodiumInitializer';

let sodium: Awaited<ReturnType<typeof getSodium>>;
let isReady = false;

const B64_VARIANT = 'URLSAFE_NO_PADDING';

// Konfigurasi Argon2
const ARGON_VAULT_CONFIG = {
  parallelism: 1,
  iterations: 4,
  memorySize: 131072, // 128 MB
  hashLength: 32,
  outputType: 'binary' as const,
};

const ARGON_INDEX_CONFIG = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MB
  hashLength: 32,
  outputType: 'binary' as const,
};

async function ensureSodiumReady() {
  if (isReady && sodium) return;
  sodium = await getSodium();
  isReady = true;
}

// --- INTERNAL HELPER FUNCTIONS FOR CORE CRYPTO LOGIC ---

export async function kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  await ensureSodiumReady();
  const messageKeyInput = new Uint8Array([0x01]);
  const newChainKeyInput = new Uint8Array([0x02]);

  const messageKey = sodium.crypto_generichash(32, messageKeyInput, chainKey);
  const newChainKey = sodium.crypto_generichash(32, newChainKeyInput, chainKey);

  return [newChainKey, messageKey];
}

async function _deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({
    ...ARGON_VAULT_CONFIG,
    password,
    salt,
  });
}

async function _stretchSeed(seed: Uint8Array): Promise<Uint8Array> {
  const password = sodium.to_hex(seed);
  const salt = new TextEncoder().encode("NYX_STRETCH_V1");
  return argon2id({
    ...ARGON_VAULT_CONFIG,
    password,
    salt,
  });
}

async function _encryptData(keyBytes: Uint8Array, data: unknown): Promise<string> {
  try {
    const iv = sodium.randombytes_buf(24);
    const encodedData = new TextEncoder().encode(JSON.stringify(data));

    const encryptedContent = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      encodedData,
      null,
      null,
      iv,
      keyBytes
    );

    return JSON.stringify({
      iv: Array.from(iv),
      data: Array.from(encryptedContent)
    });
  } finally {
    if (keyBytes && keyBytes.length > 0) {
      try {
        sodium.memzero(keyBytes);
      } catch (_e) {
        keyBytes.fill(0);
      }
    }
  }
}

async function _decryptData(keyBytes: Uint8Array, encryptedString: string): Promise<unknown> {
  try {
    const parsed = JSON.parse(encryptedString) as { iv: number[], data: number[] };
    const { iv: ivArr, data: dataArr } = parsed;
    const iv = new Uint8Array(ivArr);
    const ciphertext = new Uint8Array(dataArr);

    const decryptedContent = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      iv,
      keyBytes
    );

    const decryptedString = new TextDecoder().decode(decryptedContent);
    try {
      return JSON.parse(decryptedString);
    } catch {
      return decryptedString;
    }
  } finally {
    if (keyBytes && keyBytes.length > 0) {
      try {
        sodium.memzero(keyBytes);
      } catch (_e) {
        keyBytes.fill(0);
      }
    }
  }
}

// --- REFACTORED HELPER FUNCTIONS ---

function exportPublicKey(publicKey: Uint8Array): string {
  return sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
}

async function storePrivateKeys(keys: {
  encryption: Uint8Array,
  pqEncryption?: Uint8Array,
  signing: Uint8Array,
  signedPreKey: Uint8Array,
  pqSignedPreKey?: Uint8Array,
  masterSeed?: Uint8Array
}, password: string): Promise<string> {
  const privateKeysObj = {
    encryption: sodium.to_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
    pqEncryption: keys.pqEncryption ? sodium.to_base64(keys.pqEncryption, sodium.base64_variants[B64_VARIANT]) : undefined,
    signing: sodium.to_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
    signedPreKey: sodium.to_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
    pqSignedPreKey: keys.pqSignedPreKey ? sodium.to_base64(keys.pqSignedPreKey, sodium.base64_variants[B64_VARIANT]) : undefined,
    masterSeed: keys.masterSeed ? sodium.to_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
  };

  const salt = sodium.randombytes_buf(16);
  let kek: Uint8Array | null = null;

  try {
    kek = await _deriveKey(password, salt);
    const encryptedData = await _encryptData(kek, privateKeysObj);
    return sodium.to_base64(salt, sodium.base64_variants[B64_VARIANT]) + '.' + encryptedData;
  } finally {
    if (kek) {
      try { sodium.memzero(kek); } catch { kek.fill(0); }
    }
    try { sodium.memzero(salt); } catch { salt.fill(0); }
  }
}

type RetrievedKeys = {
  encryption: Uint8Array,
  pqEncryption?: Uint8Array,
  signing: Uint8Array,
  signedPreKey: Uint8Array,
  pqSignedPreKey?: Uint8Array,
  masterSeed?: Uint8Array
};

type RetrieveKeysResult =
  | { success: true; keys: RetrievedKeys }
  | { success: false; reason: 'incorrect_password' | 'legacy_bundle' | 'keys_not_found' | 'decryption_failed' | 'app_secret_missing' };

async function retrievePrivateKeys(encryptedDataWithSaltStr: string, password: string): Promise<RetrieveKeysResult> {
    let kek: Uint8Array | null = null;
    try {
      if (!encryptedDataWithSaltStr) return { success: false, reason: 'keys_not_found' };

      const parts = encryptedDataWithSaltStr.split('.');
      if (parts.length !== 2) return { success: false, reason: 'decryption_failed' };

      const salt = sodium.from_base64(parts[0], sodium.base64_variants[B64_VARIANT]);
      const encryptedString = parts[1];
      
      kek = await _deriveKey(password, salt);
      const privateKeysRaw = await _decryptData(kek, encryptedString);

      const privateKeysObj = typeof privateKeysRaw === 'string' 
        ? JSON.parse(privateKeysRaw) 
        : privateKeysRaw;

      const keys = privateKeysObj as { encryption: string; pqEncryption?: string; signing: string; signedPreKey: string; pqSignedPreKey?: string; masterSeed?: string };
      if (!keys.signedPreKey || !keys.pqEncryption || !keys.pqSignedPreKey) return { success: false, reason: 'legacy_bundle' };

      return {
        success: true,
        keys: {
          encryption: sodium.from_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
          pqEncryption: sodium.from_base64(keys.pqEncryption, sodium.base64_variants[B64_VARIANT]),
          signing: sodium.from_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
          signedPreKey: sodium.from_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
          pqSignedPreKey: sodium.from_base64(keys.pqSignedPreKey, sodium.base64_variants[B64_VARIANT]),
          masterSeed: keys.masterSeed ? sodium.from_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
        }
      };
    } catch (error: unknown) {
      console.error("Failed to retrieve private keys:", error);
      return { success: false, reason: 'incorrect_password' };
    } finally {
      if (kek) {
        try { sodium.memzero(kek); } catch { kek.fill(0); }
      }
    }
}

function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): string {
    let combined;
    if (sodium.compare(myPublicKey, theirPublicKey) < 0) {
      combined = new Uint8Array(myPublicKey.length + theirPublicKey.length);
      combined.set(myPublicKey, 0);
      combined.set(theirPublicKey, myPublicKey.length);
    } else {
      combined = new Uint8Array(myPublicKey.length + theirPublicKey.length);
      combined.set(theirPublicKey, 0);
      combined.set(myPublicKey, theirPublicKey.length);
    }
  
    const hash = sodium.crypto_generichash(64, combined, null);
  
    const fingerprint = sodium.to_hex(hash.slice(0, 30));
    const chunks = fingerprint.match(/.{1,10}/g) || [];
    const digitGroups = chunks.map((chunk: string) => parseInt(chunk, 16).toString().padStart(5, '0').slice(-5));
    
    return digitGroups.join(' ');
}

// --- STATE HELPERS ---

function b64ToBytes(str: string | null | undefined): Uint8Array | null {
  return str ? sodium.from_base64(str, sodium.base64_variants.URLSAFE_NO_PADDING) : null;
}

function bytesToB64(bytes: Uint8Array | null | undefined): string | null {
  return bytes ? sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING) : null;
}

// --- PQ-DR STATE HELPERS ---

interface RuntimeDoubleRatchetState {
  KEMs: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  KEMr: Uint8Array | null;
  savedCt: Uint8Array | null;
  RK: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  messageCount?: number;
  lastActivityTime?: number;
}

function deserializeState(serialized: DoubleRatchetState): RuntimeDoubleRatchetState {
  return {
    KEMs: serialized.KEMs ? {
      publicKey: sodium.from_base64(serialized.KEMs.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      privateKey: sodium.from_base64(serialized.KEMs.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING)
    } : null,
    KEMr: b64ToBytes(serialized.KEMr),
    savedCt: b64ToBytes(serialized.savedCt),
    RK: b64ToBytes(serialized.RK),
    CKs: b64ToBytes(serialized.CKs),
    CKr: b64ToBytes(serialized.CKr),
    Ns: serialized.Ns,
    Nr: serialized.Nr,
    PN: serialized.PN
  };
}

function serializeState(runtime: RuntimeDoubleRatchetState): DoubleRatchetState {
  return {
    KEMs: runtime.KEMs ? {
      publicKey: sodium.to_base64(runtime.KEMs.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      privateKey: sodium.to_base64(runtime.KEMs.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING)
    } : null,
    KEMr: bytesToB64(runtime.KEMr),
    savedCt: bytesToB64(runtime.savedCt),
    RK: bytesToB64(runtime.RK),
    CKs: bytesToB64(runtime.CKs),
    CKr: bytesToB64(runtime.CKr),
    Ns: runtime.Ns,
    Nr: runtime.Nr,
    PN: runtime.PN,
    messageCount: runtime.messageCount,
    lastActivityTime: runtime.lastActivityTime
  };
}

// --- MAIN MESSAGE HANDLER ---

export interface BurnerDoubleRatchetState {
  RK: string | null;
  CKs: string | null;
  CKr: string | null;
  KEMs_pub: string | null;
  KEMs_priv: string | null;
  KEMr: string | null;
  savedCt: string | null;
  Ns: number;
  Nr: number;
  PN: number;
}

export interface BurnerDoubleRatchetHeader {
  kemPk: string;
  ct: string;
  n: number;
  pn: number;
}

export type WorkerMessage =
  | { type: 'DERIVE_KEY'; payload: { password: string; salt: CryptoBuffer }; id: string }
  | { type: 'ENCRYPT_DATA'; payload: { keyBytes: CryptoBuffer; data: unknown }; id: string }
  | { type: 'DECRYPT_DATA'; payload: { keyBytes: CryptoBuffer; encryptedString: string }; id: string }
  | { type: 'registerAndGenerateKeys'; payload: { password: string }; id: string }
  | { type: 'retrievePrivateKeys'; payload: { encryptedDataStr: string; password: string }; id: string }
  | { type: 'generateSafetyNumber'; payload: { myPublicKey: CryptoBuffer; theirPublicKey: CryptoBuffer }; id: string }
  | { type: 'crypto_secretbox_xchacha20poly1305_easy'; payload: { message: string | CryptoBuffer; nonce: CryptoBuffer; key: CryptoBuffer }; id: string }
  | { type: 'crypto_secretbox_xchacha20poly1305_open_easy'; payload: { ciphertext: CryptoBuffer; nonce: CryptoBuffer; key: CryptoBuffer }; id: string }
  | { type: 'crypto_box_seal_open'; payload: { ciphertext: CryptoBuffer; publicKey: CryptoBuffer; privateKey: CryptoBuffer }; id: string }
  | { type: 'pq_box_seal'; payload: { message: CryptoBuffer | string; pqPublicKey: CryptoBuffer; classicalPublicKey: CryptoBuffer }; id: string }
  | { type: 'pq_box_seal_open'; payload: { combinedPayload: CryptoBuffer; pqPrivateKey: CryptoBuffer; classicalPrivateKey: CryptoBuffer }; id: string }
  | { type: 'x3dh_initiator'; payload: { mySigningKey: SodiumKeyPair; theirIdentityKey: CryptoBuffer; theirPqIdentityKey: CryptoBuffer; theirSignedPreKey: CryptoBuffer; theirPqSignedPreKey: CryptoBuffer; theirSigningKey: CryptoBuffer; signature: CryptoBuffer; pqSignature: CryptoBuffer; theirOneTimePreKey?: CryptoBuffer; theirPqOneTimePreKey?: CryptoBuffer }; id: string }
  | { type: 'x3dh_recipient'; payload: { myIdentityKey: SodiumKeyPair; mySignedPreKey: SodiumKeyPair; myPqIdentityKey: SodiumKeyPair; myPqSignedPreKey: SodiumKeyPair; theirSigningKey: CryptoBuffer; initiatorCiphertexts: string; myOneTimePreKey?: { privateKey: CryptoBuffer } }; id: string }
  | { type: 'crypto_box_seal'; payload: { message: CryptoBuffer; publicKey: CryptoBuffer }; id: string }
  | { type: 'file_encrypt'; payload: { fileBuffer: ArrayBuffer | Uint8Array }; id: string }
  | { type: 'file_decrypt'; payload: { combinedData: ArrayBuffer | Uint8Array; keyBytes: CryptoBuffer }; id: string }
  | { type: 'getRecoveryPhrase'; payload: { encryptedDataStr: string; password: string }; id: string }
  | { type: 'restoreFromPhrase'; payload: { phrase: string; password: string }; id: string }
  | { type: 'recoverAccountWithSignature'; payload: { phrase: string; newPassword: string; identifier: string; timestamp: string; nonce: string }; id: string }
  | { type: 'hashUsername'; payload: { username: string }; id: string }
  | { type: 'encryptProfile'; payload: { profileJsonString: string; profileKeyB64: string }; id: string }
  | { type: 'decryptProfile'; payload: { encryptedProfileB64: string; profileKeyB64: string }; id: string }
  | { type: 'generateProfileKey'; payload: void; id: string }
  | { type: 'minePoW'; payload: { salt: string; difficulty: number }; id: string }
  | { type: 'generate_random_key'; payload: void; id: string }
  | { type: 'reEncryptBundleFromMasterKey'; payload: { masterKey: CryptoBuffer; newPassword: string }; id: string }
  | { type: 'encrypt_session_key'; payload: { sessionKey: CryptoBuffer; masterSeed: CryptoBuffer }; id: string }
  | { type: 'decrypt_session_key'; payload: { encryptedKey: CryptoBuffer; masterSeed: CryptoBuffer }; id: string }
  | { type: 'generate_otpk_batch'; payload: { count: number; startId: number; masterSeed: CryptoBuffer }; id: string }
  | { type: 'x3dh_recipient_regenerate'; payload: { keyId: number; masterSeed: CryptoBuffer; myIdentityKey: SodiumKeyPair; mySignedPreKey: SodiumKeyPair; myPqIdentityKey: SodiumKeyPair; myPqSignedPreKey: SodiumKeyPair; theirSigningKey: CryptoBuffer; initiatorCiphertexts: string }; id: string }
  | { type: 'dr_init_alice'; payload: { sk: CryptoBuffer; theirSignedPreKeyPublic: CryptoBuffer }; id: string }
  | { type: 'dr_init_bob'; payload: { sk: CryptoBuffer; mySignedPreKey: SodiumKeyPair }; id: string }
  | { type: 'dr_ratchet_encrypt'; payload: { serializedState: DoubleRatchetState; plaintext: string | CryptoBuffer }; id: string }
  | { type: 'dr_ratchet_decrypt'; payload: { serializedState: DoubleRatchetState; header: DoubleRatchetHeader; ciphertext: CryptoBuffer }; id: string }
  | { type: 'group_init_sender_key'; payload: void; id: string }
  | { type: 'group_ratchet_encrypt'; payload: { serializedState: GroupRatchetState; plaintext: string | CryptoBuffer; signingPrivateKey: CryptoBuffer }; id: string }
  | { type: 'group_ratchet_decrypt'; payload: { serializedState: GroupRatchetState; header: GroupRatchetHeader; ciphertext: CryptoBuffer; signature: string; senderSigningPublicKey: CryptoBuffer }; id: string }
  | { type: 'group_decrypt_skipped'; payload: { mk: string; headerN: number; ciphertext: CryptoBuffer; signature: string; senderSigningPublicKey: CryptoBuffer }; id: string }
  | { type: 'burner_dr_init_guest'; payload: { hostClassicalPk: CryptoBuffer; hostPqPk: CryptoBuffer }; id: string }
  | { type: 'burner_dr_init_host'; payload: { guestClassicalPk: CryptoBuffer; hostClassicalSk: CryptoBuffer; savedCt: CryptoBuffer; hostPqSk: CryptoBuffer }; id: string }
  | { type: 'burner_dr_encrypt'; payload: { state: BurnerDoubleRatchetState; plaintext: string | CryptoBuffer }; id: string }
  | { type: 'burner_dr_decrypt'; payload: { state: BurnerDoubleRatchetState; header: BurnerDoubleRatchetHeader; ciphertext: CryptoBuffer }; id: string };

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, payload, id } = event.data;
  
  try {
    await ensureSodiumReady();
    let result: unknown;
    
    switch (type) {
      case 'DERIVE_KEY': {
        const { password, salt } = payload;
        result = await _deriveKey(password, new Uint8Array(salt));
        break;
      }
      case 'ENCRYPT_DATA': {
        const { keyBytes, data } = payload;
        result = await _encryptData(new Uint8Array(keyBytes), data);
        break;
      }
      case 'DECRYPT_DATA': {
        const { keyBytes, encryptedString } = payload;
        result = await _decryptData(new Uint8Array(keyBytes), encryptedString);
        break;
      }
      case 'registerAndGenerateKeys': {
        const { password } = payload;
        const masterSeed = sodium.randombytes_buf(32);
        const stretchedSeed = await _stretchSeed(masterSeed);
        const encryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const pqEncryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-encryption")));
        const signingSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        const pqSignedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const pqEncryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqEncryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        const pqSignedPreKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqSignedPreKeySeed);
        
        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            pqEncryption: pqEncryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            pqSignedPreKey: pqSignedPreKeyPair.privateKey,
            masterSeed: masterSeed
          }, password);

          const phrase = entropyToMnemonic(masterSeed, wordlist);
          
          result = {
              encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
              pqEncryptionPublicKeyB64: exportPublicKey(pqEncryptionKeyPair.publicKey),
              signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
              encryptedPrivateKeys,
              phrase
          };
        } finally {
          sodium.memzero(masterSeed);
          sodium.memzero(stretchedSeed);
          sodium.memzero(encryptionSeed);
          sodium.memzero(pqEncryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(pqSignedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(pqEncryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
          sodium.memzero(pqSignedPreKeyPair.privateKey);
        }
        break;
      }
      case 'retrievePrivateKeys': {
        const { encryptedDataStr, password } = payload;
        result = await retrievePrivateKeys(encryptedDataStr, password);
        break;
      }
      case 'generateSafetyNumber': {
        const { myPublicKey, theirPublicKey } = payload;
        const myPublicKeyBytes = new Uint8Array(myPublicKey);
        const theirPublicKeyBytes = new Uint8Array(theirPublicKey);
        
        result = generateSafetyNumber(myPublicKeyBytes, theirPublicKeyBytes);
        break;
      }
      case 'crypto_secretbox_xchacha20poly1305_easy': {
        const { message, nonce, key } = payload;
        let messageBytes: Uint8Array | null = null;
        let nonceBytes: Uint8Array | null = null;
        let keyBytes: Uint8Array | null = null;

        try {
            messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
            nonceBytes = new Uint8Array(nonce);
            keyBytes = new Uint8Array(key);
            
            result = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(messageBytes, null, null, nonceBytes, keyBytes);
        } finally {
            if (messageBytes && typeof message !== 'string') sodium.memzero(messageBytes);
            if (nonceBytes) sodium.memzero(nonceBytes);
            if (keyBytes) sodium.memzero(keyBytes);
        }
        break;
      }
      case 'crypto_secretbox_xchacha20poly1305_open_easy': {
        const { ciphertext, nonce, key } = payload;
        let ciphertextBytes: Uint8Array | null = null;
        let nonceBytes: Uint8Array | null = null;
        let keyBytes: Uint8Array | null = null;

        try {
            ciphertextBytes = new Uint8Array(ciphertext);
            nonceBytes = new Uint8Array(nonce);
            keyBytes = new Uint8Array(key);

            result = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertextBytes, null, nonceBytes, keyBytes);
        } finally {
            if (ciphertextBytes) sodium.memzero(ciphertextBytes);
            if (nonceBytes) sodium.memzero(nonceBytes);
            if (keyBytes) sodium.memzero(keyBytes);
        }
        break;
      }
      case 'crypto_box_seal_open': {
        const { ciphertext, publicKey, privateKey } = payload;
        const ciphertextBytes = new Uint8Array(ciphertext);
        const publicKeyBytes = new Uint8Array(publicKey);
        const privateKeyBytes = new Uint8Array(privateKey);
        
        try {
          result = sodium.crypto_box_seal_open(ciphertextBytes, publicKeyBytes, privateKeyBytes);
        } finally {
          sodium.memzero(privateKeyBytes);
        }
        break;
      }
      case 'pq_box_seal': {
        const { message, pqPublicKey, classicalPublicKey } = payload;
        const messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
        const pqPublicKeyBytes = new Uint8Array(pqPublicKey);
        const classicalPublicKeyBytes = new Uint8Array(classicalPublicKey);

        // Validate key lengths
        if (classicalPublicKeyBytes.length !== 32) {
          throw new Error(`invalid publicKey length: expected 32 bytes for classical key, got ${classicalPublicKeyBytes.length}`);
        }
        if (pqPublicKeyBytes.length !== sodium.crypto_kem_xwing_PUBLICKEYBYTES) {
          throw new Error(`invalid PQ publicKey length: expected ${sodium.crypto_kem_xwing_PUBLICKEYBYTES} bytes, got ${pqPublicKeyBytes.length}`);
        }

        const ephemeralKeyPair = sodium.crypto_box_keypair();
        let sharedSecret: Uint8Array | null = null;
        let nonce: Uint8Array | null = null;
        let encryptedMessage: Uint8Array | null = null;

        try {
          const classicalSharedSecret = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, classicalPublicKeyBytes);
          
          const pqResult = sodium.crypto_kem_xwing_enc(pqPublicKeyBytes);
          const pqSharedSecret = pqResult.sharedSecret;
          const pqCiphertext = pqResult.ciphertext;

          sharedSecret = new Uint8Array(classicalSharedSecret.length + pqSharedSecret.length);
          sharedSecret.set(classicalSharedSecret, 0);
          sharedSecret.set(pqSharedSecret, classicalSharedSecret.length);

          const derivedKey = sodium.crypto_generichash(32, sharedSecret, null);

          nonce = sodium.randombytes_buf(24);
          encryptedMessage = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(messageBytes, null, null, nonce, derivedKey);

          if (!nonce || !encryptedMessage) {
              throw new Error("Encryption failed");
          }

          const combined = new Uint8Array(ephemeralKeyPair.publicKey.length + pqCiphertext.length + nonce.length + encryptedMessage.length);
          let offset = 0;
          combined.set(ephemeralKeyPair.publicKey, offset);
          offset += ephemeralKeyPair.publicKey.length;
          combined.set(pqCiphertext, offset);
          offset += pqCiphertext.length;
          combined.set(nonce, offset);
          offset += nonce.length;
          combined.set(encryptedMessage, offset);

          result = combined;

          sodium.memzero(classicalSharedSecret);
          sodium.memzero(pqSharedSecret);
          sodium.memzero(derivedKey);
        } finally {
          sodium.memzero(ephemeralKeyPair.privateKey);
          if (sharedSecret) sodium.memzero(sharedSecret);
          if (nonce) sodium.memzero(nonce);
          if (encryptedMessage) sodium.memzero(encryptedMessage);
          if (messageBytes && typeof message === 'string') sodium.memzero(messageBytes);
        }
        break;
      }
      case 'pq_box_seal_open': {
        const { combinedPayload, pqPrivateKey, classicalPrivateKey } = payload;
        const payloadBytes = typeof combinedPayload === 'string' ? sodium.from_base64(combinedPayload, sodium.base64_variants.URLSAFE_NO_PADDING) : new Uint8Array(combinedPayload);
        const pqPrivateKeyBytes = typeof pqPrivateKey === 'string' ? sodium.from_base64(pqPrivateKey, sodium.base64_variants.URLSAFE_NO_PADDING) : new Uint8Array(pqPrivateKey);
        const classicalPrivateKeyBytes = typeof classicalPrivateKey === 'string' ? sodium.from_base64(classicalPrivateKey, sodium.base64_variants.URLSAFE_NO_PADDING) : new Uint8Array(classicalPrivateKey);

        const ephemeralPubKeyLength = 32;
        const pqCiphertextLength = sodium.crypto_kem_xwing_CIPHERTEXTBYTES;
        const nonceLength = 24;

        if (payloadBytes.length < ephemeralPubKeyLength + pqCiphertextLength + nonceLength) {
          throw new Error("Payload too short for pq_box_seal_open");
        }

        let offset = 0;
        const ephemeralPubKey = payloadBytes.slice(offset, offset + ephemeralPubKeyLength);
        offset += ephemeralPubKeyLength;
        
        const pqCiphertext = payloadBytes.slice(offset, offset + pqCiphertextLength);
        offset += pqCiphertextLength;
        
        const nonce = payloadBytes.slice(offset, offset + nonceLength);
        offset += nonceLength;
        
        const encryptedMessage = payloadBytes.slice(offset);

        let sharedSecret: Uint8Array | null = null;

        try {
          const classicalSharedSecret = sodium.crypto_scalarmult(classicalPrivateKeyBytes, ephemeralPubKey);
          const pqSharedSecret = sodium.crypto_kem_xwing_dec(pqCiphertext, pqPrivateKeyBytes);

          sharedSecret = new Uint8Array(classicalSharedSecret.length + pqSharedSecret.length);
          sharedSecret.set(classicalSharedSecret, 0);
          sharedSecret.set(pqSharedSecret, classicalSharedSecret.length);

          const derivedKey = sodium.crypto_generichash(32, sharedSecret, null);

          result = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, encryptedMessage, null, nonce, derivedKey);

          sodium.memzero(classicalSharedSecret);
          sodium.memzero(pqSharedSecret);
          sodium.memzero(derivedKey);
        } finally {
          sodium.memzero(pqPrivateKeyBytes);
          sodium.memzero(classicalPrivateKeyBytes);
          if (sharedSecret) sodium.memzero(sharedSecret);
        }
        break;
      }
      case 'x3dh_initiator': {
        const { mySigningKey, theirIdentityKey, theirPqIdentityKey, theirSignedPreKey, theirPqSignedPreKey, theirSigningKey, signature, pqSignature, theirOneTimePreKey, theirPqOneTimePreKey } = payload;

        const signatureBytes = new Uint8Array(signature);
        const theirSignedPreKeyBytes = new Uint8Array(theirSignedPreKey);
        const theirSigningKeyBytes = new Uint8Array(theirSigningKey);

        if (!sodium.crypto_sign_verify_detached(signatureBytes, theirSignedPreKeyBytes, theirSigningKeyBytes)) {
          throw new Error("Invalid signature on signed pre-key.");
        }

        if (!theirPqIdentityKey || !theirPqSignedPreKey || !pqSignature) {
            throw new Error("Post-Quantum Handshake Mandatory");
        }

        const pqSignatureBytes = new Uint8Array(pqSignature);
        const theirPqSignedPreKeyBytes = new Uint8Array(theirPqSignedPreKey);
        if (!sodium.crypto_sign_verify_detached(pqSignatureBytes, theirPqSignedPreKeyBytes, theirSigningKeyBytes)) {
            throw new Error("Invalid Post-Quantum signature on PQ signed pre-key.");
        }

        const mySigningKeyPrivateBytes = new Uint8Array(mySigningKey.privateKey);
        const myIdentityKeyPrivateBytes = sodium.crypto_sign_ed25519_sk_to_curve25519(mySigningKeyPrivateBytes);
        const theirIdentityKeyBytes = new Uint8Array(theirIdentityKey);
        
        const ephemeralKeyPair = sodium.crypto_box_keypair();
        let sharedSecret: Uint8Array | null = null;

        try {
          const dh1 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirSignedPreKeyBytes);
          const dh2 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirIdentityKeyBytes);
          const dh3 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirSignedPreKeyBytes);

          const secrets = [dh1, dh2, dh3];

          let ct_id: Uint8Array | undefined = undefined;
          let ct_spk: Uint8Array | undefined = undefined;

          const pqIdResult = sodium.crypto_kem_xwing_enc(new Uint8Array(theirPqIdentityKey));
          secrets.push(pqIdResult.sharedSecret);
          ct_id = pqIdResult.ciphertext;

          const pqSpkResult = sodium.crypto_kem_xwing_enc(theirPqSignedPreKeyBytes);
          secrets.push(pqSpkResult.sharedSecret);
          ct_spk = pqSpkResult.ciphertext;

          let ct_otpk: Uint8Array | undefined = undefined;

          if (theirOneTimePreKey || theirPqOneTimePreKey) {
             if (!theirOneTimePreKey || !theirPqOneTimePreKey) {
                 throw new Error("Post-Quantum Handshake Mandatory");
             }
             const theirOneTimePreKeyBytes = new Uint8Array(theirOneTimePreKey);
             const dh4 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirOneTimePreKeyBytes);
             secrets.push(dh4);

             const pqOtpkResult = sodium.crypto_kem_xwing_enc(new Uint8Array(theirPqOneTimePreKey));
             const ss_otpk = pqOtpkResult.sharedSecret;
             ct_otpk = pqOtpkResult.ciphertext;
             secrets.push(ss_otpk);
          }

          const totalLength = secrets.reduce((sum, s) => sum + s.length, 0);
          sharedSecret = new Uint8Array(totalLength);
          let offset = 0;
          for (const s of secrets) {
              sharedSecret.set(s, offset);
              offset += s.length;
              sodium.memzero(s);
          }
          
          const sessionKey = sodium.crypto_generichash(32, sharedSecret, null);

          const ciphertextsObj: Record<string, string | undefined> = {
             ek: sodium.to_base64(ephemeralKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING)
          };
          if (ct_id) ciphertextsObj.ct_id = sodium.to_base64(ct_id, sodium.base64_variants.URLSAFE_NO_PADDING);
          if (ct_spk) ciphertextsObj.ct_spk = sodium.to_base64(ct_spk, sodium.base64_variants.URLSAFE_NO_PADDING);
          if (ct_otpk) ciphertextsObj.ct_otpk = sodium.to_base64(ct_otpk, sodium.base64_variants.URLSAFE_NO_PADDING);

          const initiatorCiphertexts = sodium.to_base64(
             new TextEncoder().encode(JSON.stringify(ciphertextsObj)),
             sodium.base64_variants.URLSAFE_NO_PADDING
          );

          result = {
              sessionKey,
              initiatorCiphertexts,
          };
        } finally {
          sodium.memzero(mySigningKeyPrivateBytes);
          sodium.memzero(myIdentityKeyPrivateBytes);
          sodium.memzero(ephemeralKeyPair.privateKey);
          if (sharedSecret) sodium.memzero(sharedSecret);
        }
        break;
      }
      case 'x3dh_recipient': {
        const { myIdentityKey, mySignedPreKey, myPqIdentityKey, myPqSignedPreKey, theirSigningKey, initiatorCiphertexts, myOneTimePreKey } = payload;
        
        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const mySignedPreKeyPrivateBytes = new Uint8Array(mySignedPreKey.privateKey);
        const myPqIdentityKeyPrivateBytes = new Uint8Array(myPqIdentityKey.privateKey);
        const myPqSignedPreKeyPrivateBytes = new Uint8Array(myPqSignedPreKey.privateKey);

        const theirSigningKeyBytes = new Uint8Array(theirSigningKey);
        const theirIdentityKeyBytes = sodium.crypto_sign_ed25519_pk_to_curve25519(theirSigningKeyBytes);

        const ciphertextsStr = new TextDecoder().decode(sodium.from_base64(initiatorCiphertexts as string, sodium.base64_variants.URLSAFE_NO_PADDING));
        const ciphertexts = JSON.parse(ciphertextsStr);

        const theirEphemeralKeyBytes = sodium.from_base64(ciphertexts.ek, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        if (!ciphertexts.ct_id || !ciphertexts.ct_spk) {
            throw new Error("Post-Quantum Handshake Mandatory");
        }

        const ct_id = sodium.from_base64(ciphertexts.ct_id, sodium.base64_variants.URLSAFE_NO_PADDING);
        const ct_spk = sodium.from_base64(ciphertexts.ct_spk, sodium.base64_variants.URLSAFE_NO_PADDING);

        let sharedSecret: Uint8Array | null = null;

        try {
          const dh1 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirIdentityKeyBytes);
          const dh2 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirEphemeralKeyBytes);
          const dh3 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirEphemeralKeyBytes);
          
          const ss_id = sodium.crypto_kem_xwing_dec(ct_id, myPqIdentityKeyPrivateBytes);
          const ss_spk = sodium.crypto_kem_xwing_dec(ct_spk, myPqSignedPreKeyPrivateBytes);

          const secrets = [dh1, dh2, dh3, ss_id, ss_spk];

          if (ciphertexts.ct_otpk) {
             if (!myOneTimePreKey) {
                 throw new Error("Sender used One-Time Pre-Key but local device is missing the key.");
             }
             const privateKeysJson = new TextDecoder().decode(new Uint8Array(myOneTimePreKey.privateKey));
             const parsedKeys = JSON.parse(privateKeysJson);
             const classicalKey = new Uint8Array(parsedKeys.classical);
             const pqKey = new Uint8Array(parsedKeys.pq);

             const dh4 = sodium.crypto_scalarmult(classicalKey, theirEphemeralKeyBytes);
             secrets.push(dh4);

             const ct_otpk = sodium.from_base64(ciphertexts.ct_otpk, sodium.base64_variants.URLSAFE_NO_PADDING);
             const ss_otpk = sodium.crypto_kem_xwing_dec(ct_otpk, pqKey);
             secrets.push(ss_otpk);

             sodium.memzero(classicalKey);
             sodium.memzero(pqKey);
          }

          const totalLength = secrets.reduce((sum, s) => sum + s.length, 0);
          sharedSecret = new Uint8Array(totalLength);
          let offset = 0;
          for (const s of secrets) {
              sharedSecret.set(s, offset);
              offset += s.length;
              sodium.memzero(s);
          }

          result = sodium.crypto_generichash(32, sharedSecret, null);
        } finally {
          sodium.memzero(myIdentityKeyPrivateBytes);
          sodium.memzero(mySignedPreKeyPrivateBytes);
          sodium.memzero(myPqIdentityKeyPrivateBytes);
          sodium.memzero(myPqSignedPreKeyPrivateBytes);
          if (sharedSecret) sodium.memzero(sharedSecret);
        }
        break;
      }
      case 'crypto_box_seal': {
        const { message, publicKey } = payload;
        const messageBytes = new Uint8Array(message);
        const publicKeyBytes = new Uint8Array(publicKey);
        
        result = sodium.crypto_box_seal(messageBytes, publicKeyBytes);
        break;
      }
      case 'file_encrypt': {
        const { fileBuffer } = payload;
        const fileBytes = new Uint8Array(fileBuffer);
        
        const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();
        const res = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
        const state = res.state;
        const header = res.header;
        
        const chunkSize = 1024 * 1024 * 2; 
        const chunks: Uint8Array[] = [];
        chunks.push(header); 

        if (fileBytes.length === 0) {
          const encryptedChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
            state, new Uint8Array(0), null, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          );
          chunks.push(encryptedChunk);
        } else {
          for (let i = 0; i < fileBytes.length; i += chunkSize) {
            const chunk = fileBytes.slice(i, i + chunkSize);
            const isFinal = (i + chunkSize) >= fileBytes.length;
            const tag = isFinal 
              ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL 
              : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
            
            const encryptedChunk = sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag);
            chunks.push(encryptedChunk);
          }
        }
        
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const combinedData = new Uint8Array(totalLength);
        let offset = 0;
        for (const c of chunks) {
          combinedData.set(c, offset);
          offset += c.length;
        }

        result = { combinedData, key };
        break;
      }
      case 'file_decrypt': {
        const { combinedData, keyBytes } = payload;
        const dataBytes = new Uint8Array(combinedData);
        const headerSize = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
        
        if (dataBytes.length <= headerSize) {
            throw new Error("File decryption failed: Invalid or missing ciphertext");
        }

        const header = dataBytes.slice(0, headerSize);
        const key = new Uint8Array(keyBytes);
        
        const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
        
        const chunkSize = 1024 * 1024 * 2 + sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
        const decryptedChunks: Uint8Array[] = [];
        let offset = headerSize;
        
        let lastTag: number | null = null;

        while (offset < dataBytes.length) {
          const chunk = dataBytes.slice(offset, Math.min(offset + chunkSize, dataBytes.length));
          const pullRes = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk);
          if (!pullRes) {
             throw new Error("File decryption failed or corrupted data");
          }
          decryptedChunks.push(pullRes.message);
          lastTag = pullRes.tag;
          offset += chunk.length;
        }

        if (lastTag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
             throw new Error("File truncation detected: Missing TAG_FINAL");
        }

        const totalLength = decryptedChunks.reduce((acc, c) => acc + c.length, 0);
        const decryptedData = new Uint8Array(totalLength);
        let currentOffset = 0;
        for (const c of decryptedChunks) {
          decryptedData.set(c, currentOffset);
          currentOffset += c.length;
        }

        result = decryptedData;
        break;
      }
      case 'getRecoveryPhrase': {
        const { encryptedDataStr, password } = payload;
        const resultData = await retrievePrivateKeys(encryptedDataStr, password);
        if (resultData.success && resultData.keys.masterSeed) {
          const mnemonic = entropyToMnemonic(resultData.keys.masterSeed, wordlist);
          if (!mnemonic || mnemonic.trim().length === 0) {
              throw new Error(`Mnemonic generation failed. Output length: ${mnemonic?.length}`);
          }
          result = mnemonic;
        } else {
          throw new Error("Failed to retrieve master seed. Incorrect password or invalid bundle.");
        }
        break;
      }
      case 'restoreFromPhrase': {
        const { phrase, password } = payload;
        const masterSeed = mnemonicToEntropy(phrase, wordlist);
        const stretchedSeed = await _stretchSeed(masterSeed);

        const encryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const pqEncryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-encryption")));
        const signingSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        const pqSignedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const pqEncryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqEncryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        const pqSignedPreKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqSignedPreKeySeed);
        
        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            pqEncryption: pqEncryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            pqSignedPreKey: pqSignedPreKeyPair.privateKey,
            masterSeed: masterSeed
          }, password);

          result = {
            encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
            pqEncryptionPublicKeyB64: exportPublicKey(pqEncryptionKeyPair.publicKey),
            signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
            encryptedPrivateKeys,
          };
        } finally {
          sodium.memzero(masterSeed);
          sodium.memzero(stretchedSeed);
          sodium.memzero(encryptionSeed);
          sodium.memzero(pqEncryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(pqSignedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(pqEncryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
          sodium.memzero(pqSignedPreKeyPair.privateKey);
        }
        break;
      }
      case 'recoverAccountWithSignature': {
        const { phrase, newPassword, identifier, timestamp, nonce } = payload;
        const masterSeed = mnemonicToEntropy(phrase, wordlist);
        const stretchedSeed = await _stretchSeed(masterSeed);

        const encryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const pqEncryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-encryption")));
        const signingSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        const pqSignedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const pqEncryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqEncryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        const pqSignedPreKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqSignedPreKeySeed);
        
        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            pqEncryption: pqEncryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            pqSignedPreKey: pqSignedPreKeyPair.privateKey,
            masterSeed: masterSeed
          }, newPassword);

          const pubEnc = exportPublicKey(encryptionKeyPair.publicKey);
          const pubPqEnc = exportPublicKey(pqEncryptionKeyPair.publicKey);
          const pubSign = exportPublicKey(signingKeyPair.publicKey);
          const pqKeyStr = pubPqEnc || "";
          
          const messageString = `${identifier}:${timestamp}:${nonce}:${newPassword}:${encryptedPrivateKeys}:${pubEnc}:${pqKeyStr}:${pubSign}`;
          const messageBytes = new TextEncoder().encode(messageString);
          const signature = sodium.crypto_sign_detached(messageBytes, signingKeyPair.privateKey);
          sodium.memzero(messageBytes);

          result = {
            encryptionPublicKeyB64: pubEnc,
            pqEncryptionPublicKeyB64: pubPqEnc,
            signingPublicKeyB64: pubSign,
            encryptedPrivateKeys,
            signatureB64: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING)
          };
        } finally {
          sodium.memzero(masterSeed);
          sodium.memzero(stretchedSeed);
          sodium.memzero(encryptionSeed);
          sodium.memzero(pqEncryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(pqSignedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(pqEncryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
          sodium.memzero(pqSignedPreKeyPair.privateKey);
        }
        break;
      }
      case 'hashUsername': {
        const { username } = payload;
        const SALT = new TextEncoder().encode("NYX_BLIND_IDX_V1"); 
        const hashBytes = await argon2id({
          password: username.toLowerCase(),
          salt: SALT,
          ...ARGON_INDEX_CONFIG,
        });
        
        result = sodium.to_base64(hashBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
        break;
      }
      case 'encryptProfile': {
        const { profileJsonString, profileKeyB64 } = payload;
        let key: Uint8Array | null = null;
        let message: Uint8Array | null = null;
        let nonce: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;
        let combined: Uint8Array | null = null;

        try {
            key = sodium.from_base64(profileKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
            message = new TextEncoder().encode(profileJsonString);
            nonce = sodium.randombytes_buf(24);
            
            ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                message, null, null, nonce, key
            );
            
            combined = new Uint8Array(nonce!.length + ciphertext!.length);
            combined.set(nonce!);
            combined.set(ciphertext!, nonce!.length);
            
            result = sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING);
        } finally {
            if (key) sodium.memzero(key);
            if (message) sodium.memzero(message);
            if (nonce) sodium.memzero(nonce);
            if (ciphertext) sodium.memzero(ciphertext);
            if (combined) sodium.memzero(combined);
        }
        break;
      }
      case 'decryptProfile': {
        const { encryptedProfileB64, profileKeyB64 } = payload;
        let key: Uint8Array | null = null;
        let combined: Uint8Array | null = null;
        let decrypted: Uint8Array | null = null;

        try {
            key = sodium.from_base64(profileKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
            combined = sodium.from_base64(encryptedProfileB64, sodium.base64_variants.URLSAFE_NO_PADDING);
            
            const nonceBytes = 24;
            const nonce = combined!.slice(0, nonceBytes);
            const ciphertext = combined!.slice(nonceBytes);
            
            decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null, ciphertext, null, nonce, key!
            );
            
            result = new TextDecoder().decode(decrypted!);
        } finally {
            if (key) sodium.memzero(key);
            if (combined) sodium.memzero(combined);
            if (decrypted) sodium.memzero(decrypted);
        }
        break;
      }
      case 'generateProfileKey': {
        let key: Uint8Array | null = null;
        try {
            key = sodium.randombytes_buf(32);
            result = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
        } finally {
            if (key) sodium.memzero(key);
        }
        break;
      }
      case 'minePoW': {
        const { salt, difficulty } = payload;
        const targetPrefix = '0'.repeat(difficulty);
        let nonce = 0;
        let hash = '';
        let found = false;
        
        const saltBytes = new TextEncoder().encode(salt);
        
        const toHex = (buffer: Uint8Array) => {
            return Array.from(buffer)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        };

        while (!found) {
            const nonceStr = nonce.toString();
            const nonceBytes = new TextEncoder().encode(nonceStr);
            
            const input = new Uint8Array(saltBytes.length + nonceBytes.length);
            input.set(saltBytes);
            input.set(nonceBytes, saltBytes.length);
            
            const hashBuffer = sodium.crypto_generichash(64, input);
            hash = toHex(hashBuffer);
            
            if (hash.startsWith(targetPrefix)) {
                found = true;
            } else {
                nonce++;
                if (nonce % 500 === 0) await new Promise(r => setTimeout(r, 0));
            }
        }
        
        result = { nonce, hash };
        break;
      }
      case 'generate_random_key': {
        result = sodium.randombytes_buf(32);
        break;
      }
      case 'reEncryptBundleFromMasterKey': {
        const { masterKey, newPassword } = payload;
        const stretchedSeed = await _stretchSeed(masterKey instanceof Uint8Array ? masterKey : new Uint8Array(masterKey));
        const encryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const pqEncryptionSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-encryption")));
        const signingSeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        const pqSignedPreKeySeed = sodium.crypto_generichash(32, stretchedSeed, new Uint8Array(new TextEncoder().encode("pq-signed-pre-key")));

        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const pqEncryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqEncryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        const pqSignedPreKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqSignedPreKeySeed);

        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            pqEncryption: pqEncryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            pqSignedPreKey: pqSignedPreKeyPair.privateKey,
            masterSeed: masterKey instanceof Uint8Array ? masterKey : new Uint8Array(masterKey),
          }, newPassword);

          result = {
            encryptedPrivateKeys,
            encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
            pqEncryptionPublicKeyB64: exportPublicKey(pqEncryptionKeyPair.publicKey),
            signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
          };
        } finally {
          try { sodium.memzero(masterKey); } catch {}
          sodium.memzero(stretchedSeed);
          sodium.memzero(encryptionSeed);          sodium.memzero(pqEncryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(pqSignedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(pqEncryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
          sodium.memzero(pqSignedPreKeyPair.privateKey);
        }
        break;
      }
      case 'encrypt_session_key': {
        const { sessionKey, masterSeed } = payload;
        const sessionKeyBytes = new Uint8Array(sessionKey);
        const masterSeedBytes = new Uint8Array(masterSeed);

        const storageKey = sodium.crypto_generichash(32, masterSeedBytes, new Uint8Array(new TextEncoder().encode("session-storage")));
        
        let nonce: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;

        try {
          nonce = sodium.randombytes_buf(24);
          
          ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            sessionKeyBytes, null, null, nonce, storageKey
          );

          if (!nonce || !ciphertext) throw new Error("Encryption failed");

          const combined = new Uint8Array(nonce.length + ciphertext.length);
          combined.set(nonce);
          combined.set(ciphertext, nonce.length);

          result = combined;
        } finally {
          sodium.memzero(storageKey);
          sodium.memzero(masterSeedBytes);
          sodium.memzero(sessionKeyBytes);
          if (nonce) sodium.memzero(nonce);
          if (ciphertext) sodium.memzero(ciphertext);
        }
        break;
      }
      case 'decrypt_session_key': {
        const { encryptedKey, masterSeed } = payload;
        const encryptedKeyBytes = new Uint8Array(encryptedKey);
        const masterSeedBytes = new Uint8Array(masterSeed);

        const storageKey = sodium.crypto_generichash(32, masterSeedBytes, new Uint8Array(new TextEncoder().encode("session-storage")));
        
        const nonce = encryptedKeyBytes.slice(0, 24);
        const ciphertext = encryptedKeyBytes.slice(24);

        try {
          result = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, ciphertext, null, nonce, storageKey
          );
        } finally {
          sodium.memzero(storageKey);
          sodium.memzero(masterSeedBytes);
        }
        break;
      }
      case 'generate_otpk_batch': {
        const { count, startId, masterSeed } = payload;
        const masterSeedBytes = new Uint8Array(masterSeed);
        const storageKey = sodium.crypto_generichash(32, masterSeedBytes, new Uint8Array(new TextEncoder().encode("otpk-storage")));
        
        const batch = [];
        for (let i = 0; i < count; i++) {
          const keyId = startId + i;
          
          const seedInput = new Uint8Array(masterSeedBytes.length + 4 + 4);
          seedInput.set(masterSeedBytes);
          seedInput.set(new TextEncoder().encode("OTPK"), masterSeedBytes.length);
          const idBytes = new Uint8Array(new Uint32Array([keyId]).buffer); 
          seedInput.set(idBytes, masterSeedBytes.length + 4);

          const keySeed = sodium.crypto_generichash(32, seedInput, null);
          const keyPair = sodium.crypto_box_seed_keypair(keySeed);
          
          // Generate PQ keypair
          const pqSeedInput = new Uint8Array(masterSeedBytes.length + 7 + 4);
          pqSeedInput.set(masterSeedBytes);
          pqSeedInput.set(new TextEncoder().encode("pq-otpk"), masterSeedBytes.length);
          pqSeedInput.set(idBytes, masterSeedBytes.length + 7);
          const pqKeySeed = sodium.crypto_generichash(32, pqSeedInput, null);
          const pqKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqKeySeed);
          
          // Serialize private keys
          const privateKeysJson = JSON.stringify({
            classical: Array.from(keyPair.privateKey),
            pq: Array.from(pqKeyPair.privateKey)
          });
          const privateKeysBytes = new TextEncoder().encode(privateKeysJson);

          const nonce = sodium.randombytes_buf(24);
          const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            privateKeysBytes, null, null, nonce, storageKey
          );
          
          const combined = new Uint8Array(nonce.length + ciphertext.length);
          combined.set(nonce);
          combined.set(ciphertext, nonce.length);
          
          batch.push({
            keyId,
            publicKey: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
            pqPublicKey: sodium.to_base64(pqKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
            encryptedPrivateKey: combined
          });
          
          sodium.memzero(keySeed);
          sodium.memzero(keyPair.privateKey);
          sodium.memzero(pqKeySeed);
          sodium.memzero(pqKeyPair.privateKey);
          sodium.memzero(privateKeysBytes);
        }
        
        sodium.memzero(masterSeedBytes);
        sodium.memzero(storageKey);
        result = batch;
        break;
      }
      case 'x3dh_recipient_regenerate': {
        const { 
            keyId, 
            masterSeed,
            myIdentityKey, 
            mySignedPreKey, 
            myPqIdentityKey,
            myPqSignedPreKey,
            theirSigningKey, 
            initiatorCiphertexts 
        } = payload;

        const masterSeedBytes = new Uint8Array(masterSeed);
        
        const seedInput = new Uint8Array(masterSeedBytes.length + 4 + 4);
        seedInput.set(masterSeedBytes);
        seedInput.set(new TextEncoder().encode("OTPK"), masterSeedBytes.length);
        const idBytes = new Uint8Array(new Uint32Array([keyId]).buffer);
        seedInput.set(idBytes, masterSeedBytes.length + 4);

        const keySeed = sodium.crypto_generichash(32, seedInput, null);
        const otpkKeyPair = sodium.crypto_box_seed_keypair(keySeed);

        const pqSeedInput = new Uint8Array(masterSeedBytes.length + 7 + 4);
        pqSeedInput.set(masterSeedBytes);
        pqSeedInput.set(new TextEncoder().encode("pq-otpk"), masterSeedBytes.length);
        pqSeedInput.set(idBytes, masterSeedBytes.length + 7);
        const pqKeySeed = sodium.crypto_generichash(32, pqSeedInput, null);
        const pqOtpkKeyPair = sodium.crypto_kem_xwing_seed_keypair(pqKeySeed);
        
        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const mySignedPreKeyPrivateBytes = new Uint8Array(mySignedPreKey.privateKey);
        const myPqIdentityKeyPrivateBytes = new Uint8Array(myPqIdentityKey.privateKey);
        const myPqSignedPreKeyPrivateBytes = new Uint8Array(myPqSignedPreKey.privateKey);

        const theirSigningKeyBytes = new Uint8Array(theirSigningKey);
        const theirIdentityKeyBytes = sodium.crypto_sign_ed25519_pk_to_curve25519(theirSigningKeyBytes);

        const ciphertextsStr = new TextDecoder().decode(sodium.from_base64(initiatorCiphertexts as string, sodium.base64_variants.URLSAFE_NO_PADDING));
        const ciphertexts = JSON.parse(ciphertextsStr);

        const theirEphemeralKeyBytes = sodium.from_base64(ciphertexts.ek, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        if (!ciphertexts.ct_id || !ciphertexts.ct_spk) {
            throw new Error("Post-Quantum Handshake Mandatory");
        }

        const ct_id = sodium.from_base64(ciphertexts.ct_id, sodium.base64_variants.URLSAFE_NO_PADDING);
        const ct_spk = sodium.from_base64(ciphertexts.ct_spk, sodium.base64_variants.URLSAFE_NO_PADDING);

        let sharedSecret: Uint8Array | null = null;

        try {
          const dh1 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirIdentityKeyBytes);
          const dh2 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirEphemeralKeyBytes);
          const dh3 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirEphemeralKeyBytes);
          
          const ss_id = sodium.crypto_kem_xwing_dec(ct_id, myPqIdentityKeyPrivateBytes);
          const ss_spk = sodium.crypto_kem_xwing_dec(ct_spk, myPqSignedPreKeyPrivateBytes);

          const secrets = [dh1, dh2, dh3, ss_id, ss_spk];

          if (ciphertexts.ct_otpk) {
             const dh4 = sodium.crypto_scalarmult(otpkKeyPair.privateKey, theirEphemeralKeyBytes); 
             secrets.push(dh4);

             const ct_otpk = sodium.from_base64(ciphertexts.ct_otpk, sodium.base64_variants.URLSAFE_NO_PADDING);
             const ss_otpk = sodium.crypto_kem_xwing_dec(ct_otpk, pqOtpkKeyPair.privateKey);
             secrets.push(ss_otpk);
          }

          const totalLength = secrets.reduce((sum, s) => sum + s.length, 0);
          sharedSecret = new Uint8Array(totalLength);
          let offset = 0;
          for (const s of secrets) {
              sharedSecret.set(s, offset);
              offset += s.length;
              sodium.memzero(s);
          }

          result = sodium.crypto_generichash(32, sharedSecret, null);
        } finally {
          sodium.memzero(masterSeedBytes);
          sodium.memzero(seedInput);
          sodium.memzero(keySeed);
          sodium.memzero(otpkKeyPair.privateKey);
          sodium.memzero(pqSeedInput);
          sodium.memzero(pqKeySeed);
          sodium.memzero(pqOtpkKeyPair.privateKey);
          
          sodium.memzero(myIdentityKeyPrivateBytes);
          sodium.memzero(mySignedPreKeyPrivateBytes);
          sodium.memzero(myPqIdentityKeyPrivateBytes);
          sodium.memzero(myPqSignedPreKeyPrivateBytes);
          if (sharedSecret) sodium.memzero(sharedSecret);
        }
        break;
      }
      
      case 'dr_init_alice': {
        const { sk, theirSignedPreKeyPublic } = payload as { sk: CryptoBuffer, theirSignedPreKeyPublic: CryptoBuffer };
        const skBytes = new Uint8Array(sk);
        const theirSpkBytes = new Uint8Array(theirSignedPreKeyPublic);
        
        let RK: Uint8Array | null = null;
        let CKs: Uint8Array | null = null;
        let sharedSecret: Uint8Array | null = null;
        let pqKeypair: { publicKey: Uint8Array, privateKey: Uint8Array } | null = null;

        try {
          pqKeypair = sodium.crypto_kem_xwing_keypair();
          if (!pqKeypair) throw new Error("KEM Keypair generation failed");
          const pqResult = sodium.crypto_kem_xwing_enc(theirSpkBytes);
          
          sharedSecret = new Uint8Array(skBytes.length + pqResult.sharedSecret.length);
          sharedSecret.set(skBytes, 0);
          sharedSecret.set(pqResult.sharedSecret, skBytes.length);

          const KDF = sodium.crypto_generichash(64, sharedSecret, null);
          RK = KDF.slice(0, 32);
          CKs = KDF.slice(32, 64);

          const state: RuntimeDoubleRatchetState = {
            KEMs: {
              publicKey: pqKeypair.publicKey,
              privateKey: pqKeypair.privateKey
            },
            KEMr: theirSpkBytes,
            savedCt: pqResult.ciphertext,
            RK,
            CKs,
            CKr: null,
            Ns: 0,
            Nr: 0,
            PN: 0
          };

          result = serializeState(state);
          sodium.memzero(KDF);
          sodium.memzero(pqResult.sharedSecret);
        } finally {
          sodium.memzero(skBytes);
          if (pqKeypair) sodium.memzero(pqKeypair.privateKey);
          if (sharedSecret) sodium.memzero(sharedSecret);
          if (RK) sodium.memzero(RK);
          if (CKs) sodium.memzero(CKs);
        }
        break;
      }

      case 'dr_init_bob': {
        const { sk, mySignedPreKey } = payload as { sk: CryptoBuffer, mySignedPreKey: SodiumKeyPair };
        if (!mySignedPreKey.publicKey) throw new Error("Missing public key");
        const skBytes = new Uint8Array(sk);
        const mySpkPrivateBytes = new Uint8Array(mySignedPreKey.privateKey);
        const mySpkPublicBytes = new Uint8Array(mySignedPreKey.publicKey);

        try {
          const state: RuntimeDoubleRatchetState = {
            KEMs: {
              publicKey: mySpkPublicBytes,
              privateKey: mySpkPrivateBytes
            },
            KEMr: null,
            savedCt: null,
            RK: skBytes,
            CKs: null,
            CKr: null,
            Ns: 0,
            Nr: 0,
            PN: 0
          };
          result = serializeState(state);
        } finally {
          sodium.memzero(skBytes);
          sodium.memzero(mySpkPrivateBytes);
        }
        break;
      }

      case 'dr_ratchet_encrypt': {
        const { serializedState, plaintext } = payload as { serializedState: DoubleRatchetState, plaintext: CryptoBuffer | string };
        const state = deserializeState(serializedState);
        const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);

        let mk: Uint8Array | null = null;
        let nonce: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;

        try {
          if (!state.CKs) throw new Error("Cannot encrypt: CKs is null");

          const [newCKs, messageKey] = await kdfChain(state.CKs);
          sodium.memzero(state.CKs);
          state.CKs = newCKs;
          mk = messageKey;

          nonce = sodium.randombytes_buf(24);
          ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintextBytes, null, null, nonce, mk);
          
          if (!nonce || !ciphertext) throw new Error("Encryption failed");

          const combined = new Uint8Array(nonce.length + ciphertext.length);
          combined.set(nonce);
          combined.set(ciphertext, nonce.length);

          const header = {
            kemPk: bytesToB64(state.KEMs?.publicKey)!,
            ct: bytesToB64(state.savedCt) || '',
            n: state.Ns,
            pn: state.PN
          };

          state.Ns += 1;

          result = {
            state: serializeState(state),
            header,
            ciphertext: Array.from(combined),
            mk: Array.from(mk)
          };
        } finally {
          if (state.KEMs) sodium.memzero(state.KEMs.privateKey);
          if (state.RK) sodium.memzero(state.RK);
          if (state.CKs) sodium.memzero(state.CKs);
          if (state.CKr) sodium.memzero(state.CKr);
          if (mk) sodium.memzero(mk);
          if (nonce) sodium.memzero(nonce);
          if (ciphertext) sodium.memzero(ciphertext);
          sodium.memzero(plaintextBytes);
        }
        break;
      }

      case 'dr_ratchet_decrypt': {
        const { serializedState, header, ciphertext } = payload as { serializedState: DoubleRatchetState, header: DoubleRatchetHeader, ciphertext: CryptoBuffer };
        const state = deserializeState(serializedState);
        const ciphertextBytes = new Uint8Array(ciphertext);
        const headerKemPk = b64ToBytes(header.kemPk);
        const headerCt = header.ct ? b64ToBytes(header.ct) : null;
        
        if (!headerKemPk) throw new Error("Missing kemPk in header");
        if (!state.RK) throw new Error("RK is missing");

        const skippedKeys: { kemPk: string, n: number, mk: string }[] = [];
        let mk: Uint8Array | null = null;
        let sharedSecret1: Uint8Array | null = null;
        let sharedSecret2: Uint8Array | null = null;
        let newKEMs: { publicKey: Uint8Array, privateKey: Uint8Array } | null = null;
        let plaintext: Uint8Array | null = null;

        try {
          if (!state.KEMr || sodium.compare(headerKemPk, state.KEMr) !== 0) {
            
            // PRE-RATCHET SKIP LOOP
            const MAX_SKIP = 1000;
            if (header.pn - state.Nr > MAX_SKIP) {
              throw new Error(`Too many skipped messages: ${header.pn - state.Nr}`);
            }
            if (state.CKr && state.KEMr) {
              while (state.Nr < header.pn) {
                const [nextCKr, skippedMK] = await kdfChain(state.CKr);
                skippedKeys.push({ kemPk: bytesToB64(state.KEMr) || '', n: state.Nr, mk: bytesToB64(skippedMK) || '' });
                sodium.memzero(state.CKr);
                state.CKr = nextCKr;
                state.Nr++;
              }
            }

            if (headerCt && state.KEMs) {
              const pqSharedSecret = sodium.crypto_kem_xwing_dec(headerCt, state.KEMs.privateKey);
              sharedSecret1 = new Uint8Array(32 + pqSharedSecret.length);
              sharedSecret1.set(state.RK, 0);
              sharedSecret1.set(pqSharedSecret, 32);

              const KDF1 = sodium.crypto_generichash(64, sharedSecret1, null);
              sodium.memzero(state.RK);
              state.RK = KDF1.slice(0, 32);
              if (state.CKr) sodium.memzero(state.CKr);
              state.CKr = KDF1.slice(32, 64);
              sodium.memzero(pqSharedSecret);
              sodium.memzero(KDF1);
            }

            state.PN = state.Ns;
            state.Ns = 0;
            state.Nr = 0;
            state.KEMr = headerKemPk;

            newKEMs = sodium.crypto_kem_xwing_keypair();
            if (!newKEMs) throw new Error("KEM Keypair generation failed");
            const pqResult = sodium.crypto_kem_xwing_enc(state.KEMr);
            state.savedCt = pqResult.ciphertext;

            sharedSecret2 = new Uint8Array(32 + pqResult.sharedSecret.length);
            sharedSecret2.set(state.RK!, 0);
            sharedSecret2.set(pqResult.sharedSecret, 32);

            const KDF2 = sodium.crypto_generichash(64, sharedSecret2, null);
            sodium.memzero(state.RK);
            state.RK = KDF2.slice(0, 32);
            if (state.CKs) sodium.memzero(state.CKs);
            state.CKs = KDF2.slice(32, 64);
            sodium.memzero(pqResult.sharedSecret);
            sodium.memzero(KDF2);

            if (state.KEMs) sodium.memzero(state.KEMs.privateKey);
            state.KEMs = {
              publicKey: newKEMs.publicKey,
              privateKey: newKEMs.privateKey
            };
          }

          const MAX_SKIP = 1000;
          if (header.n - state.Nr > MAX_SKIP) {
            throw new Error(`Too many skipped messages: ${header.n - state.Nr}`);
          }

          while (state.Nr < header.n) {
            if (!state.CKr) throw new Error("CKr is missing");
            const [nextCKr, skippedMK] = await kdfChain(state.CKr);
            skippedKeys.push({ kemPk: header.kemPk, n: state.Nr, mk: bytesToB64(skippedMK) || '' });
            sodium.memzero(state.CKr);
            state.CKr = nextCKr;
            state.Nr++;
          }

          if (state.Nr === header.n) {
            if (!state.CKr) throw new Error("CKr is missing");
            const [nextCKr, messageKey] = await kdfChain(state.CKr);
            mk = messageKey;
            sodium.memzero(state.CKr);
            state.CKr = nextCKr;
            state.Nr++;
          } else {
            throw new Error("Message N is older than current state");
          }

          const nonce = ciphertextBytes.slice(0, 24);
          const ctext = ciphertextBytes.slice(24);
          plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ctext, null, nonce, mk);
          if (!plaintext) throw new Error("Decryption failed");

          result = {
            state: serializeState(state),
            plaintext: Array.from(plaintext),
            skippedKeys,
            mk: Array.from(mk)
          };
        } finally {
          if (sharedSecret1) sodium.memzero(sharedSecret1);
          if (sharedSecret2) sodium.memzero(sharedSecret2);
          if (mk) sodium.memzero(mk);
          if (headerKemPk) sodium.memzero(headerKemPk);
          if (headerCt) sodium.memzero(headerCt);
          if (newKEMs && (!state.KEMs || state.KEMs.privateKey !== newKEMs.privateKey)) {
             sodium.memzero(newKEMs.privateKey);
          }
          if (plaintext) sodium.memzero(plaintext);
          
          if (state.KEMs) sodium.memzero(state.KEMs.privateKey);
          if (state.RK) sodium.memzero(state.RK);
          if (state.CKs) sodium.memzero(state.CKs);
          if (state.CKr) sodium.memzero(state.CKr);
        }
        break;
      }

      case 'group_init_sender_key': {
        const senderKey = sodium.randombytes_buf(32);
        result = {
          senderKeyB64: sodium.to_base64(senderKey, sodium.base64_variants.URLSAFE_NO_PADDING)
        };
        sodium.memzero(senderKey);
        break;
      }
      case 'group_ratchet_encrypt': {
        const { serializedState, plaintext, signingPrivateKey } = payload;
        const CKBytes = b64ToBytes(serializedState.CK);
        if (!CKBytes) throw new Error("Invalid Group Chain Key");
        const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);

        let newCK: Uint8Array | null = null;
        let mk: Uint8Array | null = null;
        const signingKeyBytes = new Uint8Array(signingPrivateKey);
        
        try {
            [newCK, mk] = await kdfChain(CKBytes);
            const currentN = serializedState.N || 0;

            const nonce = sodium.randombytes_buf(24);
            const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                plaintextBytes, null, null, nonce, mk
            );
            
            const combined = new Uint8Array(nonce.length + ciphertext.length);
            combined.set(nonce);
            combined.set(ciphertext, nonce.length);

            const header = { n: currentN };

            const dataToSign = new Uint8Array(4 + combined.length);
            new DataView(dataToSign.buffer).setUint32(0, currentN, false);
            dataToSign.set(combined, 4);
            
            const signature = sodium.crypto_sign_detached(dataToSign, signingKeyBytes);

            result = {
               state: { CK: bytesToB64(newCK) || '', N: currentN + 1 },
               header,
               ciphertext: combined,
               signature: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING),
               mk: Array.from(mk)
            };
        } finally {
            if (CKBytes) sodium.memzero(CKBytes);
            if (newCK) sodium.memzero(newCK);
            if (mk) sodium.memzero(mk);
            if (signingKeyBytes) sodium.memzero(signingKeyBytes);
            if (plaintextBytes) sodium.memzero(plaintextBytes); 
        }
        break;
      }
      case 'group_ratchet_decrypt': {
        const { serializedState, header, ciphertext, signature, senderSigningPublicKey } = payload;
        let CKBytes = b64ToBytes(serializedState.CK);
        if (!CKBytes) throw new Error("Invalid Group Chain Key");
        const ciphertextBytes = new Uint8Array(ciphertext);
        const signatureBytes = b64ToBytes(signature);
        const signingPublicKeyBytes = new Uint8Array(senderSigningPublicKey);

        if (!signatureBytes) throw new Error("Missing signature");

        const dataToVerify = new Uint8Array(4 + ciphertextBytes.length);
        new DataView(dataToVerify.buffer).setUint32(0, header.n, false);
        dataToVerify.set(ciphertextBytes, 4);

        const isValid = sodium.crypto_sign_verify_detached(signatureBytes, dataToVerify, signingPublicKeyBytes);
        if (!isValid) throw new Error("Invalid group message signature. Potential spoofing detected!");

        let currentN = serializedState.N || 0;
        let mk: Uint8Array | null = null;
        const skippedKeys: { dh?: string; epk?: string; n: number; mk: string }[] = [];

        const MAX_SKIP = 2000;
        if (header.n - currentN > MAX_SKIP) {
            sodium.memzero(CKBytes);
            throw new Error(`Too many skipped messages (${header.n - currentN}). Potential DoS attack.`);
        }

        while (currentN < header.n) {
           const [nextCK, skippedMK] = await kdfChain(CKBytes);
           skippedKeys.push({ n: currentN, mk: bytesToB64(skippedMK) || '' });
           sodium.memzero(CKBytes);
           CKBytes = nextCK;
           currentN++;
        }

        if (currentN === header.n) {
           const [nextCK, messageKey] = await kdfChain(CKBytes);
           mk = messageKey;
           sodium.memzero(CKBytes);
           CKBytes = nextCK;
           currentN++;
        } else {
           throw new Error("Message N is older than current state. Possibly replayed or already decrypted.");
        }

        const nonce = ciphertextBytes.slice(0, 24);
        const ctext = ciphertextBytes.slice(24);
        const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, ctext, null, nonce, mk
        );

        result = {
           state: { CK: bytesToB64(CKBytes) || '', N: currentN },
           plaintext,
           skippedKeys,
           mk: Array.from(mk)
        };

        sodium.memzero(CKBytes);
        if (mk) sodium.memzero(mk);
        break;
      }
      case 'group_decrypt_skipped': {
        const { mk, headerN, ciphertext, signature, senderSigningPublicKey } = payload;
        const mkBytes = b64ToBytes(mk);
        const ciphertextBytes = new Uint8Array(ciphertext);
        const signatureBytes = b64ToBytes(signature);
        const signingPublicKeyBytes = new Uint8Array(senderSigningPublicKey);

        if (!mkBytes) throw new Error("Invalid skipped message key");
        if (!signatureBytes) throw new Error("Missing signature");

        try {
          const dataToVerify = new Uint8Array(4 + ciphertextBytes.length);
          new DataView(dataToVerify.buffer).setUint32(0, headerN, false);
          dataToVerify.set(ciphertextBytes, 4);

          const isValid = sodium.crypto_sign_verify_detached(signatureBytes, dataToVerify, signingPublicKeyBytes);
          if (!isValid) throw new Error("Invalid group message signature (skipped key). Potential spoofing detected!");

          const nonce = ciphertextBytes.slice(0, 24);
          const ctext = ciphertextBytes.slice(24);
          const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
              null, ctext, null, nonce, mkBytes
          );

          result = { plaintext };
        } finally {
          sodium.memzero(mkBytes);
        }
        break;
      }
      // --- BURNER PROTOCOL (EXCLUSIVE PQ-DR) ---

      case 'burner_dr_init_guest': {
        const { hostClassicalPk, hostPqPk } = payload as { hostClassicalPk: CryptoBuffer, hostPqPk: CryptoBuffer };
        const hCPK = new Uint8Array(hostClassicalPk);
        const hPQPK = new Uint8Array(hostPqPk);
        
        let pqKeypair: { publicKey: Uint8Array, privateKey: Uint8Array } | null = null;
        let guestClassicalKeypair: SodiumKeyPair | null = null;

        try {
          pqKeypair = sodium.crypto_kem_xwing_keypair();
          guestClassicalKeypair = sodium.crypto_box_keypair();
          
          if (!pqKeypair || !guestClassicalKeypair) {
             throw new Error("Keypair generation failed");
          }

          // Encapsulate ke Host (PQ)
          const pqResult = sodium.crypto_kem_xwing_enc(hPQPK);
          
          // Key Exchange Klasik (X25519)
          const classicalShared = sodium.crypto_scalarmult(guestClassicalKeypair.privateKey, hCPK);
          
          // Gabungkan (Hybrid PQ-DR Root Key)
          const combinedSecret = new Uint8Array(classicalShared.length + pqResult.sharedSecret.length);
          combinedSecret.set(classicalShared, 0);
          combinedSecret.set(pqResult.sharedSecret, classicalShared.length);

          const KDF = sodium.crypto_generichash(64, combinedSecret, null);
          
          const state: BurnerDoubleRatchetState = {
            RK: bytesToB64(KDF.slice(0, 32)) || null,
            CKs: bytesToB64(KDF.slice(32, 64)) || null,
            CKr: null,
            KEMs_pub: pqKeypair ? bytesToB64(pqKeypair.publicKey) || null : null,
            KEMs_priv: pqKeypair ? bytesToB64(pqKeypair.privateKey) || null : null,
            KEMr: bytesToB64(hPQPK) || null,
            savedCt: bytesToB64(pqResult.ciphertext) || null,
            Ns: 0, Nr: 0, PN: 0
          };
          
          result = { 
            state, 
            guestClassicalPk: guestClassicalKeypair && guestClassicalKeypair.publicKey ? bytesToB64(new Uint8Array(guestClassicalKeypair.publicKey as Iterable<number>)) || '' : ''
          };
          
          sodium.memzero(KDF);
          sodium.memzero(combinedSecret);
        } finally {
           // Bersihkan memori worker
           if (pqKeypair) sodium.memzero(pqKeypair.privateKey);
           if (guestClassicalKeypair) sodium.memzero(guestClassicalKeypair.privateKey);
           sodium.memzero(hCPK);
           sodium.memzero(hPQPK);
        }
        break;
      }

      case 'burner_dr_init_host': {
        const { guestClassicalPk, hostClassicalSk, savedCt, hostPqSk } = payload as { guestClassicalPk: CryptoBuffer, hostClassicalSk: CryptoBuffer, savedCt: CryptoBuffer, hostPqSk: CryptoBuffer };
        const gCPK = new Uint8Array(guestClassicalPk);
        const hCSK = new Uint8Array(hostClassicalSk);
        const ct = new Uint8Array(savedCt);
        const hPQSK = new Uint8Array(hostPqSk);

        try {
          // Decapsulate dari Guest (PQ)
          const pqSharedSecret = sodium.crypto_kem_xwing_dec(ct, hPQSK);

          // Key Exchange Klasik (X25519)
          const classicalShared = sodium.crypto_scalarmult(hCSK, gCPK);

          // Gabungkan
          const combinedSecret = new Uint8Array(classicalShared.length + pqSharedSecret.length);
          combinedSecret.set(classicalShared, 0);
          combinedSecret.set(pqSharedSecret, classicalShared.length);

          const KDF = sodium.crypto_generichash(64, combinedSecret, null);

          const state: BurnerDoubleRatchetState = {
            RK: bytesToB64(KDF.slice(0, 32)) || null,
            CKs: null,
            CKr: bytesToB64(KDF.slice(32, 64)) || null,
            KEMs_pub: null,
            KEMs_priv: null,
            KEMr: bytesToB64(gCPK) || null, // Not strictly correct, KEMr should be guest PQ PK if they ever sent one, but guest sent ct and generated ephemeral KEM
            savedCt: null,
            Ns: 0, Nr: 0, PN: 0
          };

          result = { state };

          sodium.memzero(KDF);
          sodium.memzero(combinedSecret);
          sodium.memzero(pqSharedSecret);
          sodium.memzero(classicalShared);
        } finally {
          sodium.memzero(gCPK);
          sodium.memzero(hCSK);
          sodium.memzero(ct);
          sodium.memzero(hPQSK);
        }
        break;
      }

      case 'burner_dr_encrypt': {
        const { state: serializedState, plaintext } = payload as { state: BurnerDoubleRatchetState, plaintext: CryptoBuffer | string };
        const state = { ...serializedState };
        const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);

        let mk: Uint8Array | null = null;
        let nonce: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;
        const cksBytes = state.CKs ? b64ToBytes(state.CKs) : null;

        try {
          if (!cksBytes) throw new Error("Cannot encrypt: CKs is null");

          const [newCKs, messageKey] = await kdfChain(cksBytes);
          sodium.memzero(cksBytes);
          state.CKs = bytesToB64(newCKs) || null;
          mk = messageKey;

          nonce = sodium.randombytes_buf(24);
          ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintextBytes, null, null, nonce, mk);
          
          if (!nonce || !ciphertext) throw new Error("Encryption failed");

          const combined = new Uint8Array(nonce.length + ciphertext.length);
          combined.set(nonce);
          combined.set(ciphertext, nonce.length);

          const header: BurnerDoubleRatchetHeader = {
            kemPk: state.KEMs_pub || '',
            ct: state.savedCt || '',
            n: state.Ns,
            pn: state.PN
          };

          state.Ns += 1;

          result = {
            state,
            header,
            ciphertext: Array.from(combined),
            mk: Array.from(mk)
          };
        } finally {
          if (mk) sodium.memzero(mk);
          if (nonce) sodium.memzero(nonce);
          if (ciphertext) sodium.memzero(ciphertext);
          sodium.memzero(plaintextBytes);
        }
        break;
      }

      case 'burner_dr_decrypt': {
        const { state: serializedState, header, ciphertext } = payload as { state: BurnerDoubleRatchetState, header: BurnerDoubleRatchetHeader, ciphertext: CryptoBuffer };
        const state = { ...serializedState };
        const ciphertextBytes = new Uint8Array(ciphertext);
        const headerKemPk = header.kemPk ? b64ToBytes(header.kemPk) : null;
        const headerCt = header.ct ? b64ToBytes(header.ct) : null;
        
        if (!headerKemPk) throw new Error("Missing kemPk in header");
        if (!state.RK) throw new Error("RK is missing");

        const rkBytes = b64ToBytes(state.RK);
        if (!rkBytes) throw new Error("RK invalid format");

        const skippedKeys: { kemPk: string, n: number, mk: string }[] = [];
        let mk: Uint8Array | null = null;
        let sharedSecret1: Uint8Array | null = null;
        let sharedSecret2: Uint8Array | null = null;
        let newKEMs: { publicKey: Uint8Array, privateKey: Uint8Array } | null = null;
        let plaintext: Uint8Array | null = null;

        try {
          const stateKemRBytes = state.KEMr ? b64ToBytes(state.KEMr) : null;

          const isNewKey = !stateKemRBytes || 
                           (headerKemPk.length !== stateKemRBytes.length) || 
                           (sodium.compare(headerKemPk, stateKemRBytes) !== 0);

          if (isNewKey) {
            // PRE-RATCHET SKIP LOOP
            const MAX_SKIP = 1000;
            if (header.pn - state.Nr > MAX_SKIP) {
              throw new Error(`Too many skipped messages: ${header.pn - state.Nr}`);
            }

            let ckrBytes = state.CKr ? b64ToBytes(state.CKr) : null;
            if (ckrBytes && state.KEMr) {
              while (state.Nr < header.pn) {
                const [nextCKr, skippedMK] = await kdfChain(ckrBytes);
                skippedKeys.push({ kemPk: state.KEMr, n: state.Nr, mk: bytesToB64(skippedMK) || '' });
                sodium.memzero(ckrBytes);
                ckrBytes = nextCKr;
                state.Nr++;
              }
              state.CKr = bytesToB64(ckrBytes) || null;
            }

            if (headerCt && state.KEMs_priv) {
              const kemsPrivBytes = b64ToBytes(state.KEMs_priv);
              if (kemsPrivBytes) {
                const pqSharedSecret = sodium.crypto_kem_xwing_dec(headerCt, kemsPrivBytes);
                sharedSecret1 = new Uint8Array(32 + pqSharedSecret.length);
                sharedSecret1.set(rkBytes, 0);
                sharedSecret1.set(pqSharedSecret, 32);

                const KDF1 = sodium.crypto_generichash(64, sharedSecret1, null);
                
                rkBytes.set(KDF1.slice(0, 32));
                state.RK = bytesToB64(rkBytes) || null;
                state.CKr = bytesToB64(KDF1.slice(32, 64)) || null;
                
                sodium.memzero(pqSharedSecret);
                sodium.memzero(KDF1);
                sodium.memzero(kemsPrivBytes);
              }
            }

            state.PN = state.Ns;
            state.Ns = 0;
            state.Nr = 0;
            state.KEMr = header.kemPk;

            newKEMs = sodium.crypto_kem_xwing_keypair();
            if (!newKEMs) throw new Error("KEM Keypair generation failed");
            const pqResult = sodium.crypto_kem_xwing_enc(headerKemPk);
            state.savedCt = bytesToB64(pqResult.ciphertext) || null;

            sharedSecret2 = new Uint8Array(32 + pqResult.sharedSecret.length);
            sharedSecret2.set(rkBytes, 0);
            sharedSecret2.set(pqResult.sharedSecret, 32);

            const KDF2 = sodium.crypto_generichash(64, sharedSecret2, null);
            rkBytes.set(KDF2.slice(0, 32));
            state.RK = bytesToB64(rkBytes) || null;
            state.CKs = bytesToB64(KDF2.slice(32, 64)) || null;
            
            sodium.memzero(pqResult.sharedSecret);
            sodium.memzero(KDF2);

            state.KEMs_pub = bytesToB64(newKEMs.publicKey) || null;
            state.KEMs_priv = bytesToB64(newKEMs.privateKey) || null;
          }

          const MAX_SKIP = 1000;
          if (header.n - state.Nr > MAX_SKIP) {
            throw new Error(`Too many skipped messages: ${header.n - state.Nr}`);
          }

          let ckrBytes = state.CKr ? b64ToBytes(state.CKr) : null;
          while (state.Nr < header.n) {
            if (!ckrBytes) throw new Error("CKr is missing");
            const [nextCKr, skippedMK] = await kdfChain(ckrBytes);
            skippedKeys.push({ kemPk: header.kemPk, n: state.Nr, mk: bytesToB64(skippedMK) || '' });
            sodium.memzero(ckrBytes);
            ckrBytes = nextCKr;
            state.Nr++;
          }

          if (state.Nr === header.n) {
            if (!ckrBytes) throw new Error("CKr is missing");
            const [nextCKr, messageKey] = await kdfChain(ckrBytes);
            mk = messageKey;
            sodium.memzero(ckrBytes);
            ckrBytes = nextCKr;
            state.Nr++;
          } else {
            throw new Error("Message N is older than current state");
          }
          state.CKr = bytesToB64(ckrBytes) || null;

          const nonce = ciphertextBytes.slice(0, 24);
          const ctext = ciphertextBytes.slice(24);
          plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ctext, null, nonce, mk);
          if (!plaintext) throw new Error("Decryption failed");

          result = {
            state,
            plaintext: Array.from(plaintext),
            skippedKeys,
            mk: Array.from(mk)
          };
        } finally {
          if (sharedSecret1) sodium.memzero(sharedSecret1);
          if (sharedSecret2) sodium.memzero(sharedSecret2);
          if (mk) sodium.memzero(mk);
          if (headerKemPk) sodium.memzero(headerKemPk);
          if (headerCt) sodium.memzero(headerCt);
          if (newKEMs) sodium.memzero(newKEMs.privateKey);
          if (plaintext) sodium.memzero(plaintext);
          if (rkBytes) sodium.memzero(rkBytes);
        }
        break;
      }

      default:
        self.postMessage({ type: 'error', id, error: `Unknown worker command: ${type}` });
        return;
    }
    
    self.postMessage({ success: true, id, result });

  } catch (error: unknown) {
    console.error('Error in crypto worker for type:', type, error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    self.postMessage({ success: false, id, error: errorMessage });
  }
};