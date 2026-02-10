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

async function _deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({
    ...ARGON_CONFIG,
    password,
    salt,
  });
}

async function _encryptData(keyBytes: Uint8Array, data: any): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes), // Create a new Uint8Array to ensure standard ArrayBuffer
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
}

async function _decryptData(keyBytes: Uint8Array, encryptedString: string): Promise<any> {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes), // Create a new Uint8Array to ensure standard ArrayBuffer
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
  
  // Directly call the internal helper functions
  const kek = await _deriveKey(password, salt);
  const encryptedData = await _encryptData(kek, privateKeysJson);

  // Combine salt and encrypted data
  return sodium.to_base64(salt, sodium.base64_variants[B64_VARIANT]) + '.' + encryptedData;
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
    try {
      if (!encryptedDataWithSaltStr) return { success: false, reason: 'keys_not_found' };

      const parts = encryptedDataWithSaltStr.split('.');
      if (parts.length !== 2) return { success: false, reason: 'decryption_failed' };

      const salt = sodium.from_base64(parts[0], sodium.base64_variants[B64_VARIANT]);
      const encryptedString = parts[1];
      
      // Directly call the internal helper functions
      const kek = await _deriveKey(password, salt);
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
        break;
      }
      case 'retrievePrivateKeys': {
        const { encryptedDataStr, password } = payload;
        result = await retrievePrivateKeys(encryptedDataStr, password);
        break;
      }
      case 'generateSafetyNumber': {
        const { myPublicKey, theirPublicKey } = payload;
        result = generateSafetyNumber(myPublicKey, theirPublicKey);
        break;
      }
      case 'crypto_secretbox_easy': {
        const { message, nonce, key } = payload;
        result = sodium.crypto_secretbox_easy(message, nonce, key);
        break;
      }
      case 'crypto_secretbox_open_easy': {
        const { ciphertext, nonce, key } = payload;
        result = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
        break;
      }
      case 'crypto_box_seal_open': {
        const { ciphertext, publicKey, privateKey } = payload;
        result = sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey);
        break;
      }
      case 'x3dh_initiator': {
        const { myIdentityKey, theirIdentityKey, theirSignedPreKey, theirSigningKey, signature } = payload;

        const signatureBytes = new Uint8Array(signature);
        const theirSignedPreKeyBytes = new Uint8Array(theirSignedPreKey);
        const theirSigningKeyBytes = new Uint8Array(theirSigningKey);

        if (!sodium.crypto_sign_verify_detached(signatureBytes, theirSignedPreKeyBytes, theirSigningKeyBytes)) {
          throw new Error("Invalid signature on signed pre-key.");
        }

        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const theirIdentityKeyBytes = new Uint8Array(theirIdentityKey);
        
        const ephemeralKeyPair = sodium.crypto_box_keypair();
        const dh1 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirSignedPreKeyBytes);
        const dh2 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirIdentityKeyBytes);
        const dh3 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirSignedPreKeyBytes);

        const sharedSecret = new Uint8Array([...dh1, ...dh2, ...dh3]);
        const sessionKey = sodium.crypto_generichash(32, sharedSecret);

        result = {
            sessionKey,
            ephemeralPublicKey: sodium.to_base64(ephemeralKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        };
        break;
      }
      case 'x3dh_recipient': {
        const { myIdentityKey, mySignedPreKey, theirIdentityKey, theirEphemeralKey } = payload;
        
        const myIdentityKeyPrivateBytes = new Uint8Array(myIdentityKey.privateKey);
        const mySignedPreKeyPrivateBytes = new Uint8Array(mySignedPreKey.privateKey);
        const theirIdentityKeyBytes = new Uint8Array(theirIdentityKey);
        const theirEphemeralKeyBytes = new Uint8Array(theirEphemeralKey);

        const dh1 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirIdentityKeyBytes);
        const dh2 = sodium.crypto_scalarmult(myIdentityKeyPrivateBytes, theirEphemeralKeyBytes);
        const dh3 = sodium.crypto_scalarmult(mySignedPreKeyPrivateBytes, theirEphemeralKeyBytes);
      
        const sharedSecret = new Uint8Array([...dh1, ...dh2, ...dh3]);
        result = sodium.crypto_generichash(32, sharedSecret); // Returns the sessionKey
        break;
      }
      case 'crypto_box_seal': {
        const { message, publicKey } = payload;
        result = sodium.crypto_box_seal(message, publicKey);
        break;
      }
      case 'file_encrypt': {
        const { fileBuffer } = payload;
        const key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LENGTH }, true, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encryptedData = await crypto.subtle.encrypt({ name: ALGO, iv }, key, fileBuffer);
        const exportedKey = await crypto.subtle.exportKey('raw', key);
        result = { encryptedData, iv, key: new Uint8Array(exportedKey) };
        break;
      }
      case 'file_decrypt': {
        const { combinedData, keyBytes } = payload;
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: ALGO }, false, ['decrypt']);
        const iv = combinedData.slice(0, IV_LENGTH);
        const encryptedData = combinedData.slice(IV_LENGTH);
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