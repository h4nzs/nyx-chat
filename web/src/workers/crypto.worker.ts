// web/src/workers/crypto.worker.ts
import { Buffer } from 'buffer/';
(self as any).Buffer = Buffer;

import sodium from 'libsodium-wrappers';
import * as bip39 from 'bip39';

let isReady = false;
const B64_VARIANT = 'URLSAFE_NO_PADDING';

// --- HELPER FUNCTIONS (Moved from keyManagement.ts and auth.ts) ---

function exportPublicKey(publicKey: Uint8Array): string {
  return sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function storePrivateKeys(keys: {
  encryption: Uint8Array,
  signing: Uint8Array,
  signedPreKey: Uint8Array,
  masterSeed?: Uint8Array
}, password: string, appSecret: string): string {
  const privateKeysJson = JSON.stringify({
    encryption: sodium.to_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
    signing: sodium.to_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
    signedPreKey: sodium.to_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
    masterSeed: keys.masterSeed ? sodium.to_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
  });

  const salt = sodium.randombytes_buf(32);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

  const combinedPass = `${appSecret}-${password}`;
  const keyInput = new Uint8Array(salt.length + sodium.from_string(combinedPass).length);
  keyInput.set(salt);
  keyInput.set(sodium.from_string(combinedPass), salt.length);
  const key = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, keyInput);

  const ciphertext = sodium.crypto_secretbox_easy(privateKeysJson, nonce, key);
  const result = new Uint8Array(salt.length + nonce.length + ciphertext.length);
  result.set(salt, 0);
  result.set(nonce, salt.length);
  result.set(ciphertext, salt.length + nonce.length);

  return sodium.to_base64(result, sodium.base64_variants[B64_VARIANT]);
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

function retrievePrivateKeys(encryptedDataStr: string, password: string, appSecret: string): RetrieveKeysResult {
  try {
    if (!encryptedDataStr) return { success: false, reason: 'keys_not_found' };

    const encryptedData = sodium.from_base64(encryptedDataStr, sodium.base64_variants[B64_VARIANT]);
    const salt = encryptedData.slice(0, 32);
    const nonce = encryptedData.slice(32, 32 + sodium.crypto_secretbox_NONCEBYTES);
    const encryptedJson = encryptedData.slice(32 + sodium.crypto_secretbox_NONCEBYTES);

    const combinedPass = `${appSecret}-${password}`;
    const keyInput = new Uint8Array(salt.length + sodium.from_string(combinedPass).length);
    keyInput.set(salt);
    keyInput.set(sodium.from_string(combinedPass), salt.length);
    const key = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, keyInput);

    const decryptedJson = sodium.crypto_secretbox_open_easy(encryptedJson, nonce, key);
    if (!decryptedJson) return { success: false, reason: 'incorrect_password' };
    
    const keys = JSON.parse(sodium.to_string(decryptedJson));
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
  } catch (error) {
    console.error("Failed to retrieve private keys due to unexpected error:", error);
    return { success: false, reason: 'decryption_failed' };
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
    const digitGroups = chunks.map(chunk => parseInt(chunk, 16).toString().padStart(5, '0').slice(-5));
    
    return digitGroups.join(' ');
}


// --- MESSAGE HANDLER ---
const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

self.onmessage = async (event: MessageEvent) => {
  const { type, payload, id } = event.data;

  // Wait for sodium to be ready
  if (!isReady) {
    await sodium.ready;
    isReady = true;
    if (type === 'init') {
      self.postMessage({ type: 'init_result', id, result: true });
      return;
    }
  }

  // App secret is required for most operations
  const appSecret = payload?.appSecret || import.meta.env.VITE_APP_SECRET;
  if (!appSecret && type !== 'init' && type !== 'generateSafetyNumber') {
      self.postMessage({ type: 'error', id, error: "VITE_APP_SECRET is required for crypto operations." });
      return;
  }

  try {
    let result: any;
    switch (type) {
      case 'registerAndGenerateKeys': {
        const { password } = payload;
        const masterSeed = sodium.randombytes_buf(32);
        const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        
        const encryptionPublicKeyB64 = exportPublicKey(encryptionKeyPair.publicKey);
        const signingPublicKeyB64 = exportPublicKey(signingKeyPair.publicKey);
        
        const encryptedPrivateKeys = storePrivateKeys({
          encryption: encryptionKeyPair.privateKey,
          signing: signingKeyPair.privateKey,
          signedPreKey: signedPreKeyPair.privateKey,
          masterSeed: masterSeed
        }, password, appSecret);

        const phrase = bip39.entropyToMnemonic(masterSeed);
        
        result = {
            encryptionPublicKeyB64,
            signingPublicKeyB64,
            encryptedPrivateKeys,
            phrase
        };
        break;
      }

      case 'retrievePrivateKeys': {
        const { encryptedDataStr, password } = payload;
        result = retrievePrivateKeys(encryptedDataStr, password, appSecret);
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
        
        if (!sodium.crypto_sign_verify_detached(signature, theirSignedPreKey, theirSigningKey)) {
          throw new Error("Invalid signature on signed pre-key.");
        }

        const ephemeralKeyPair = sodium.crypto_box_keypair();
        
        const dh1 = sodium.crypto_scalarmult(myIdentityKey.privateKey, theirSignedPreKey);
        const dh2 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirIdentityKey);
        const dh3 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirSignedPreKey);
      
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

        const dh1 = sodium.crypto_scalarmult(mySignedPreKey.privateKey, theirIdentityKey);
        const dh2 = sodium.crypto_scalarmult(myIdentityKey.privateKey, theirEphemeralKey);
        const dh3 = sodium.crypto_scalarmult(mySignedPreKey.privateKey, theirEphemeralKey);
      
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
        result = {
            encryptedData,
            iv,
            key: new Uint8Array(exportedKey)
        };
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
        const resultData = retrievePrivateKeys(encryptedDataStr, password, appSecret);
        if (resultData.success && resultData.keys.masterSeed) {
          result = bip39.entropyToMnemonic(resultData.keys.masterSeed);
        } else {
          throw new Error("Failed to retrieve master seed from bundle.");
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
        
        const encryptionPublicKeyB64 = exportPublicKey(encryptionKeyPair.publicKey);
        const signingPublicKeyB64 = exportPublicKey(signingKeyPair.publicKey);
        
        const encryptedPrivateKeys = storePrivateKeys({
          encryption: encryptionKeyPair.privateKey,
          signing: signingKeyPair.privateKey,
          signedPreKey: signedPreKeyPair.privateKey,
          masterSeed: masterSeed
        }, password, appSecret);

        result = {
          encryptionPublicKeyB64,
          signingPublicKeyB64,
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
        
        const encryptionPublicKeyB64 = exportPublicKey(encryptionKeyPair.publicKey);
        const signingPublicKeyB64 = exportPublicKey(signingKeyPair.publicKey);

        const encryptedPrivateKeys = storePrivateKeys({
          encryption: encryptionKeyPair.privateKey,
          signing: signingKeyPair.privateKey,
          signedPreKey: signedPreKeyPair.privateKey,
          masterSeed: masterKey,
        }, newPassword, appSecret);

        result = {
          encryptedPrivateKeys,
          encryptionPublicKeyB64,
          signingPublicKeyB64,
        };
        break;
      }

      default:
        throw new Error(`Unknown worker command: ${type}`);
    }
    // Post the result back to the main thread
    self.postMessage({ type: `${type}_result`, id, result });

  } catch (error: any) {
    self.postMessage({
      type: 'error',
      id: id,
      error: error.message || 'An unknown error occurred in the crypto worker',
    });
  }
};

console.log('Crypto worker loaded.');
