import { getSodium } from '@lib/sodiumInitializer';
import { api, authFetch } from '@lib/api';
import { useAuthStore } from '@store/auth';
import {
  addSessionKey,
  getSessionKey as getKeyFromDb,
  getLatestSessionKey,
} from '@lib/keychainDb';
import { emitSessionKeyFulfillment, emitSessionKeyRequest } from '@lib/socket';

const B64_VARIANT = 'URLSAFE_NO_PADDING';

// --- Types ---
export type DecryptResult =
  | { status: 'success'; value: string }
  | { status: 'pending'; reason: string }
  | { status: 'error'; error: Error };

// --- User Key Management ---

export function clearKeyCache(): void {
  // The primary key cache (privateKeysCache) is managed inside auth.ts
}

export async function getMyEncryptionKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  return useAuthStore.getState().getEncryptionKeyPair();
}

export async function decryptSessionKeyForUser(
  encryptedSessionKeyStr: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (!privateKey || privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) {
    throw new TypeError("Invalid privateKey length for session key decryption.");
  }
  if (!publicKey || publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new TypeError("Invalid publicKey length for session key decryption.");
  }

  const encryptedSessionKey = sodium.from_base64(encryptedSessionKeyStr, sodium.base64_variants[B64_VARIANT]);
  const sessionKey = sodium.crypto_box_seal_open(encryptedSessionKey, publicKey, privateKey);

  if (!sessionKey) {
    throw new Error("Failed to decrypt session key, likely due to incorrect key pair or corrupted data.");
  }

  return sessionKey;
}

// --- Session Ratcheting and Key Retrieval ---

export async function ensureAndRatchetSession(conversationId: string): Promise<void> {
  try {
    const { sessionId, encryptedKey } = await authFetch<{ sessionId: string; encryptedKey: string }>(
      `/api/session-keys/${conversationId}/ratchet`, { method: 'POST' }
    );
    const { publicKey, privateKey } = await getMyEncryptionKeyPair();
    const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);

    await addSessionKey(conversationId, sessionId, newSessionKey);
  } catch (error) {
    console.error(`Failed to ratchet session for ${conversationId}:`, error);
    throw new Error('Could not establish a secure session.');
  }
}

// --- Message Encryption/Decryption ---

export async function encryptMessage(
  text: string,
  conversationId: string
): Promise<{ ciphertext: string; sessionId: string }> {
  const latestKey = await getLatestSessionKey(conversationId);
  if (!latestKey) throw new Error('No session key available for encryption.');

  const { sessionId, key } = latestKey;
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(text, nonce, key);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  return { ciphertext: sodium.to_base64(combined, sodium.base64_variants[B64_VARIANT]), sessionId };
}

/**
 * The core decryption function. It tries to find a key locally. If not found,
 * it attempts to derive it from a stored initial session, and if that fails,
 * it falls back to requesting the key from online peers.
 */
