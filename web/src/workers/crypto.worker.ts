// web/src/workers/crypto.worker.ts
import { Buffer } from 'buffer/';
(self as any).Buffer = Buffer;

import sodium from 'libsodium-wrappers';
import * as bip39 from 'bip39';
import { argon2id } from 'hash-wasm';
import { v4 as uuidv4 } from 'uuid';

let isReady = false;
const B64_VARIANT = 'URLSAFE_NO_PADDING';

// Konfigurasi Argon2
const ARGON_CONFIG = {
  parallelism: 1,
  iterations: 3,
  memorySize: 32768, // 32 MB
  hashLength: 32,
  outputType: 'binary' as const,
};

// --- INTERNAL HELPER FUNCTIONS FOR CORE CRYPTO LOGIC ---

async function _hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ikm as any,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as any,
      info: info as any
    },
    keyMaterial,
    length * 8
  );

  return new Uint8Array(derivedBits);
}

export async function kdfRoot(rootKey: Uint8Array, dhOutput: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const info = new TextEncoder().encode("NYX_Double_Ratchet_Root");
  const derived = await _hkdf(dhOutput, rootKey, info, 64);
  const newRootKey = derived.slice(0, 32);
  const chainKey = derived.slice(32, 64);
  return [newRootKey, chainKey];
}

export async function kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const key = await crypto.subtle.importKey(
    "raw",
    chainKey as any,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const messageKeyInput = new Uint8Array([0x01]);
  const newChainKeyInput = new Uint8Array([0x02]);

  const messageKey = new Uint8Array(await crypto.subtle.sign("HMAC", key, messageKeyInput));
  const newChainKey = new Uint8Array(await crypto.subtle.sign("HMAC", key, newChainKeyInput));

  return [newChainKey, messageKey];
}

async function _deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({
    ...ARGON_CONFIG,
    password,
    salt,
  });
}

async function _encryptData(keyBytes: Uint8Array, data: any): Promise<string> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(keyBytes),
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

    return JSON.stringify({
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(encryptedContent))
    });
  } finally {
    if (keyBytes && keyBytes.length > 0) {
      try {
        sodium.memzero(keyBytes);
      } catch (e) {
        keyBytes.fill(0);
      }
    }
  }
}

async function _decryptData(keyBytes: Uint8Array, encryptedString: string): Promise<any> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const { iv: ivArr, data: dataArr } = JSON.parse(encryptedString);
    const iv = new Uint8Array(ivArr);
    const ciphertext = new Uint8Array(dataArr);

    const decryptedContent = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
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
      } catch (e) {
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
  signing: Uint8Array,
  signedPreKey: Uint8Array,
  masterSeed?: Uint8Array
}, password: string): Promise<string> {
  const privateKeysJson = JSON.stringify({
    encryption: sodium.to_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
    signing: sodium.to_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
    signedPreKey: sodium.to_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
    masterSeed: keys.masterSeed ? sodium.to_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
  });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  let kek: Uint8Array | null = null;

  try {
    // Directly call the internal helper functions
    kek = await _deriveKey(password, salt);
    const encryptedData = await _encryptData(kek, privateKeysJson);

    // Combine salt and encrypted data
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
  signing: Uint8Array,
  signedPreKey: Uint8Array,
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
      
      // Directly call the internal helper functions
      kek = await _deriveKey(password, salt);
      const privateKeysJson = await _decryptData(kek, encryptedString);

      const keys = JSON.parse(privateKeysJson);
      if (!keys.signedPreKey) return { success: false, reason: 'legacy_bundle' };

      return {
        success: true,
        keys: {
          encryption: sodium.from_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
          signing: sodium.from_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
          signedPreKey: sodium.from_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
          masterSeed: keys.masterSeed ? sodium.from_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
        }
      };
    } catch (error: any) {
      // Argon2id or subtle.decrypt can throw. If it's a decrypt error, it's likely a wrong password.
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
  
    const hash = sodium.crypto_generichash(64, combined);
  
    const fingerprint = sodium.to_hex(hash.slice(0, 30));
    const chunks = fingerprint.match(/.{1,10}/g) || [];
    const digitGroups = chunks.map((chunk: string) => parseInt(chunk, 16).toString().padStart(5, '0').slice(-5));
    
    return digitGroups.join(' ');
}

// --- DOUBLE RATCHET STATE HELPERS ---

function b64ToBytes(str: string | null | undefined): Uint8Array | null {
  return str ? sodium.from_base64(str, sodium.base64_variants.URLSAFE_NO_PADDING) : null;
}

function bytesToB64(bytes: Uint8Array | null | undefined): string | null {
  return bytes ? sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING) : null;
}

