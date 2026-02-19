import sodium from 'libsodium-wrappers'
import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const SALT_LENGTH = 64
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 310000

/**
 * Decrypts the master private key using the user's password.
 * This is used on the server during the WebAuthn authentication flow.
 */
export async function decryptMasterPrivateKey (encryptedKeyB64: string, password: string): Promise<Uint8Array> {
  await sodium.ready
  const combined = Buffer.from(encryptedKeyB64, 'base64')

  const salt = combined.slice(0, SALT_LENGTH)
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = combined.slice(combined.length - TAG_LENGTH)
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH, combined.length - TAG_LENGTH)

  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512')

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return new Uint8Array(decrypted)
}

/**
 * Re-encrypts the master private key using a temporary key derived from the WebAuthn challenge.
 * This allows securely passing the key to the client for one session.
 */
export async function reEncryptMasterKeyForClient (privateKey: Uint8Array, challenge: string): Promise<string> {
  await sodium.ready

  // Derive a temporary, single-use key from the challenge
  const tempKey = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, challenge)
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)

  const ciphertext = sodium.crypto_secretbox_easy(privateKey, nonce, tempKey)

  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce)
  combined.set(ciphertext, nonce.length)

  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL)
}