export async function decryptMessage(
  cipher: string,
  conversationId: string,
  sessionId: string | null | undefined
): Promise<DecryptResult> {
  if (!cipher) return { status: 'success', value: '' };
  if (!sessionId) return { status: 'error', error: new Error('Cannot decrypt message: Missing session ID.') };

  // 1. Try to get the key from our local keychain DB
  let sessionKey = await getKeyFromDb(conversationId, sessionId);

  // 2. If the key is not found, try to derive it from an initial session OR decrypt a ratchet key
  if (!sessionKey) {
    try {
      console.log(`Key for session ${sessionId} not found locally. Attempting to fetch initial/ratchet session...`);
      const sessionData = await authFetch<any>(`/api/keys/initial-session/${conversationId}/${sessionId}`);
      const { getSignedPreKeyPair, getEncryptionKeyPair } = useAuthStore.getState();
      const myIdentityKeyPair = await getEncryptionKeyPair();

      // Check if this is a client-initiated session (X3DH) or a server-ratcheted session
      if (sessionData.initiatorEphemeralKey === "server-ratchet") {
        // This is a server-ratcheted key, we just need to decrypt it.
        console.log("Detected server-ratchet session. Decrypting key...");
        sessionKey = await decryptSessionKeyForUser(
          sessionData.encryptedKey,
          myIdentityKeyPair.publicKey,
          myIdentityKeyPair.privateKey
        );
      } else {
        // This is a client-initiated session, we need to derive the key.
        console.log("Detected client-initiated session. Deriving key...");
        const mySignedPreKeyPair = await getSignedPreKeyPair();
        sessionKey = await deriveSessionKeyAsRecipient(
          myIdentityKeyPair,
          mySignedPreKeyPair,
          sessionData.initiatorIdentityKey,
          sessionData.initiatorEphemeralKey
        );
      }

      await addSessionKey(conversationId, sessionId, sessionKey);
      console.log(`Successfully processed and stored key for session ${sessionId}.`);

    } catch (e) {
      // This will fail if the API call fails or if derivation/decryption fails.
      // In that case, we fall back to the original peer request method.
      console.warn("Failed to process session from server, falling back to peer request.", e);
      emitSessionKeyRequest(conversationId, sessionId);
      return { status: 'pending', reason: '[Requesting key to decrypt...]' };
    }
  }
  
  // 3. If we have the key (either from DB or after processing), decrypt the message
  try {
    const sodium = await getSodium();
    const combined = sodium.from_base64(cipher, sodium.base64_variants[B64_VARIANT]);
    const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
    const decrypted = sodium.to_string(sodium.crypto_secretbox_open_easy(encrypted, nonce, sessionKey));
    return { status: 'success', value: decrypted };
  } catch (e: any) {
    console.error(`Decryption failed for convo ${conversationId}, session ${sessionId}:`, e);
    return { status: 'error', error: new Error('Failed to decrypt message') };
  }
}

// --- Pre-Key Handshake (Simplified X3DH) ---

export type PreKeyBundle = {
  identityKey: string;
  signingKey: string;
  signedPreKey: {
    key: string;
    signature: string;
  };
};

/**
 * INITIATOR (Alice) side of the handshake.
 */
export async function establishSessionFromPreKeyBundle(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  preKeyBundle: PreKeyBundle
): Promise<{ sessionKey: Uint8Array, ephemeralPublicKey: string }> {
  const sodium = await getSodium();
  const ephemeralKeyPair = sodium.crypto_box_keypair();

  const theirIdentityKey = sodium.from_base64(preKeyBundle.identityKey, sodium.base64_variants[B64_VARIANT]);
  const theirSignedPreKey = sodium.from_base64(preKeyBundle.signedPreKey.key, sodium.base64_variants[B64_VARIANT]);
  const theirSigningKey = sodium.from_base64(preKeyBundle.signingKey, sodium.base64_variants[B64_VARIANT]);

  const signature = sodium.from_base64(preKeyBundle.signedPreKey.signature, sodium.base64_variants[B64_VARIANT]);
  if (!sodium.crypto_sign_verify_detached(signature, theirSignedPreKey, theirSigningKey)) {
    throw new Error("Invalid signature on signed pre-key.");
  }

  const dh1 = sodium.crypto_scalarmult(myIdentityKeyPair.privateKey, theirSignedPreKey);
  const dh2 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirIdentityKey);
  const dh3 = sodium.crypto_scalarmult(ephemeralKeyPair.privateKey, theirSignedPreKey);

  const sharedSecret = new Uint8Array([...dh1, ...dh2, ...dh3]);
  const sessionKey = sodium.crypto_generichash(32, sharedSecret);

  return {
    sessionKey,
    ephemeralPublicKey: sodium.to_base64(ephemeralKeyPair.publicKey, sodium.base64_variants[B64_VARIANT]),
  };
}

