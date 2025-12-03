import { getSodium } from '@lib/sodiumInitializer';

const B64_VARIANT = 'URLSAFE_NO_PADDING';

export async function generateKeyPairs(): Promise<{
  encryption: { publicKey: Uint8Array, privateKey: Uint8Array },
  signing: { publicKey: Uint8Array, privateKey: Uint8Array }
}> {
  const sodium = await getSodium();
  return {
    encryption: sodium.crypto_box_keypair(),
    signing: sodium.crypto_sign_keypair(),
  };
}

export async function exportPublicKey(publicKey: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(publicKey, sodium.base64_variants[B64_VARIANT]);
}

export async function storePrivateKeys(keys: {
  encryption: Uint8Array,
  signing: Uint8Array,
  signedPreKey: Uint8Array,
  masterSeed?: Uint8Array
}, password: string): Promise<string> {
  const sodium = await getSodium();
  const privateKeysJson = JSON.stringify({
    encryption: sodium.to_base64(keys.encryption, sodium.base64_variants[B64_VARIANT]),
    signing: sodium.to_base64(keys.signing, sodium.base64_variants[B64_VARIANT]),
    signedPreKey: sodium.to_base64(keys.signedPreKey, sodium.base64_variants[B64_VARIANT]),
    masterSeed: keys.masterSeed ? sodium.to_base64(keys.masterSeed, sodium.base64_variants[B64_VARIANT]) : undefined,
  });

  const salt = sodium.randombytes_buf(32);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

  const appSecret = import.meta.env.VITE_APP_SECRET;
  if (!appSecret) {
    throw new Error("VITE_APP_SECRET is required for key encryption.");
  }
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

export type RetrieveKeysResult =
  | { success: true; keys: RetrievedKeys }
  | { success: false; reason: 'incorrect_password' | 'legacy_bundle' | 'keys_not_found' | 'decryption_failed' | 'app_secret_missing' };

export async function retrievePrivateKeys(encryptedDataStr: string, password: string): Promise<RetrieveKeysResult> {
  try {
    if (!encryptedDataStr) {
      return { success: false, reason: 'keys_not_found' };
    }

    const sodium = await getSodium();
    const encryptedData = sodium.from_base64(encryptedDataStr, sodium.base64_variants[B64_VARIANT]);

    const salt = encryptedData.slice(0, 32);
    const nonce = encryptedData.slice(32, 32 + sodium.crypto_secretbox_NONCEBYTES);
    const encryptedJson = encryptedData.slice(32 + sodium.crypto_secretbox_NONCEBYTES);

    const appSecret = import.meta.env.VITE_APP_SECRET;
    if (!appSecret) {
      console.error("VITE_APP_SECRET is required for key decryption but is missing.");
      return { success: false, reason: 'app_secret_missing' };
    }
    const combinedPass = `${appSecret}-${password}`;
    const keyInput = new Uint8Array(salt.length + sodium.from_string(combinedPass).length);
    keyInput.set(salt);
    keyInput.set(sodium.from_string(combinedPass), salt.length);
    const key = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, keyInput);

    const decryptedJson = sodium.crypto_secretbox_open_easy(encryptedJson, nonce, key);
    if (!decryptedJson) {
      return { success: false, reason: 'incorrect_password' };
    }
    const keys = JSON.parse(sodium.to_string(decryptedJson));
    
    if (!keys.signedPreKey) {
      // Legacy key bundle found without signedPreKey
      return { success: false, reason: 'legacy_bundle' };
    }

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

export async function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  
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
