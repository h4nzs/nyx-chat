import { getSodium } from '@lib/sodiumInitializer';
import { api } from '@lib/api';
import { retrievePrivateKey, decryptSessionKeyForUser } from '@utils/keyManagement';
import { useModalStore } from '@store/modal';
import {
  addSessionKey,
  getSessionKey as getKeyFromDb,
  getLatestSessionKey,
} from '@lib/keychainDb';
import { emitSessionKeyFulfillment, emitSessionKeyRequest } from '@lib/socket';

// --- User Private Key Cache (in-memory for one session) ---
let userPublicKey: Uint8Array | null = null;
let userPrivateKey: Uint8Array | null = null;

// --- Ratchet Tracker (in-memory for one session) ---
// This ensures we only ratchet once per conversation per app session.
const ratchetedConversations = new Set<string>();

export function clearKeyCache(): void {
  userPublicKey = null;
  userPrivateKey = null;
  ratchetedConversations.clear();
  // clearKeychainDb(); // Clear the IndexedDB keychain on logout - REMOVED
}

// --- Password & Private Key Management ---
async function getPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    useModalStore.getState().showPasswordPrompt(
      (password) => {
        if (password) {
          resolve(password);
        } else {
          reject(new Error("Password not provided."));
        }
      }
    );
  });
}

export async function getMyKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  if (userPrivateKey && userPublicKey) {
    return { publicKey: userPublicKey, privateKey: userPrivateKey };
  }

  const password = await getPassword();
  const encryptedKey = localStorage.getItem('encryptedPrivateKey');
  const publicKeyB64 = localStorage.getItem('publicKey');

  if (!encryptedKey || !publicKeyB64) {
    throw new Error("Encryption keys not found in storage.");
  }

  const privateKey = await retrievePrivateKey(encryptedKey, password);
  if (!privateKey) {
    throw new Error("Incorrect password. Failed to decrypt private key.");
  }

  const sodium = await getSodium();
  const publicKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);

  userPrivateKey = privateKey;
  userPublicKey = publicKey;
  
  return { publicKey, privateKey };
}

// --- Session Ratcheting and Key Retrieval ---

/**
 * Ensures a session is established and up-to-date for a conversation.
 * If it's a new app session for this convo, it ratchets a new key.
 */
export async function ensureAndRatchetSession(conversationId: string): Promise<void> {
  if (ratchetedConversations.has(conversationId)) {
    return; // Already ratcheted in this app session
  }

  try {
    console.log(`Ratcheting session for conversation ${conversationId}...`);
    const { sessionId, encryptedKey } = await api<{ sessionId: string; encryptedKey: string }>(
      `/api/session-keys/${conversationId}/ratchet`,
      { method: 'POST' }
    );

    if (!sessionId || !encryptedKey) {
      throw new Error('Invalid response from ratchet endpoint.');
    }

    const { publicKey, privateKey } = await getMyKeyPair();
    const sodium = await getSodium();
    const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey, sodium);

    await addSessionKey(conversationId, sessionId, newSessionKey);
    ratchetedConversations.add(conversationId);
    console.log(`Successfully ratcheted and stored new session key ${sessionId} for ${conversationId}`);
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
  if (!text) {
    throw new Error('Cannot encrypt empty text.');
  }

  const latestKey = await getLatestSessionKey(conversationId);
  if (!latestKey) {
    // This should ideally not happen if ensureAndRatchetSession is called first.
    throw new Error('No session key available for encryption. Please re-open the conversation.');
  }

  const { sessionId, key } = latestKey;
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(text, nonce, key);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  const ciphertext = sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  return { ciphertext, sessionId };
}

export async function decryptMessage(
  cipher: string,
  conversationId: string,
  sessionId: string | null | undefined
): Promise<string> {
  if (!cipher || typeof cipher !== 'string' || cipher.trim() === '') {
    return '';
  }
  
  if (!sessionId) {
    return '[Message from an old session, cannot be decrypted]';
  }

  const sodium = await getSodium();
  const key = await getKeyFromDb(conversationId, sessionId);

  if (!key) {
    // Key not found. This happens when receiving messages from a session started while offline.
    // We will request the key from another online user in the conversation.
    console.warn(`Key for session ${sessionId} not found locally. Emitting request...`);
    emitSessionKeyRequest(conversationId, sessionId);
    
    // Return a temporary message. The UI will need to re-render when the key arrives.
    return '[Requesting key to decrypt...]';
  }

  try {
    const combined = sodium.from_base64(cipher, sodium.base64_variants.ORIGINAL);
    if (combined.length <= sodium.crypto_secretbox_NONCEBYTES) {
      return '[Invalid Encrypted Data]';
    }

    const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

    const decrypted = sodium.to_string(sodium.crypto_secretbox_open_easy(encrypted, nonce, key));
    return decrypted;
  } catch (error) {
    console.error(`Decryption failed for convo ${conversationId}, session ${sessionId}:`, error);
    return '[Failed to decrypt message]';
  }
}