/**
 * RECIPIENT (Bob) side of the handshake.
 */
export async function deriveSessionKeyAsRecipient(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  mySignedPreKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  initiatorIdentityKeyStr: string,
  initiatorEphemeralKeyStr: string
): Promise<Uint8Array> {
  const sodium = await getSodium();

  const theirIdentityKey = sodium.from_base64(initiatorIdentityKeyStr, sodium.base64_variants[B64_VARIANT]);
  const theirEphemeralKey = sodium.from_base64(initiatorEphemeralKeyStr, sodium.base64_variants[B64_VARIANT]);
  
  const dh1 = sodium.crypto_scalarmult(mySignedPreKeyPair.privateKey, theirIdentityKey);
  const dh2 = sodium.crypto_scalarmult(myIdentityKeyPair.privateKey, theirEphemeralKey);
  const dh3 = sodium.crypto_scalarmult(mySignedPreKeyPair.privateKey, theirEphemeralKey);

  const sharedSecret = new Uint8Array([...dh1, ...dh2, ...dh3]);
  const sessionKey = sodium.crypto_generichash(32, sharedSecret);
  
  return sessionKey;
}


// --- Key Recovery ---

interface FulfillRequestPayload {
  conversationId: string;
  sessionId: string;
  requesterId: string;
  requesterPublicKey: string;
}

export async function fulfillKeyRequest(payload: FulfillRequestPayload): Promise<void> {
  const { conversationId, sessionId, requesterId, requesterPublicKey: requesterPublicKeyB64 } = payload;
  const key = await getKeyFromDb(conversationId, sessionId);
  if (!key) return;

  const sodium = await getSodium();
  const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants[B64_VARIANT]);
  const encryptedKeyForRequester = sodium.crypto_box_seal(key, requesterPublicKey);

  emitSessionKeyFulfillment({
    requesterId,
    conversationId,
    sessionId,
    encryptedKey: sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants[B64_VARIANT]),
  });
}

interface ReceiveKeyPayload {
  conversationId: string;
  sessionId: string;
  encryptedKey: string;
}

export async function storeReceivedSessionKey(payload: ReceiveKeyPayload): Promise<void> {
  const { conversationId, sessionId, encryptedKey } = payload;
  const { publicKey, privateKey } = await getMyEncryptionKeyPair();
  const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);

  await addSessionKey(conversationId, sessionId, newSessionKey);
}

// --- File Encryption/Decryption ---

const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

export async function encryptFile(blob: Blob): Promise<{ encryptedBlob: Blob; key: string }> {
  const key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LENGTH }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const fileData = await blob.arrayBuffer();
  const encryptedData = await crypto.subtle.encrypt({ name: ALGO, iv }, key, fileData);

  const combined = new Uint8Array(iv.length + encryptedData.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);
  const encryptedBlob = new Blob([combined], { type: 'application/octet-stream' });

  const exportedKey = await crypto.subtle.exportKey('raw', key);
  const sodium = await getSodium();
  const keyB64 = sodium.to_base64(new Uint8Array(exportedKey), sodium.base64_variants[B64_VARIANT]);

  return { encryptedBlob, key: keyB64 };
}

export async function decryptFile(encryptedBlob: Blob, keyB64: string, originalType: string): Promise<Blob> {
  const sodium = await getSodium();
  const keyBytes = sodium.from_base64(keyB64, sodium.base64_variants[B64_VARIANT]);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: ALGO }, false, ['decrypt']);

  const combinedData = await encryptedBlob.arrayBuffer();
  if (combinedData.byteLength < IV_LENGTH) throw new Error("Encrypted file is too short.");

  const iv = combinedData.slice(0, IV_LENGTH);
  const encryptedData = combinedData.slice(IV_LENGTH);
  const decryptedData = await crypto.subtle.decrypt({ name: ALGO, iv }, key, encryptedData);

  return new Blob([decryptedData], { type: originalType });
}