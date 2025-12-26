import { getSodium } from '@lib/sodiumInitializer';
import { authFetch } from '@lib/api';
import { useAuthStore } from '@store/auth';
import {
  addSessionKey,
  getSessionKey as getKeyFromDb,
  getLatestSessionKey,
  storeGroupKey,
  getGroupKey,
  receiveGroupKey,
} from '@lib/keychainDb';
import { emitSessionKeyFulfillment, emitSessionKeyRequest, emitGroupKeyDistribution } from '@lib/socket';
import { 
  worker_crypto_secretbox_easy, 
  worker_crypto_secretbox_open_easy, 
  worker_crypto_box_seal_open, 
  worker_x3dh_initiator, 
  worker_x3dh_recipient, 
  worker_crypto_box_seal, 
  worker_file_encrypt, 
  worker_file_decrypt,
  worker_generate_random_key
} from '@lib/crypto-worker-proxy';
import type { Participant } from '@store/conversation';

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

  const encryptedSessionKey = sodium.from_base64(encryptedSessionKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  const sessionKey = await worker_crypto_box_seal_open(encryptedSessionKey, publicKey, privateKey);

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

// --- Group Key Distribution ---

export async function ensureGroupSession(conversationId: string, participants: Participant[]): Promise<any[] | null> {
    console.log(`[crypto] ensureGroupSession called for ${conversationId}`);
    const existingKey = await getGroupKey(conversationId);
    if (existingKey) {
      console.log(`[crypto] Existing group key found for ${conversationId}. No action needed.`);
      return null; // Key already exists, no need to distribute
    }
    
    console.log(`[crypto] No existing key. Generating a new group key for ${conversationId}.`);
    const sodium = await getSodium();
    const groupKey = await worker_generate_random_key();
    console.log(`[crypto] New group key generated: ${sodium.to_hex(groupKey)}`);

    await storeGroupKey(conversationId, groupKey);
    console.log(`[crypto] New group key stored for ${conversationId}.`);
  
    const myId = useAuthStore.getState().user?.id;
    const otherParticipants = participants.filter(p => p.id !== myId);
  
    const distributionKeys = await Promise.all(
      otherParticipants.map(async (p) => {
        if (!p.publicKey) {
          console.warn(`Participant ${p.username} has no public key. Cannot send group key.`);
          return null;
        }
        const theirPublicKey = sodium.from_base64(p.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        const encryptedKey = await worker_crypto_box_seal(groupKey, theirPublicKey);
        return {
          userId: p.id,
          key: sodium.to_base64(encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING),
          type: 'GROUP_KEY'
        };
      })
    );
  
    return distributionKeys.filter(Boolean);
}

export async function handleGroupKeyDistribution(conversationId: string, encryptedKey: string): Promise<void> {
    console.log(`[crypto] handleGroupKeyDistribution called for ${conversationId}`);
    const { publicKey, privateKey } = await getMyEncryptionKeyPair();
    const groupKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
    await receiveGroupKey(conversationId, groupKey);
    console.log(`[crypto] Received and stored a new group key for ${conversationId}`);
}

// --- Message Encryption/Decryption ---

export async function encryptMessage(
  text: string,
  conversationId: string,
  isGroup: boolean = false,
): Promise<{ ciphertext: string; sessionId?: string }> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  let key: Uint8Array;
  let sessionId: string | undefined;

  if (isGroup) {
    console.log(`[crypto] Encrypting for GROUP ${conversationId}`);
    const groupKey = await getGroupKey(conversationId);
    if (!groupKey) {
      console.error(`[crypto] FATAL: No group key found during encryption for ${conversationId}.`);
      throw new Error(`No group key available for conversation ${conversationId}.`);
    }
    console.log(`[crypto] Found group key for encryption: ${sodium.to_hex(groupKey)}`);
    key = groupKey;
    sessionId = undefined; // No session ID for group messages
  } else {
    // This is the 1-on-1 chat logic path.
    // DIAGNOSTIC PATCH: Check if a group key exists anyway.
    const potentialGroupKey = await getGroupKey(conversationId);
    if (potentialGroupKey) {
      console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      console.error(`[crypto] CONTRADICTION: encryptMessage called with isGroup=false, but a group key exists for this conversation (${conversationId}).`);
      console.error("[crypto] Forcing use of group key to prevent crash.");
      console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      key = potentialGroupKey;
      sessionId = undefined;
    } else {
      const latestKey = await getLatestSessionKey(conversationId);
      if (!latestKey) throw new Error('No session key available for encryption.');
      key = latestKey.key;
      sessionId = latestKey.sessionId;
    }
  }
  
  const messageBytes = sodium.from_string(text);
  const encrypted = await worker_crypto_secretbox_easy(messageBytes, nonce, key);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  return { ciphertext: sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING), sessionId };
}

/**
 * The core decryption function. It tries to find a key locally. If not found,
 * it attempts to derive it from a stored initial session, and if that fails,
 * it falls back to requesting the key from online peers.
 */
