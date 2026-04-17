// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { getSodiumLib } from '@utils/crypto';
import { worker_generate_random_key } from './crypto-worker-proxy';

/**
 * Generate a new random symmetric key for a Story (using libsodium)
 * Output: Base64 URL Safe string
 */
export async function generateStoryKey(): Promise<string> {
  const sodium = await getSodiumLib();
  // Generate 32 bytes key for XChaCha20-Poly1305
  const keyBytes = await worker_generate_random_key();
  return sodium.to_base64(keyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Encrypt a Story payload using the provided key (XChaCha20-Poly1305)
 * Output: Base64 URL Safe string (nonce + ciphertext)
 */
export async function encryptStoryPayload(payload: unknown, base64Key: string): Promise<string> {
  const sodium = await getSodiumLib();
  const keyBytes = sodium.from_base64(base64Key, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    encodedPayload,
    null,
    null,
    nonce,
    keyBytes
  );
  
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  
  return sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Decrypt a Story payload using the provided key (XChaCha20-Poly1305)
 * Output: Parsed JSON Object
 */
export async function decryptStoryPayload(encryptedDataB64: string, base64Key: string): Promise<unknown> {
  const sodium = await getSodiumLib();
  const keyBytes = sodium.from_base64(base64Key, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  const combined = sodium.from_base64(encryptedDataB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  
  if (combined.length < nonceBytes) {
      throw new Error("Story payload is too short to contain a valid nonce.");
  }
  
  const nonce = combined.slice(0, nonceBytes);
  const ciphertext = combined.slice(nonceBytes);
  
  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    keyBytes
  );
  
  const decoded = new TextDecoder().decode(decrypted);
  return JSON.parse(decoded);
}