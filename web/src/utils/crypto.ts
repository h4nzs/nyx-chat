import { authFetch } from '@lib/api';
import { useAuthStore } from '@store/auth';
import { useMessageStore } from '@store/message';
import { useConversationStore } from '@store/conversation';
import {
  addSessionKey,
  getSessionKey as getKeyFromDb,
  getLatestSessionKey,
  storeGroupKey,
  getGroupKey,
  deleteGroupKey,
  receiveGroupKey,
} from '@lib/keychainDb';
import { emitSessionKeyFulfillment, emitSessionKeyRequest, emitGroupKeyDistribution, emitGroupKeyRequest, emitGroupKeyFulfillment } from '@lib/socket';
import type { Participant } from '@store/conversation';

// --- Types ---
export type DecryptResult =
  | { status: 'success'; value: string }
  | { status: 'pending'; reason: string }
  | { status: 'error'; error: Error };

export type PreKeyBundle = {
  identityKey: string;
  signingKey: string;
  signedPreKey: {
    key: string;
    signature: string;
  };
};

// --- Module-level state for managing key requests ---
const pendingGroupKeyRequests = new Map<string, { timerId: number }>();
const MAX_KEY_REQUEST_RETRIES = 2; // Total 3 attempts
const KEY_REQUEST_TIMEOUT_MS = 15000; // 15 seconds

const pendingGroupSessionPromises = new Map<string, Promise<any[] | null>>();
const groupSessionLocks = new Set<string>();

// --- Dynamic Import Helpers ---
async function getWorkerProxy() {
  return import('@lib/crypto-worker-proxy');
}

async function getSodiumLib() {
  const { getSodium } = await import('@lib/sodiumInitializer');
  return getSodium();
}

// --- User Key Management ---

export async function getMyEncryptionKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  return useAuthStore.getState().getEncryptionKeyPair();
}

