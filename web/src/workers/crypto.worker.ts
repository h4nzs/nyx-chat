// web/src/workers/crypto.worker.ts
import { Buffer } from 'buffer/';
(self as any).Buffer = Buffer;

import sodium from 'libsodium-wrappers';
import * as bip39 from 'bip39';
import { argon2id } from 'hash-wasm'; // <-- New import
import { v4 as uuidv4 } from 'uuid';

let isReady = false;
const B64_VARIANT = 'URLSAFE_NO_PADDING';

// Konfigurasi Argon2 (Harus imbang antara keamanan & performa di HP kentang)
const ARGON_CONFIG = {
  parallelism: 1,
  iterations: 3,
  memorySize: 32768, // 32 MB
  hashLength: 32,    // 32 bytes (256 bits) untuk AES-GCM Key
  outputType: 'binary' as const,
};

// --- HELPER FUNCTIONS (Moved from keyManagement.ts and auth.ts) ---

function exportPublicKey(publicKey: Uint8Array): string {
  return sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function storePrivateKeys(keys: {
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

  const salt = crypto.getRandomValues(new Uint8Array(16)); // Generate random salt for Argon2

  return new Promise(async (resolve, reject) => {
    try {
      // Send DERIVE_KEY message to self (worker) to get the KEK
      const kek = await new Promise<Uint8Array>((res, rej) => {
        const msgId = crypto.randomUUID();
        self.postMessage({ id: msgId, type: 'DERIVE_KEY', payload: { password, salt: Array.from(salt) } });
        self.onmessage = (e) => {
          if (e.data.id === msgId) {
            if (e.data.success) res(new Uint8Array(e.data.result));
            else rej(new Error(e.data.error));
          }
        };
      });

      // Send ENCRYPT_DATA message to self (worker) to encrypt the keys JSON
      const encryptedData = await new Promise<string>((res, rej) => {
        const msgId = uuidv4();
        self.postMessage({ id: msgId, type: 'ENCRYPT_DATA', payload: { keyBytes: kek, data: privateKeysJson } });
        self.onmessage = (e) => {
          if (e.data.id === msgId) {
            if (e.data.success) res(e.data.result);
            else rej(new Error(e.data.error));
          }
        };
      });

      // Combine salt and encrypted data (now a string)
      resolve(sodium.to_base64(salt, sodium.base64_variants[B64_VARIANT]) + '.' + encryptedData);

    } catch (error) {
      reject(error);
    }
  });
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

function retrievePrivateKeys(encryptedDataWithSaltStr: string, password: string): Promise<RetrieveKeysResult> {
  return new Promise(async (resolve) => {
    try {
      if (!encryptedDataWithSaltStr) return resolve({ success: false, reason: 'keys_not_found' });

      const parts = encryptedDataWithSaltStr.split('.');
      if (parts.length !== 2) return resolve({ success: false, reason: 'decryption_failed' }); // Format is salt.encryptedJson

      const salt = sodium.from_base64(parts[0], sodium.base64_variants[B64_VARIANT]);
      const encryptedString = parts[1];

      // Send DERIVE_KEY message to self (worker) to get the KEK
      const kek = await new Promise<Uint8Array>((res, rej) => {
        const msgId = uuidv4();
        self.postMessage({ id: msgId, type: 'DERIVE_KEY', payload: { password, salt: Array.from(salt) } });
        self.onmessage = (e) => {
          if (e.data.id === msgId) {
            if (e.data.success) res(new Uint8Array(e.data.result));
            else rej(new Error(e.data.error));
          }
        };
      });

      // Send DECRYPT_DATA message to self (worker) to decrypt the keys JSON
      const privateKeysJson = await new Promise<string>((res, rej) => {
        const msgId = uuidv4();
        self.postMessage({ id: msgId, type: 'DECRYPT_DATA', payload: { keyBytes: kek, encryptedString } });
        self.onmessage = (e) => {
          if (e.data.id === msgId) {
            if (e.data.success) res(e.data.result);
            else rej(new Error(e.data.error));
          }
        };
      });

      const keys = JSON.parse(privateKeysJson);
      if (!keys.signedPreKey) return resolve({ success: false, reason: 'legacy_bundle' });

      resolve({
        success: true,
        keys: {
          encryption: sodium.from_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
          signing: sodium.from_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
          signedPreKey: sodium.from_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
          masterSeed: keys.masterSeed ? sodium.from_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
        }
      });
    } catch (error: any) {
      if (error.message && error.message.includes('incorrect_password')) {
        return resolve({ success: false, reason: 'incorrect_password' });
      }
      console.error("Failed to retrieve private keys due to unexpected error:", error);
      return resolve({ success: false, reason: 'decryption_failed' });
    }
  });
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
        try {
          let result: any;
          switch (type) {
            // === KDF: Derive Key dari Password (ARGON2) ===
            case 'DERIVE_KEY': {
              const { password, salt } = payload;
  
              const derivedKey = await argon2id({
                ...ARGON_CONFIG,
                password,
                salt: new Uint8Array(salt),
              });
              result = derivedKey;
              break;
            }
  
            // === ENCRYPT: Encrypt Data dengan Key (AES-GCM) ===
            case 'ENCRYPT_DATA': {
              const { keyBytes, data } = payload;
              
              const key = await crypto.subtle.importKey(
                'raw',
                keyBytes,
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
  
              result = JSON.stringify({
                iv: Array.from(iv),
                data: Array.from(new Uint8Array(encryptedContent))
              });
              break;
            }
  
            // === DECRYPT: Decrypt Data dengan Key (AES-GCM) ===
            case 'DECRYPT_DATA': {
              const { keyBytes, encryptedString } = payload;
  
              const key = await crypto.subtle.importKey(
                'raw',
                keyBytes,
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
                result = JSON.parse(decryptedString);
              } catch {
                result = decryptedString;
              }
              break;
            }      case 'registerAndGenerateKeys': {
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
        
        const encryptedPrivateKeys = await storePrivateKeys({
          encryption: encryptionKeyPair.privateKey,
          signing: signingKeyPair.privateKey,
          signedPreKey: signedPreKeyPair.privateKey,
          masterSeed: masterSeed
        }, password);

        // FIX: Tambahkan 'as any' karena tipe Buffer polyfill tidak identik dengan Buffer Node.js
        const phrase = await bip39.entropyToMnemonic(Buffer.from(masterSeed) as any);
        
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

        if (!sodium.crypto_sign_verify_detached(signature, theirSignedPreKey, theirSigningKey)) {
          throw new Error("Invalid signature on signed pre-key.");
        }

        // VERIFIKASI TAMBAHAN: Verifikasi bahwa kunci identitas cocok dengan kunci tanda tangan
        // Dalam protokol X3DH standar, identity key seharusnya juga ditandatangani
        // Kita bisa menambahkan verifikasi bahwa identity key cocok dengan informasi lain
        // Misalnya dengan memverifikasi bahwa identity key cocok dengan informasi yang diperoleh dari server
        // atau dengan menggunakan mekanisme verifikasi eksternal seperti safety numbers
        const identityVerification = sodium.crypto_generichash(32, theirIdentityKey);

        // Di sini kita bisa menambahkan logika untuk memverifikasi bahwa identity key
        // cocok dengan informasi yang diperoleh dari server atau sumber tepercaya lainnya
        // Untuk saat ini, kita hanya menambahkan verifikasi dasar bahwa kunci memiliki panjang yang benar
        if (theirIdentityKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
          throw new Error("Invalid identity key length.");
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
        const resultData = await retrievePrivateKeys(encryptedDataStr, password);
        if (resultData.success && resultData.keys.masterSeed) {
          // FIX: Tambahkan 'as any'
          result = await bip39.entropyToMnemonic(Buffer.from(resultData.keys.masterSeed) as any);
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
        
        const encryptedPrivateKeys = await storePrivateKeys({
          encryption: encryptionKeyPair.privateKey,
          signing: signingKeyPair.privateKey,
          signedPreKey: signedPreKeyPair.privateKey,
          masterSeed: masterSeed
        }, password);

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

        const encryptedPrivateKeys = await storePrivateKeys({
          encryption: encryptionKeyPair.privateKey,
          signing: signingKeyPair.privateKey,
          signedPreKey: signedPreKeyPair.privateKey,
          masterSeed: masterKey,
        }, newPassword);

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