function deserializeState(state: any) {
  return {
    RK: b64ToBytes(state.RK),
    CKs: b64ToBytes(state.CKs),
    CKr: b64ToBytes(state.CKr),
    DHs: state.DHs ? {
      publicKey: b64ToBytes(state.DHs.publicKey),
      privateKey: b64ToBytes(state.DHs.privateKey)
    } : null,
    DHr: b64ToBytes(state.DHr),
    Ns: state.Ns,
    Nr: state.Nr,
    PN: state.PN
  };
}

function serializeState(state: any) {
  return {
    RK: bytesToB64(state.RK),
    CKs: bytesToB64(state.CKs),
    CKr: bytesToB64(state.CKr),
    DHs: state.DHs ? {
      publicKey: bytesToB64(state.DHs.publicKey),
      privateKey: bytesToB64(state.DHs.privateKey)
    } : null,
    DHr: bytesToB64(state.DHr),
    Ns: state.Ns,
    Nr: state.Nr,
    PN: state.PN
  };
}

function wipeState(state: any) {
  if (state.RK) sodium.memzero(state.RK);
  if (state.CKs) sodium.memzero(state.CKs);
  if (state.CKr) sodium.memzero(state.CKr);
  if (state.DHs && state.DHs.privateKey) sodium.memzero(state.DHs.privateKey);
}

// --- MAIN MESSAGE HANDLER ---
const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

