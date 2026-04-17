// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import sodium from 'libsodium-wrappers'

/**
 * Decrypts the master private key using the user's password.
 * This is used on the server during the WebAuthn authentication flow.
 */
export async function decryptMasterPrivateKey (encryptedKeyB64: string, password: string): Promise<Uint8Array> {
  await sodium.ready
  const combined = sodium.from_base64(encryptedKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING)

  const SALT_LENGTH = sodium.crypto_pwhash_SALTBYTES
  const NONCE_LENGTH = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES

  if (combined.length < SALT_LENGTH + NONCE_LENGTH) {
    throw new Error('Invalid encrypted key payload.')
  }

  const salt = combined.slice(0, SALT_LENGTH)
  const nonce = combined.slice(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH)
  const ciphertext = combined.slice(SALT_LENGTH + NONCE_LENGTH)

  // Derive key using Argon2id (ALG_ARGON2ID13) with SENSITIVE limits
  const key = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_SENSITIVE,
    sodium.crypto_pwhash_MEMLIMIT_SENSITIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )

  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    key
  )

  return decrypted
}

/**
 * Re-encrypts the master private key using a temporary key derived from the WebAuthn challenge.
 * This allows securely passing the key to the client for one session.
 */
export async function reEncryptMasterKeyForClient (privateKey: Uint8Array, challenge: string): Promise<string> {
  await sodium.ready

  // Derive a temporary, single-use key from the challenge
  const tempKey = sodium.crypto_generichash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 
    challenge, 
    null
  )
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    privateKey,
    null,
    null,
    nonce,
    tempKey
  )

  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce)
  combined.set(ciphertext, nonce.length)

  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL)
}