// --- Key Recovery (Fulfiller Side) ---

interface FulfillRequestPayload {
  conversationId: string;
  sessionId: string;
  requesterId: string;
  requesterPublicKey: string;
}

/**
 * Handles a request from another user to re-encrypt a session key.
 * This is triggered by a socket event.
 */
export async function fulfillKeyRequest(payload: FulfillRequestPayload): Promise<void> {
  const { conversationId, sessionId, requesterId, requesterPublicKey: requesterPublicKeyB64 } = payload;

  console.log(`Fulfilling key request for session ${sessionId} from user ${requesterId}`);

  // 1. Get the session key from our local DB
  const key = await getKeyFromDb(conversationId, sessionId);
  if (!key) {
    console.error(`Cannot fulfill request: Key for session ${sessionId} not found in our keychain.`);
    return;
  }

  // 2. Re-encrypt it for the requester
  const sodium = await getSodium();
  const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants.ORIGINAL);
  
  // crypto_box_seal_open requires our full keypair, but we are SEALING for them.
  // We just need their public key.
  const encryptedKeyForRequester = sodium.crypto_box_seal(key, requesterPublicKey);
  const encryptedKeyB64 = sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants.ORIGINAL);

  // 3. Emit the fulfillment event back
  emitSessionKeyFulfillment({
    requesterId,
    conversationId,
    sessionId,
    encryptedKey: encryptedKeyB64,
  });

  console.log(`Successfully fulfilled and sent re-encrypted key for session ${sessionId} to ${requesterId}`);
}

// --- Key Recovery (Receiver Side) ---

interface ReceiveKeyPayload {
  conversationId: string;
  sessionId: string;
  encryptedKey: string; // base64
}

/**
 * Handles receiving a new session key from a peer, decrypts it with our
 * private key, and stores it.
 */
export async function storeReceivedSessionKey(payload: ReceiveKeyPayload): Promise<void> {
  const { conversationId, sessionId, encryptedKey } = payload;
  console.log(`Received a new key for session ${sessionId}. Storing...`);

  const { publicKey, privateKey } = await getMyKeyPair();
  const sodium = await getSodium();

  const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey, sodium);

  await addSessionKey(conversationId, sessionId, newSessionKey);
  console.log(`Successfully stored new key for session ${sessionId}`);
}

// --- File Encryption/Decryption ---

const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits, optimal for AES-GCM

/**
 * Encrypts a file blob using a newly generated symmetric key.
 * @param blob The file blob to encrypt.
 * @returns A promise that resolves to an object containing the encrypted blob and the encryption key (as base64).
 */
export async function encryptFile(blob: Blob): Promise<{ encryptedBlob: Blob; key: string }> {
  const key = await crypto.subtle.generateKey(
    { name: ALGO, length: KEY_LENGTH },
    true, // exportable
    ['encrypt', 'decrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const fileData = await blob.arrayBuffer();
  const encryptedData = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    fileData
  );

  // Prepend IV to the encrypted data
  const combined = new Uint8Array(iv.length + encryptedData.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);

  const encryptedBlob = new Blob([combined], { type: 'application/octet-stream' });
  
  // Export the key to be sent to the recipient
  const exportedKey = await crypto.subtle.exportKey('raw', key);
  const sodium = await getSodium();
  const keyB64 = sodium.to_base64(new Uint8Array(exportedKey), sodium.base64_variants.ORIGINAL);

  return { encryptedBlob, key: keyB64 };
}

/**
 * Decrypts a file blob using a symmetric key.
 * @param encryptedBlob The blob containing the IV and encrypted data.
 * @param keyB64 The base64 encoded symmetric key.
 * @param originalType The original MIME type of the file.
 * @returns A promise that resolves to the decrypted file blob.
 */
export async function decryptFile(encryptedBlob: Blob, keyB64: string, originalType: string): Promise<Blob> {
  const sodium = await getSodium();
  const keyBytes = sodium.from_base64(keyB64, sodium.base64_variants.ORIGINAL);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: ALGO },
    false,
    ['decrypt']
  );

  const combinedData = await encryptedBlob.arrayBuffer();
  if (combinedData.byteLength < IV_LENGTH) {
    throw new Error("Encrypted file is too short to contain an IV.");
  }

  const iv = combinedData.slice(0, IV_LENGTH);
  const encryptedData = combinedData.slice(IV_LENGTH);

  const decryptedData = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    encryptedData
  );

  return new Blob([decryptedData], { type: originalType });
}