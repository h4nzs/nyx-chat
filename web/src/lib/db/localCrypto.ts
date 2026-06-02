import { argon2id } from 'hash-wasm';
import { getSodium } from '../sodiumInitializer';

/**
 * Derives a 32-byte Local Storage Key (LSK) from a password and salt.
 * This key is used for AEAD encryption of local database fields.
 */
export async function deriveLSK(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const hashHex = await argon2id({
    password,
    salt,
    iterations: 2,
    memorySize: 19456,
    parallelism: 1,
    hashLength: 32,
    outputType: 'binary'
  }) as unknown as Uint8Array;
  
  return hashHex;
}

/**
 * Returns a deterministic salt for LSK derivation based on the user's ID.
 * This ensures the LSK is unique per user but stable for the same user.
 */
export async function getLocalSalt(userId: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  // We use a fixed prefix + userId to derive a 16-byte salt
  const input = new TextEncoder().encode(`NYX_LOCAL_SALT_${userId}`);
  return sodium.crypto_generichash(16, input);
}