export async function decryptMessage(
  cipher: string,
  conversationId: string,
  isGroup: boolean,
  sessionId: string | null | undefined,
): Promise<DecryptResult> {
    if (!cipher) return { status: 'success', value: '' };
  
    let key: Uint8Array | null = null;
    const sodium = await getSodium();
  
    if (isGroup) {
      console.log(`[crypto] Decrypting for GROUP ${conversationId}`);
      key = await getGroupKey(conversationId);
      if (!key) {
        console.warn(`[crypto] No group key found for decryption in ${conversationId}. Requesting...`);
        // TODO: In a real scenario, we might want to request the group key
        // from another member or the server. For now, we show a pending state.
        return { status: 'pending', reason: '[Requesting group key...]' };
      }
      console.log(`[crypto] Found group key for decryption: ${sodium.to_hex(key)}`);
    } else {
      if (!sessionId) return { status: 'error', error: new Error('Cannot decrypt message: Missing session ID.') };
      key = await getKeyFromDb(conversationId, sessionId);
  
      if (!key) {
        try {
          console.log(`Key for session ${sessionId} not found locally. Attempting to fetch initial/ratchet session...`);
          const sessionData = await authFetch<any>(`/api/keys/initial-session/${conversationId}/${sessionId}`);
          const { getSignedPreKeyPair, getEncryptionKeyPair } = useAuthStore.getState();
          const myIdentityKeyPair = await getEncryptionKeyPair();
  
          if (sessionData.initiatorEphemeralKey === "server-ratchet") {
            console.log("Detected server-ratchet session. Decrypting key...");
            key = await decryptSessionKeyForUser(sessionData.encryptedKey, myIdentityKeyPair.publicKey, myIdentityKeyPair.privateKey);
          } else {
            console.log("Detected client-initiated session. Deriving key...");
            const mySignedPreKeyPair = await getSignedPreKeyPair();
            key = await deriveSessionKeyAsRecipient(myIdentityKeyPair, mySignedPreKeyPair, sessionData.initiatorIdentityKey, sessionData.initiatorEphemeralKey);
          }
  
          await addSessionKey(conversationId, sessionId, key);
          console.log(`Successfully processed and stored key for session ${sessionId}.`);
  
        } catch (e) {
          console.warn("Failed to process session from server, falling back to peer request.", e);
          emitSessionKeyRequest(conversationId, sessionId);
          return { status: 'pending', reason: '[Requesting key to decrypt...]' };
        }
      }
    }
    
    try {
      const combined = sodium.from_base64(cipher, sodium.base64_variants.URLSAFE_NO_PADDING);
      const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
      const encrypted = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
      
      const decrypted = await worker_crypto_secretbox_open_easy(encrypted, nonce, key);
      return { status: 'success', value: sodium.to_string(decrypted) };
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

  const theirIdentityKey = sodium.from_base64(preKeyBundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSignedPreKey = sodium.from_base64(preKeyBundle.signedPreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSigningKey = sodium.from_base64(preKeyBundle.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const signature = sodium.from_base64(preKeyBundle.signedPreKey.signature, sodium.base64_variants.URLSAFE_NO_PADDING);

  // Offload the entire handshake calculation to the worker
  return worker_x3dh_initiator({
    myIdentityKey: myIdentityKeyPair,
    theirIdentityKey,
    theirSignedPreKey,
    theirSigningKey,
    signature,
  });
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

  const theirIdentityKey = sodium.from_base64(initiatorIdentityKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirEphemeralKey = sodium.from_base64(initiatorEphemeralKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  // Offload the entire key derivation to the worker
  return worker_x3dh_recipient({
    myIdentityKey: myIdentityKeyPair,
    mySignedPreKey: mySignedPreKeyPair,
    theirIdentityKey,
    theirEphemeralKey,
  });
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
  const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  const encryptedKeyForRequester = await worker_crypto_box_seal(key, requesterPublicKey);

  emitSessionKeyFulfillment({
    requesterId,
    conversationId,
    sessionId,
    encryptedKey: sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants.URLSAFE_NO_PADDING),
  });
}

interface ReceiveKeyPayload {
  conversationId: string;
  sessionId?: string;
  encryptedKey: string;
  type?: 'GROUP_KEY' | 'SESSION_KEY';
}

export async function storeReceivedSessionKey(payload: ReceiveKeyPayload): Promise<void> {
    const { conversationId, sessionId, encryptedKey, type } = payload;
  
    if (type === 'GROUP_KEY') {
      await handleGroupKeyDistribution(conversationId, encryptedKey);
    } else if (sessionId) {
      const { publicKey, privateKey } = await getMyEncryptionKeyPair();
      const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
      await addSessionKey(conversationId, sessionId, newSessionKey);
    }
}

// --- File Encryption/Decryption ---

const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

export async function encryptFile(blob: Blob): Promise<{ encryptedBlob: Blob; key: string }> {
  const fileData = await blob.arrayBuffer();
  
  // Offload the entire file encryption process to the worker
  const { encryptedData, iv, key } = await worker_file_encrypt(fileData);

  const combined = new Uint8Array(iv.length + encryptedData.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);
  const encryptedBlob = new Blob([combined], { type: 'application/octet-stream' });

  const sodium = await getSodium();
  const keyB64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);

  return { encryptedBlob, key: keyB64 };
}

export async function decryptFile(encryptedBlob: Blob, keyB64: string, originalType: string): Promise<Blob> {
  const sodium = await getSodium();
  const keyBytes = sodium.from_base64(keyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  const combinedData = await encryptedBlob.arrayBuffer();
  if (combinedData.byteLength < IV_LENGTH) throw new Error("Encrypted file is too short.");

  // Offload the decryption to the worker
  const decryptedData = await worker_file_decrypt(combinedData, keyBytes);

  return new Blob([decryptedData], { type: originalType });
}