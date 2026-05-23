import { getSodium } from './sodium.js';
import { argon2id } from 'hash-wasm';

const B64_VARIANT = 'URLSAFE_NO_PADDING';

// Konfigurasi Argon2
const ARGON_VAULT_CONFIG = {
  parallelism: 1,
  iterations: 4,
  memorySize: 131072, // 128 MB
  hashLength: 32,
  outputType: 'binary' as const,
};

/**
 * Perform HKDF-like key derivation using BLAKE2b (libsodium generichash)
 * Splits a chainKey into a new chainKey and a messageKey.
 */
export async function kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const sodium = await getSodium();
  const messageKeyInput = new Uint8Array([0x01]);
  const newChainKeyInput = new Uint8Array([0x02]);

  const messageKey = sodium.crypto_generichash(32, messageKeyInput, chainKey);
  const newChainKey = sodium.crypto_generichash(32, newChainKeyInput, chainKey);

  return [newChainKey, messageKey];
}

/**
 * Derive a key from a password and salt using Argon2id
 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({
    ...ARGON_VAULT_CONFIG,
    password,
    salt,
  });
}

/**
 * Stretches a high-entropy seed into a 32-byte key using Argon2id
 */
export async function stretchSeed(seed: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  const password = sodium.to_hex(seed);
  const salt = new TextEncoder().encode("NYX_STRETCH_V1");
  return argon2id({
    ...ARGON_VAULT_CONFIG,
    password,
    salt,
  });
}

/**
 * Symmetrically encrypt JSON-serializable data using XChaCha20-Poly1305
 */
export async function encryptData(keyBytes: Uint8Array, data: unknown): Promise<string> {
  const sodium = await getSodium();
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

/**
 * Symmetrically decrypt data using XChaCha20-Poly1305
 */
export async function decryptData(keyBytes: Uint8Array, encryptedString: string): Promise<unknown> {
  const sodium = await getSodium();
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

/**
 * Generate Safety Number (fingerprint) for device verification
 */
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

  const hash = sodium.crypto_generichash(64, combined, null);

  const fingerprint = sodium.to_hex(hash.slice(0, 30));
  const chunks = fingerprint.match(/.{1,10}/g) || [];
  const digitGroups = chunks.map((chunk: string) => parseInt(chunk, 16).toString().padStart(5, '0').slice(-5));
  
  return digitGroups.join(' ');
}

/**
 * Helper to export a public key to a URL-safe base64 string
 */
export async function exportPublicKey(publicKey: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Helper to generate random bytes
 */
export async function generateRandomBytes(length: number): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(length);
}

/**
 * Generate a classical X25519 keypair for encryption (Double Ratchet / X3DH)
 */
export async function generateX25519KeyPair() {
  const sodium = await getSodium();
  return sodium.crypto_box_keypair();
}

/**
 * Generate a classical Ed25519 keypair for signing
 */
export async function generateEd25519KeyPair() {
  const sodium = await getSodium();
  return sodium.crypto_sign_keypair();
}

/**
 * Generate a Post-Quantum Keypair (ML-KEM-768 or X-Wing)
 */
export async function generatePQKeyPair() {
  const sodium = await getSodium();
  return sodium.crypto_kem_xwing_keypair();
}