self.onmessage = async (event: MessageEvent) => {
  const { type, payload, id } = event.data;

  if (!isReady) {
    await sodium.ready;
    isReady = true;
  }
  
  try {
    let result: any;
    // The main message handler now orchestrates calls to the internal functions.
    // The recursive postMessage calls are gone.
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
        const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        
        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            masterSeed: masterSeed
          }, password);

          const phrase = await bip39.entropyToMnemonic(Buffer.from(masterSeed) as any);
          
          result = {
              encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
              signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
              encryptedPrivateKeys,
              phrase
          };
        } finally {
          sodium.memzero(masterSeed);
          sodium.memzero(encryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
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
        const messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
        const nonceBytes = new Uint8Array(nonce);
        const keyBytes = new Uint8Array(key);
        
        // Use AEAD IETF version: message, ad, secret_nonce, public_nonce, key
        result = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          messageBytes, 
          null, 
          null, 
          nonceBytes, 
          keyBytes
        );
        break;
      }
      case 'crypto_secretbox_xchacha20poly1305_open_easy': {
        const { ciphertext, nonce, key } = payload;
        const ciphertextBytes = new Uint8Array(ciphertext);
        const nonceBytes = new Uint8Array(nonce);
        const keyBytes = new Uint8Array(key);

        // Use AEAD IETF version: secret_nonce, ciphertext, ad, public_nonce, key
        result = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          ciphertextBytes,
          null,
          nonceBytes,
          keyBytes
        );
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
      case 'x3dh_initiator': {
        const { myIdentityKey, theirIdentityKey, theirSignedPreKey, theirSigningKey, signature, theirOneTimePreKey } = payload;

        const signatureBytes = new Uint8Array(signature);
        const theirSignedPreKeyBytes = new Uint8Array(theirSignedPreKey);
        const theirSigningKeyBytes = new Uint8Array(theirSigningKey);

        if (!sodium.crypto_sign_verify_detached(signatureBytes, theirSignedPreKeyBytes, theirSigningKeyBytes)) {
          throw new Error("Invalid signature on signed pre-key.");
        }

        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const theirIdentityKeyBytes = new Uint8Array(theirIdentityKey);
        
        const ephemeralKeyPair = sodium.crypto_box_keypair();
        let sharedSecret: Uint8Array | null = null;
        let dh4: Uint8Array | null = null;

        try {
          const dh1 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirSignedPreKeyBytes);
          const dh2 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirIdentityKeyBytes);
          const dh3 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirSignedPreKeyBytes);

          const secrets = [dh1, dh2, dh3];

          // DH4: Ephemeral (Alice) * One-Time Pre-Key (Bob)
          if (theirOneTimePreKey) {
             const theirOneTimePreKeyBytes = new Uint8Array(theirOneTimePreKey);
             dh4 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirOneTimePreKeyBytes);
             secrets.push(dh4);
          }

          // Concatenate all shared secrets
          const totalLength = secrets.reduce((sum, s) => sum + s.length, 0);
          sharedSecret = new Uint8Array(totalLength);
          let offset = 0;
          for (const s of secrets) {
              sharedSecret.set(s, offset);
              offset += s.length;
              sodium.memzero(s); // Wipe intermediate
          }
          
          const sessionKey = sodium.crypto_generichash(32, sharedSecret);

          result = {
              sessionKey,
              ephemeralPublicKey: sodium.to_base64(ephemeralKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
          };
        } finally {
          sodium.memzero(myIdentityKeyPrivateBytes);
          sodium.memzero(ephemeralKeyPair.privateKey);
          if (sharedSecret) sodium.memzero(sharedSecret);
        }
        break;
      }
      case 'x3dh_recipient': {
        const { myIdentityKey, mySignedPreKey, theirIdentityKey, theirEphemeralKey, myOneTimePreKey } = payload;
        
        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const mySignedPreKeyPrivateBytes = new Uint8Array(mySignedPreKey.privateKey);
        const theirIdentityKeyBytes = new Uint8Array(theirIdentityKey);
        const theirEphemeralKeyBytes = new Uint8Array(theirEphemeralKey);

        let sharedSecret: Uint8Array | null = null;
        let dh4: Uint8Array | null = null;

        try {
          const dh1 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirIdentityKeyBytes);
          const dh2 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirEphemeralKeyBytes);
          const dh3 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirEphemeralKeyBytes);
        
          const secrets = [dh1, dh2, dh3];

          // DH4: One-Time Pre-Key (Bob) * Ephemeral (Alice)
          if (myOneTimePreKey) {
             const myOneTimePreKeyBytes = new Uint8Array(myOneTimePreKey);
             dh4 = sodium.crypto_scalarmult(myOneTimePreKeyBytes, theirEphemeralKeyBytes);
             secrets.push(dh4);
          }

          const totalLength = secrets.reduce((sum, s) => sum + s.length, 0);
          sharedSecret = new Uint8Array(totalLength);
          let offset = 0;
          for (const s of secrets) {
              sharedSecret.set(s, offset);
              offset += s.length;
              sodium.memzero(s);
          }

          result = sodium.crypto_generichash(32, sharedSecret); // Returns the sessionKey
        } finally {
          sodium.memzero(myIdentityKeyPrivateBytes);
          sodium.memzero(mySignedPreKeyPrivateBytes);
          if (myOneTimePreKey) sodium.memzero(new Uint8Array(myOneTimePreKey)); // Wipe passed key if array
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
        // Ensure fileBuffer is Uint8Array
        const fileBytes = new Uint8Array(fileBuffer);
        
        const key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LENGTH }, true, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encryptedData = await crypto.subtle.encrypt({ name: ALGO, iv }, key, fileBytes);
        const exportedKey = await crypto.subtle.exportKey('raw', key);
        result = { encryptedData, iv, key: new Uint8Array(exportedKey) };
        break;
      }
      case 'file_decrypt': {
        const { combinedData, keyBytes } = payload;
        
        // Convert plain array keyBytes to Uint8Array for importKey
        const keyBytesUint8 = new Uint8Array(keyBytes);
        const key = await crypto.subtle.importKey('raw', keyBytesUint8, { name: ALGO }, false, ['decrypt']);
        
        // Ensure combinedData is a Uint8Array for slicing
        const dataBytes = new Uint8Array(combinedData);
        const iv = dataBytes.slice(0, IV_LENGTH);
        const encryptedData = dataBytes.slice(IV_LENGTH);
        
        result = await crypto.subtle.decrypt({ name: ALGO, iv }, key, encryptedData);
        break;
      }
      case 'getRecoveryPhrase': {
        const { encryptedDataStr, password } = payload;
        const resultData = await retrievePrivateKeys(encryptedDataStr, password);
        if (resultData.success && resultData.keys.masterSeed) {
          result = await bip39.entropyToMnemonic(Buffer.from(resultData.keys.masterSeed) as any);
        } else {
          throw new Error("Failed to retrieve master seed. Incorrect password or invalid bundle.");
        }
        break;
      }
      case 'restoreFromPhrase': {
        const { phrase, password } = payload;
        const masterSeedHex = bip39.mnemonicToEntropy(phrase);
        const masterSeed = sodium.from_hex(masterSeedHex);

        const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        
        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            masterSeed: masterSeed
          }, password);

          result = {
            encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
            signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
            encryptedPrivateKeys,
          };
        } finally {
          sodium.memzero(masterSeed);
          sodium.memzero(encryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
        }
        break;
      }
      case 'generate_random_key': {
        result = sodium.randombytes_buf(32);
        break;
      }
      case 'reEncryptBundleFromMasterKey': {
        const { masterKey, newPassword } = payload;
        const encryptionSeed = sodium.crypto_generichash(32, masterKey, new Uint8Array(new TextEncoder().encode("encryption")));
        const signingSeed = sodium.crypto_generichash(32, masterKey, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, masterKey, new Uint8Array(new TextEncoder().encode("signed-pre-key")));

        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);

        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            masterSeed: masterKey,
          }, newPassword);

          result = {
            encryptedPrivateKeys,
            encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
            signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
          };
        } finally {
          // Note: payload.masterKey is likely a reference to the array passed in. 
          // Wiping it is good practice, but since it came from postMessage it might be a copy.
          try { sodium.memzero(masterKey); } catch {} 
          sodium.memzero(encryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
        }
        break;
      }
      case 'encrypt_session_key': {
        const { sessionKey, masterSeed } = payload;
        const sessionKeyBytes = new Uint8Array(sessionKey);
        const masterSeedBytes = new Uint8Array(masterSeed);

        // Derive a specific key for storage encryption to protect the master seed
        const storageKey = sodium.crypto_generichash(32, masterSeedBytes, new Uint8Array(new TextEncoder().encode("session-storage")));
        
        let nonce: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;

        try {
          nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
          
          ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            sessionKeyBytes,
            null,
            null,
            nonce,
            storageKey
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
        
        const nonce = encryptedKeyBytes.slice(0, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
        const ciphertext = encryptedKeyBytes.slice(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

        try {
          result = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null,
            ciphertext,
            null,
            nonce,
            storageKey
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
          
          // DETERMINISTIC GENERATION
          // seed = Hash(MasterSeed || "OTPK" || KeyID)
          const seedInput = new Uint8Array(masterSeedBytes.length + 4 + 4); // 4 bytes for "OTPK", 4 bytes for ID
          seedInput.set(masterSeedBytes);
          seedInput.set(new TextEncoder().encode("OTPK"), masterSeedBytes.length);
          // Simple Little Endian encoding for ID
          const idBytes = new Uint8Array(new Uint32Array([keyId]).buffer); 
          seedInput.set(idBytes, masterSeedBytes.length + 4);

          const keySeed = sodium.crypto_generichash(32, seedInput);
          const keyPair = sodium.crypto_box_seed_keypair(keySeed);
          
          // Encrypt private key for storage
          const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
          const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            keyPair.privateKey,
            null,
            null,
            nonce,
            storageKey
          );
          
          const combined = new Uint8Array(nonce.length + ciphertext.length);
          combined.set(nonce);
          combined.set(ciphertext, nonce.length);
          
          batch.push({
            keyId,
            publicKey: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
            encryptedPrivateKey: combined
          });
          
          sodium.memzero(keySeed);
          sodium.memzero(keyPair.privateKey);
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
            theirIdentityKey, 
            theirEphemeralKey 
        } = payload;

        const masterSeedBytes = new Uint8Array(masterSeed);
        
        // 1. RE-DERIVE OTPK PRIVATE KEY
        const seedInput = new Uint8Array(masterSeedBytes.length + 4 + 4);
        seedInput.set(masterSeedBytes);
        seedInput.set(new TextEncoder().encode("OTPK"), masterSeedBytes.length);
        const idBytes = new Uint8Array(new Uint32Array([keyId]).buffer);
        seedInput.set(idBytes, masterSeedBytes.length + 4);

        const keySeed = sodium.crypto_generichash(32, seedInput);
        const otpkKeyPair = sodium.crypto_box_seed_keypair(keySeed);
        
        // 2. PREPARE KEYS FOR X3DH
        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const mySignedPreKeyPrivateBytes = new Uint8Array(mySignedPreKey.privateKey);
        const theirIdentityKeyBytes = new Uint8Array(theirIdentityKey);
        const theirEphemeralKeyBytes = new Uint8Array(theirEphemeralKey);

        let sharedSecret: Uint8Array | null = null;

        try {
          // 3. PERFORM X3DH CALCULATION
          const dh1 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirIdentityKeyBytes);
          const dh2 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirEphemeralKeyBytes);
          const dh3 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirEphemeralKeyBytes);
          const dh4 = sodium.crypto_scalarmult(otpkKeyPair.privateKey, theirEphemeralKeyBytes); // DH4 using regenerated key
        
          const secrets = [dh1, dh2, dh3, dh4];

          const totalLength = secrets.reduce((sum, s) => sum + s.length, 0);
          sharedSecret = new Uint8Array(totalLength);
          let offset = 0;
          for (const s of secrets) {
              sharedSecret.set(s, offset);
              offset += s.length;
              sodium.memzero(s);
          }

          result = sodium.crypto_generichash(32, sharedSecret); // Returns the sessionKey
        } finally {
          // 4. SECURE CLEANUP
          sodium.memzero(masterSeedBytes);
          sodium.memzero(seedInput);
          sodium.memzero(keySeed);
          sodium.memzero(otpkKeyPair.privateKey);
          
          sodium.memzero(myIdentityKeyPrivateBytes);
          sodium.memzero(mySignedPreKeyPrivateBytes);
          if (sharedSecret) sodium.memzero(sharedSecret);
        }
        break;
      }
      case 'dr_init_alice': {
        const { sk, theirSignedPreKeyPublic } = payload;
        const skBytes = new Uint8Array(sk);
        const theirSpkBytes = new Uint8Array(theirSignedPreKeyPublic);
        
        const DHs = sodium.crypto_box_keypair();
        const dh_out = sodium.crypto_scalarmult(DHs.privateKey, theirSpkBytes);
        
        const [RK, CKs] = await kdfRoot(skBytes, dh_out);
        
        const state = {
           RK, CKs, CKr: null,
           DHs, DHr: theirSpkBytes,
           Ns: 0, Nr: 0, PN: 0
        };
        
        result = serializeState(state);
        
        wipeState(state);
        sodium.memzero(skBytes);
        sodium.memzero(dh_out);
        break;
      }
      case 'dr_init_bob': {
        const { sk, mySignedPreKey } = payload;
        const skBytes = new Uint8Array(sk);
        
        const state = {
           RK: new Uint8Array(skBytes),
           CKs: null, CKr: null,
           DHs: {
             publicKey: new Uint8Array(mySignedPreKey.publicKey),
             privateKey: new Uint8Array(mySignedPreKey.privateKey)
           },
           DHr: null,
           Ns: 0, Nr: 0, PN: 0
        };
        
        result = serializeState(state);
        
        wipeState(state);
        sodium.memzero(skBytes);
        break;
      }
      case 'dr_ratchet_encrypt': {
        const { serializedState, plaintext } = payload;
        const state = deserializeState(serializedState);
        const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
        
        if (!state.CKs) throw new Error("Sender chain key not initialized");
        if (!state.DHs) throw new Error("Sender DH keypair not initialized");

        const [newCKs, mk] = await kdfChain(state.CKs);
        if (state.CKs) sodium.memzero(state.CKs);
        state.CKs = newCKs;
        
        const header = {
           dh: bytesToB64(state.DHs.publicKey),
           n: state.Ns,
           pn: state.PN
        };
        state.Ns += 1;
        
        const nonce = sodium.randombytes_buf(24);
        const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintextBytes, null, null, nonce, mk);
        
        const combined = new Uint8Array(nonce.length + ciphertext.length);
        combined.set(nonce);
        combined.set(ciphertext, nonce.length);
        
        result = {
           state: serializeState(state),
           header,
           ciphertext: combined
        };
        
        wipeState(state);
        sodium.memzero(mk);
        sodium.memzero(plaintextBytes);
        break;
      }
      case 'dr_ratchet_decrypt': {
        const { serializedState, header, ciphertext } = payload;
        const state = deserializeState(serializedState);
        const ciphertextBytes = new Uint8Array(ciphertext);
        const headerDhBytes = b64ToBytes(header.dh);
        
        if (!headerDhBytes) throw new Error("Invalid header DH key");

        let skippedKeys: any[] = [];
        
        try {
            if (!state.DHr || sodium.compare(headerDhBytes, state.DHr) !== 0) {
                if (state.CKr) {
                   while (state.Nr < header.pn) {
                      const [newCKr, mk] = await kdfChain(state.CKr);
                      sodium.memzero(state.CKr);
                      state.CKr = newCKr;
                      skippedKeys.push({ dh: bytesToB64(state.DHr), n: state.Nr, mk: bytesToB64(mk) });
                      state.Nr += 1;
                   }
                }
                
                state.PN = state.Ns;
                state.Ns = 0;
                state.Nr = 0;
                if (state.DHr) sodium.memzero(state.DHr);
                state.DHr = new Uint8Array(headerDhBytes);
                
                if (!state.DHs || !state.RK) throw new Error("Invalid state: missing DHs or RK");
                
                let dh_out = sodium.crypto_scalarmult(state.DHs.privateKey, state.DHr);
                const [RK1, CKr] = await kdfRoot(state.RK, dh_out);
                sodium.memzero(dh_out);
                sodium.memzero(state.RK);
                if (state.CKr) sodium.memzero(state.CKr);
                state.RK = RK1;
                state.CKr = CKr;
                
                if (state.DHs && state.DHs.privateKey) sodium.memzero(state.DHs.privateKey);
                state.DHs = sodium.crypto_box_keypair();
                
                if (!state.DHs) throw new Error("DH generation failed");

                dh_out = sodium.crypto_scalarmult(state.DHs.privateKey, state.DHr);
                const [RK2, CKs] = await kdfRoot(state.RK, dh_out);
                sodium.memzero(dh_out);
                sodium.memzero(state.RK);
                if (state.CKs) sodium.memzero(state.CKs);
                state.RK = RK2;
                state.CKs = CKs;
            }
            
            if (!state.CKr) throw new Error("Receiver chain key not initialized");

            while (state.Nr < header.n) {
                const [newCKr, mk] = await kdfChain(state.CKr);
                sodium.memzero(state.CKr);
                state.CKr = newCKr;
                skippedKeys.push({ dh: bytesToB64(state.DHr), n: state.Nr, mk: bytesToB64(mk) });
                state.Nr += 1;
            }
            
            const [newCKr, mk] = await kdfChain(state.CKr);
            sodium.memzero(state.CKr);
            state.CKr = newCKr;
            state.Nr += 1;
            
            const nonce = ciphertextBytes.slice(0, 24);
            const ctext = ciphertextBytes.slice(24);
            const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ctext, null, nonce, mk);
            
            result = {
               state: serializeState(state),
               plaintext,
               skippedKeys
            };
            
            sodium.memzero(mk);
        } finally {
            wipeState(state);
            sodium.memzero(headerDhBytes);
        }
        break;
      }
      default:
        self.postMessage({ type: 'error', id, error: `Unknown worker command: ${type}` });
        return;
    }
    
    // Post the result back to the main thread
    self.postMessage({ success: true, id, result });

  } catch (error: any) {
    console.error(`Error in crypto worker for type ${type}:`, error);
    self.postMessage({ success: false, id, error: error.message || 'An unknown error occurred' });
  }
};