export async function decryptSessionKeyForUser(
  encryptedSessionKeyStr: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  const sodium = await getSodiumLib();
  const { worker_crypto_box_seal_open } = await getWorkerProxy();

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

// --- Group Key Management & Recovery ---

export async function ensureGroupSession(conversationId: string, participants: Participant[]): Promise<any[] | null> {
  const pending = pendingGroupSessionPromises.get(conversationId);
  if (pending) return pending;

  if (groupSessionLocks.has(conversationId)) {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!groupSessionLocks.has(conversationId)) {
          clearInterval(interval);
          ensureGroupSession(conversationId, participants).then(resolve);
        }
      }, 10);
    });
  }

  groupSessionLocks.add(conversationId);

  const promise = (async () => {
    try {
      const existingKey = await getGroupKey(conversationId);
      if (existingKey) return null;

      const sodium = await getSodiumLib();
      const { worker_generate_random_key, worker_crypto_box_seal } = await getWorkerProxy();

      const groupKey = await worker_generate_random_key();
      await storeGroupKey(conversationId, groupKey);

      const myId = useAuthStore.getState().user?.id;
      const otherParticipants = participants.filter(p => p.id !== myId);
      const missingKeys: string[] = [];

      const distributionKeys = await Promise.all(
        otherParticipants.map(async (p) => {
          if (!p.publicKey) {
            missingKeys.push(p.username);
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
    } finally {
      groupSessionLocks.delete(conversationId);
    }
  })();

  pendingGroupSessionPromises.set(conversationId, promise);
  try {
    return await promise;
  } finally {
    pendingGroupSessionPromises.delete(conversationId);
  }
}

export async function handleGroupKeyDistribution(conversationId: string, encryptedKey: string): Promise<void> {
  const { publicKey, privateKey } = await getMyEncryptionKeyPair();
  const groupKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
  await receiveGroupKey(conversationId, groupKey);
}

export async function rotateGroupKey(conversationId: string, reason: 'membership_change' | 'periodic_rotation' = 'membership_change'): Promise<void> {
  await deleteGroupKey(conversationId);
  try {
    await authFetch(`/api/conversations/${conversationId}/key-rotation`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
  } catch (error) {
    console.error(`[crypto] Failed to notify server about key rotation for ${conversationId}:`, error);
  }

  if (reason === 'membership_change') {
    const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
    if (conversation) {
      const distributionKeys = await ensureGroupSession(conversationId, conversation.participants);
      if (distributionKeys) {
        emitGroupKeyDistribution(conversationId, distributionKeys);
      }
    }
  }
}

export async function schedulePeriodicGroupKeyRotation(conversationId: string): Promise<void> {
  const rotationInterval = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    await rotateGroupKey(conversationId, 'periodic_rotation');
  }, rotationInterval);
}

async function requestGroupKeyWithTimeout(conversationId: string, attempt = 0) {
  if (pendingGroupKeyRequests.has(conversationId)) return;

  emitGroupKeyRequest(conversationId);

  const timerId = window.setTimeout(() => {
    pendingGroupKeyRequests.delete(conversationId);
    if (attempt < MAX_KEY_REQUEST_RETRIES) {
      requestGroupKeyWithTimeout(conversationId, attempt + 1);
    } else {
      useMessageStore.getState().failPendingMessages(conversationId, '[Key request timed out]');
    }
  }, KEY_REQUEST_TIMEOUT_MS);

  pendingGroupKeyRequests.set(conversationId, { timerId });
}

// --- Message Encryption/Decryption ---

export async function encryptMessage(
  text: string,
  conversationId: string,
  isGroup: boolean = false,
): Promise<{ ciphertext: string; sessionId?: string }> {
  const sodium = await getSodiumLib();
  const { worker_crypto_secretbox_xchacha20poly1305_easy } = await getWorkerProxy();

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  let key: Uint8Array;
  let sessionId: string | undefined;

  if (isGroup) {
    const groupKey = await getGroupKey(conversationId);
    if (!groupKey) throw new Error(`No group key available for conversation ${conversationId}.`);
    key = groupKey;
    sessionId = undefined;
  } else {
    const latestKey = await getLatestSessionKey(conversationId);
    if (!latestKey) throw new Error('No session key available for encryption.');
    key = latestKey.key;
    sessionId = latestKey.sessionId;
  }
  
  const messageBytes = sodium.from_string(text);
  const encrypted = await worker_crypto_secretbox_xchacha20poly1305_easy(messageBytes, nonce, key);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  return { ciphertext: sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING), sessionId };
}

export async function decryptMessage(
  cipher: string,
  conversationId: string,
  isGroup: boolean,
  sessionId: string | null | undefined,
): Promise<DecryptResult> {
  if (!cipher) return { status: 'success', value: '' };

  let key: Uint8Array | null = null;
  const sodium = await getSodiumLib();
  const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await getWorkerProxy();

  if (isGroup) {
    key = await getGroupKey(conversationId);
    if (!key) {
      requestGroupKeyWithTimeout(conversationId);
      return { status: 'pending', reason: 'waiting_for_key' };
    }
  } else {
    if (!sessionId) return { status: 'error', error: new Error('Cannot decrypt message: Missing session ID.') };
    key = await getKeyFromDb(conversationId, sessionId);

    if (!key) {
      emitSessionKeyRequest(conversationId, sessionId);
      return { status: 'pending', reason: '[Requesting key to decrypt...]' };
    }
  }
  
  try {
    const combined = sodium.from_base64(cipher, sodium.base64_variants.URLSAFE_NO_PADDING);
    const nonce = combined.slice(0, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const encrypted = combined.slice(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    
    const decrypted = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, key);
    return { status: 'success', value: sodium.to_string(decrypted) };
  } catch (e: any) {
    console.error(`Decryption failed for convo ${conversationId}, session ${sessionId}:`, e);
    return { status: 'error', error: new Error('Failed to decrypt message') };
  }
}

// --- Pre-Key Handshake (Simplified X3DH) ---

export async function establishSessionFromPreKeyBundle(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  preKeyBundle: PreKeyBundle
): Promise<{ sessionKey: Uint8Array, ephemeralPublicKey: string }> {
  const sodium = await getSodiumLib();
  const { worker_x3dh_initiator } = await getWorkerProxy();

  const theirIdentityKey = sodium.from_base64(preKeyBundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSignedPreKey = sodium.from_base64(preKeyBundle.signedPreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSigningKey = sodium.from_base64(preKeyBundle.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const signature = sodium.from_base64(preKeyBundle.signedPreKey.signature, sodium.base64_variants.URLSAFE_NO_PADDING);

  return worker_x3dh_initiator({
    myIdentityKey: myIdentityKeyPair,
    theirIdentityKey,
    theirSignedPreKey,
    theirSigningKey,
    signature,
  });
}

export async function deriveSessionKeyAsRecipient(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  mySignedPreKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  initiatorIdentityKeyStr: string,
  initiatorEphemeralKeyStr: string
): Promise<Uint8Array> {
  const sodium = await getSodiumLib();
  const { worker_x3dh_recipient } = await getWorkerProxy();

  const theirIdentityKey = sodium.from_base64(initiatorIdentityKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirEphemeralKey = sodium.from_base64(initiatorEphemeralKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  return worker_x3dh_recipient({
    myIdentityKey: myIdentityKeyPair,
    mySignedPreKey: mySignedPreKeyPair,
    theirIdentityKey,
    theirEphemeralKey,
  });
}

// --- Key Recovery & Fulfillment ---

interface GroupFulfillRequestPayload {
  conversationId: string;
  requesterId: string;
  requesterPublicKey: string;
}

interface FulfillRequestPayload {
  conversationId: string;
  sessionId: string;
  requesterId: string;
  requesterPublicKey: string;
}

interface ReceiveKeyPayload {
  conversationId: string;
  sessionId?: string;
  encryptedKey: string;
  type?: 'GROUP_KEY' | 'SESSION_KEY';
}

export async function fulfillGroupKeyRequest(payload: GroupFulfillRequestPayload): Promise<void> {
  const { conversationId, requesterId, requesterPublicKey: requesterPublicKeyB64 } = payload;
  const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (!conversation || !conversation.participants.some(p => p.id === requesterId)) return;

  const key = await getGroupKey(conversationId);
  if (!key) return;

  const sodium = await getSodiumLib();
  const { worker_crypto_box_seal } = await getWorkerProxy();

  const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  const encryptedKeyForRequester = await worker_crypto_box_seal(key, requesterPublicKey);

  emitGroupKeyFulfillment({
    requesterId,
    conversationId,
    encryptedKey: sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants.URLSAFE_NO_PADDING),
  });
}

export async function fulfillKeyRequest(payload: FulfillRequestPayload): Promise<void> {
  const { conversationId, sessionId, requesterId, requesterPublicKey: requesterPublicKeyB64 } = payload;
  const key = await getKeyFromDb(conversationId, sessionId);
  if (!key) return;

  const sodium = await getSodiumLib();
  const { worker_crypto_box_seal } = await getWorkerProxy();

  const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  const encryptedKeyForRequester = await worker_crypto_box_seal(key, requesterPublicKey);

  emitSessionKeyFulfillment({
    requesterId,
    conversationId,
    sessionId,
    encryptedKey: sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants.URLSAFE_NO_PADDING),
  });
}

export async function storeReceivedSessionKey(payload: ReceiveKeyPayload): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const { conversationId, sessionId, encryptedKey, type } = payload;

  if (type === 'GROUP_KEY') {
    const pendingRequest = pendingGroupKeyRequests.get(conversationId);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timerId);
      pendingGroupKeyRequests.delete(conversationId);
    }
    await handleGroupKeyDistribution(conversationId, encryptedKey);
  } else if (sessionId) {
    const { publicKey, privateKey } = await getMyEncryptionKeyPair();
    const newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
    await addSessionKey(conversationId, sessionId, newSessionKey);
  }
}

// --- File Encryption/Decryption ---

const IV_LENGTH = 12;

export async function encryptFile(blob: Blob): Promise<{ encryptedBlob: Blob; key: string }> {
  const fileData = await blob.arrayBuffer();
  const sodium = await getSodiumLib();
  const { worker_file_encrypt } = await getWorkerProxy();
  
  const { encryptedData, iv, key } = await worker_file_encrypt(fileData);

  const combined = new Uint8Array(iv.length + encryptedData.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encryptedData), iv.length);
  const encryptedBlob = new Blob([combined], { type: 'application/octet-stream' });

  const keyB64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);

  return { encryptedBlob, key: keyB64 };
}

export async function decryptFile(encryptedBlob: Blob, keyB64: string, originalType: string): Promise<Blob> {
  const sodium = await getSodiumLib();
  const { worker_file_decrypt } = await getWorkerProxy();

  const keyBytes = sodium.from_base64(keyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  const combinedData = await encryptedBlob.arrayBuffer();
  if (combinedData.byteLength < IV_LENGTH) throw new Error("Encrypted file is too short.");

  const decryptedData = await worker_file_decrypt(combinedData, keyBytes);

  return new Blob([decryptedData], { type: originalType });
}

export async function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): Promise<string> {
  const { generateSafetyNumber } = await getWorkerProxy();
  return generateSafetyNumber(myPublicKey, theirPublicKey);
}