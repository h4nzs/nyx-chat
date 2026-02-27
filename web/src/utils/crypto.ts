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
  storeOneTimePreKey,
  getOneTimePreKey,
  deleteOneTimePreKey,
  getLastOtpkId,
  storeRatchetSession,
  getRatchetSession,
  storeSkippedKey,
  getSkippedKey,
  deleteSkippedKey,
  storeMessageKey,
  getMessageKey,
  deleteMessageKey,
  getGroupSenderState,
  saveGroupSenderState,
  getGroupReceiverState,
  saveGroupReceiverState,
  deleteGroupStates,
  GroupSenderState,
  GroupReceiverState
} from '@lib/keychainDb';
import { 
  emitSessionKeyFulfillment, 
  emitSessionKeyRequest, 
  emitGroupKeyDistribution, 
  emitGroupKeyRequest, 
  emitGroupKeyFulfillment 
} from '@lib/socket';
import type { Participant } from '@store/conversation';
import type { SerializedRatchetState } from '@lib/crypto-worker-proxy';

// --- Secure Storage Helpers ---

async function getMasterSeedOrThrow(): Promise<Uint8Array> {
  const masterSeed = await useAuthStore.getState().getMasterSeed();
  if (!masterSeed) {
    throw new Error("Master key locked or unavailable. Please unlock your session.");
  }
  return masterSeed;
}

export async function storeRatchetStateSecurely(conversationId: string, state: SerializedRatchetState) {
  const masterSeed = await getMasterSeedOrThrow();
  const { worker_encrypt_session_key } = await getWorkerProxy();
  const stateBytes = new TextEncoder().encode(JSON.stringify(state));
  const encryptedState = await worker_encrypt_session_key(stateBytes, masterSeed);
  await storeRatchetSession(conversationId, encryptedState);
}

export async function retrieveRatchetStateSecurely(conversationId: string): Promise<SerializedRatchetState | null> {
  const encryptedState = await getRatchetSession(conversationId);
  if (!encryptedState) return null;

  try {
    const masterSeed = await getMasterSeedOrThrow();
    const { worker_decrypt_session_key } = await getWorkerProxy();
    const stateBytes = await worker_decrypt_session_key(encryptedState, masterSeed);
    return JSON.parse(new TextDecoder().decode(stateBytes));
  } catch (error) {
    console.error(`Failed to decrypt ratchet state for ${conversationId}:`, error);
    return null;
  }
}

export async function storeSkippedMessageKeySecurely(headerKey: string, mkString: string) {
  const masterSeed = await getMasterSeedOrThrow();
  const { worker_encrypt_session_key } = await getWorkerProxy();
  const mkBytes = new TextEncoder().encode(mkString);
  const encryptedMk = await worker_encrypt_session_key(mkBytes, masterSeed);
  await storeSkippedKey(headerKey, encryptedMk);
}

export async function retrieveSkippedMessageKeySecurely(headerKey: string): Promise<string | null> {
  const encryptedMk = await getSkippedKey(headerKey);
  if (!encryptedMk) return null;

  try {
    const masterSeed = await getMasterSeedOrThrow();
    const { worker_decrypt_session_key } = await getWorkerProxy();
    const mkBytes = await worker_decrypt_session_key(encryptedMk, masterSeed);
    return new TextDecoder().decode(mkBytes);
  } catch (error) {
    console.error(`Failed to decrypt skipped key ${headerKey}:`, error);
    return null;
  }
}

export async function storeMessageKeySecurely(messageId: string, mk: Uint8Array) {
  const masterSeed = await getMasterSeedOrThrow();
  const { worker_encrypt_session_key } = await getWorkerProxy();
  const encryptedMk = await worker_encrypt_session_key(mk, masterSeed);
  await storeMessageKey(messageId, encryptedMk);
}

export async function retrieveMessageKeySecurely(messageId: string): Promise<Uint8Array | null> {
  const encryptedMk = await getMessageKey(messageId);
  if (!encryptedMk) return null;

  try {
    const masterSeed = await getMasterSeedOrThrow();
    const { worker_decrypt_session_key } = await getWorkerProxy();
    return await worker_decrypt_session_key(encryptedMk, masterSeed);
  } catch (error) {
    console.error(`Failed to decrypt message key for ${messageId}:`, error);
    return null;
  }
}

export async function deleteMessageKeySecurely(messageId: string): Promise<void> {
  const { deleteMessageKey } = await import('@lib/keychainDb');
  await deleteMessageKey(messageId);
}

export async function checkAndRefillOneTimePreKeys(): Promise<void> {
  try {
    const { count } = await authFetch<{ count: number }>('/api/keys/count-otpk');
    const OTPK_THRESHOLD = 50;
    const OTPK_BATCH_SIZE = 100;

    if (count >= OTPK_THRESHOLD) return;

    const masterSeed = await getMasterSeedOrThrow();
    const startId = (await getLastOtpkId()) + 1;
    
    // Dynamic import for worker proxy
    const { worker_generate_otpk_batch } = await import('@lib/crypto-worker-proxy');
    
    const batch = await worker_generate_otpk_batch(OTPK_BATCH_SIZE, startId, masterSeed);
    
    // Store private keys locally
    for (const key of batch) {
      await storeOneTimePreKey(key.keyId, key.encryptedPrivateKey);
    }

    // Upload public keys
    const publicKeys = batch.map(k => ({ keyId: k.keyId, publicKey: k.publicKey }));
    await authFetch('/api/keys/upload-otpk', {
      method: 'POST',
      body: JSON.stringify({ keys: publicKeys })
    });
  } catch (error) {
    console.error("[Crypto] Failed to refill One-Time Pre-Keys:", error);
  }
}

export async function resetOneTimePreKeys(): Promise<void> {
  try {
    await authFetch('/api/keys/otpk', { method: 'DELETE' });
    await checkAndRefillOneTimePreKeys();
  } catch (error) {
    console.error("[Crypto] Failed to reset OTPKs:", error);
  }
}

export async function storeSessionKeySecurely(conversationId: string, sessionId: string, key: Uint8Array) {
  const masterSeed = await getMasterSeedOrThrow();
  const { worker_encrypt_session_key } = await getWorkerProxy();
  const encryptedKey = await worker_encrypt_session_key(key, masterSeed);
  await addSessionKey(conversationId, sessionId, encryptedKey);
}

export async function retrieveSessionKeySecurely(conversationId: string, sessionId: string): Promise<Uint8Array | null> {
  const encryptedKey = await getKeyFromDb(conversationId, sessionId);
  if (!encryptedKey) return null;

  try {
    const masterSeed = await getMasterSeedOrThrow();
    const { worker_decrypt_session_key } = await getWorkerProxy();
    return await worker_decrypt_session_key(encryptedKey, masterSeed);
  } catch (error) {
    console.error(`Failed to decrypt session key for ${sessionId}:`, error);
    return null;
  }
}

export async function storeGroupKeySecurely(conversationId: string, key: Uint8Array) {
  const masterSeed = await getMasterSeedOrThrow();
  const { worker_encrypt_session_key } = await getWorkerProxy();
  const encryptedKey = await worker_encrypt_session_key(key, masterSeed);
  await storeGroupKey(conversationId, encryptedKey);
}

export async function retrieveGroupKeySecurely(conversationId: string): Promise<Uint8Array | null> {
  const encryptedKey = await getGroupKey(conversationId);
  if (!encryptedKey) return null;

  try {
    const masterSeed = await getMasterSeedOrThrow();
    const { worker_decrypt_session_key } = await getWorkerProxy();
    return await worker_decrypt_session_key(encryptedKey, masterSeed);
  } catch (error) {
    console.error(`Failed to decrypt group key for ${conversationId}:`, error);
    return null;
  }
}

export async function retrieveLatestSessionKeySecurely(conversationId: string): Promise<{ sessionId: string; key: Uint8Array } | null> {
  const latest = await getLatestSessionKey(conversationId);
  if (!latest) return null;

  try {
    const masterSeed = await getMasterSeedOrThrow();
    const { worker_decrypt_session_key } = await getWorkerProxy();
    const key = await worker_decrypt_session_key(latest.key, masterSeed);
    return { sessionId: latest.sessionId, key };
  } catch (error) {
    console.error(`Failed to decrypt latest session key for ${conversationId}:`, error);
    return null;
  }
}

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
  oneTimePreKey?: {
    keyId: number;
    key: string;
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

    await storeSessionKeySecurely(conversationId, sessionId, newSessionKey);
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
      // PHASE 2: Sender Key Protocol
      const existingSenderState = await getGroupSenderState(conversationId);
      if (existingSenderState) return null; // We already have a sender key for this group

      const sodium = await getSodiumLib();
      const { groupInitSenderKey, worker_crypto_box_seal } = await getWorkerProxy();

      // 1. Generate NEW Sender Key (Chain Key)
      const { senderKeyB64 } = await groupInitSenderKey();
      
      // 2. Save Initial Sender State
      await saveGroupSenderState({
          conversationId,
          CK: senderKeyB64,
          N: 0
      });

      const myId = useAuthStore.getState().user?.id;
      const otherParticipants = participants.filter(p => p.id !== myId);
      const missingKeys: string[] = [];

      // 3. Encrypt Sender Key for EACH participant (Fan-out)
      const distributionKeys = await Promise.all(
        otherParticipants.map(async (p) => {
          if (!p.publicKey) {
            missingKeys.push(p.id);
            return null;
          }
          const theirPublicKey = sodium.from_base64(p.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
          const encryptedKey = await worker_crypto_box_seal(
              sodium.from_base64(senderKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING), 
              theirPublicKey
          );
          
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

export async function handleGroupKeyDistribution(
    conversationId: string, 
    encryptedKey: string,
    senderId: string // Need to know WHOSE key this is
): Promise<void> {
  const { publicKey, privateKey } = await getMyEncryptionKeyPair();
  const sodium = await getSodiumLib();
  
  // 1. Decrypt the Sender Key (Chain Key)
  const senderKeyBytes = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
  const senderKeyB64 = sodium.to_base64(senderKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  // 2. Save as Receiver State
  await saveGroupReceiverState({
      id: `${conversationId}_${senderId}`,
      conversationId,
      senderId,
      CK: senderKeyB64,
      N: 0,
      skippedKeys: []
  });
}

export async function rotateGroupKey(conversationId: string, reason: 'membership_change' | 'periodic_rotation' = 'membership_change'): Promise<void> {
  // Clear OLD states
  await deleteGroupStates(conversationId);
  
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

const periodicGroupKeyRotationTimers = new Map<string, NodeJS.Timeout>();

export async function schedulePeriodicGroupKeyRotation(conversationId: string): Promise<void> {
  stopPeriodicGroupKeyRotation(conversationId);

  const rotationInterval = 24 * 60 * 60 * 1000;
  const timerId = setInterval(async () => {
    await rotateGroupKey(conversationId, 'periodic_rotation');
  }, rotationInterval);

  periodicGroupKeyRotationTimers.set(conversationId, timerId);
}

export function stopPeriodicGroupKeyRotation(conversationId: string): void {
  const timerId = periodicGroupKeyRotationTimers.get(conversationId);
  if (timerId) {
    clearInterval(timerId);
    periodicGroupKeyRotationTimers.delete(conversationId);
  }
}

async function requestGroupKeyWithTimeout(conversationId: string, attempt = 0) {
  if (pendingGroupKeyRequests.has(conversationId)) return;

  emitGroupKeyRequest(conversationId);

  const timerId = window.setTimeout(async () => {
    pendingGroupKeyRequests.delete(conversationId);
    if (attempt < MAX_KEY_REQUEST_RETRIES) {
      requestGroupKeyWithTimeout(conversationId, attempt + 1);
    } else {
      const { useMessageStore } = await import('@store/message');
      useMessageStore.getState().failPendingMessages(conversationId, '[Key request timed out]');
    }
  }, KEY_REQUEST_TIMEOUT_MS);

  pendingGroupKeyRequests.set(conversationId, { timerId });
}

// --- Message Encryption/Decryption ---

const XCHACHA20_NONCE_BYTES = 24;

export async function encryptMessage(
  text: string,
  conversationId: string,
  isGroup: boolean = false,
  existingSession?: { sessionId: string; key: Uint8Array },
  messageId?: string
): Promise<{ ciphertext: string; sessionId?: string; drHeader?: any; mk?: Uint8Array }> {
  const sodium = await getSodiumLib();
  const { worker_crypto_secretbox_xchacha20poly1305_easy, worker_dr_ratchet_encrypt, groupRatchetEncrypt } = await getWorkerProxy();

  if (isGroup) {
    // SENDER KEY PROTOCOL
    const senderState = await getGroupSenderState(conversationId);
    if (!senderState) throw new Error(`No sender key available for conversation ${conversationId}.`);
    
    const signingPrivateKey = await useAuthStore.getState().getSigningPrivateKey();
    
    // Encrypt & Ratchet
    const result = await groupRatchetEncrypt(
        { CK: senderState.CK, N: senderState.N },
        text,
        signingPrivateKey
    );
    
    // Update State
    await saveGroupSenderState({
        conversationId,
        CK: result.state.CK,
        N: result.state.N
    });
    
    // [FIX PERSISTENCE] Store MK for Self-Message History
    if (messageId && result.mk) {
        await storeMessageKeySecurely(messageId, result.mk);
    }
    
    // Construct Payload
    const payload = JSON.stringify({
        header: result.header,
        ciphertext: sodium.to_base64(result.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
        signature: result.signature
    });
    
    return { ciphertext: payload, mk: result.mk };
    
  } else {
    // DOUBLE RATCHET
    const state = await retrieveRatchetStateSecurely(conversationId);
    if (!state) throw new Error('Ratchet state not initialized for encryption.');

    const result = await worker_dr_ratchet_encrypt({
        serializedState: state,
        plaintext: text
    });

    await storeRatchetStateSecurely(conversationId, result.state);

    const mkUint8 = new Uint8Array(result.mk);

    if (messageId) {
       await storeMessageKeySecurely(messageId, mkUint8);
    }

    return { 
        ciphertext: sodium.to_base64(result.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
        drHeader: result.header,
        mk: mkUint8 
    };
  }
}

export async function decryptMessage(
  cipher: string,
  conversationId: string,
  isGroup: boolean,
  sessionId: string | null | undefined, // In group, this might be senderId
  messageId?: string
): Promise<DecryptResult> {
  if (!cipher) return { status: 'success', value: '' };

  const sodium = await getSodiumLib();
  const { worker_crypto_secretbox_xchacha20poly1305_open_easy, groupRatchetDecrypt } = await getWorkerProxy();

  // [FIX PERSISTENCE] GLOBAL SHORTCUT: Check Local Message Key Cache First
  if (messageId) {
      const mk = await retrieveMessageKeySecurely(messageId);
      if (mk) {
          let actualCipher = cipher;
          
          const unwrapCipher = (str: string): string => {
              if (str.trim().startsWith('{')) {
                  try {
                      const p = JSON.parse(str);
                      if (p.ciphertext) return unwrapCipher(p.ciphertext);
                  } catch {}
              }
              return str;
          };
          
          actualCipher = unwrapCipher(cipher);

          try {
              const combined = sodium.from_base64(actualCipher, sodium.base64_variants.URLSAFE_NO_PADDING);
              const nonce = combined.slice(0, XCHACHA20_NONCE_BYTES);
              const encrypted = combined.slice(XCHACHA20_NONCE_BYTES);
              const decrypted = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
              return { status: 'success', value: sodium.to_string(decrypted) };
          } catch (e) {
              // Fail silently and try fallback
          }
      }
  }

  if (isGroup) {
    const senderId = sessionId; 
    
    if (!senderId) return { status: 'error', error: new Error('Missing senderId for group decryption') };
    
    const receiverState = await getGroupReceiverState(conversationId, senderId);
    if (!receiverState) {
        requestGroupKeyWithTimeout(conversationId); 
        return { status: 'pending', reason: 'waiting_for_key' };
    }
    
    try {
        const payload = JSON.parse(cipher);
        const { header, ciphertext, signature } = payload;
        
        const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
        const sender = conversation?.participants.find(p => p.id === senderId);
        
        const keyToUse = sender?.signingKey || sender?.publicKey;
        if (!keyToUse) {
             return { status: 'error', error: new Error('Missing sender signing key') };
        }
        
        const senderSigningKey = sodium.from_base64(keyToUse, sodium.base64_variants.URLSAFE_NO_PADDING);
        const ciphertextBytes = sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        const result = await groupRatchetDecrypt(
            { CK: receiverState.CK, N: receiverState.N },
            header,
            ciphertextBytes,
            signature,
            senderSigningKey
        );
        
        // Update State
        await saveGroupReceiverState({
            ...receiverState,
            CK: result.state.CK,
            N: result.state.N,
            skippedKeys: [...(receiverState.skippedKeys || []), ...result.skippedKeys]
        });
        
        return { status: 'success', value: sodium.to_string(result.plaintext) };
        
    } catch (e: any) {
      console.error(`Group Decryption failed for convo ${conversationId}:`, e);
      return { status: 'error', error: new Error(e.message || 'Failed to decrypt group message') };
    }
  } else {
    // DOUBLE RATCHET & LEGACY FALLBACK
    try {
      let payload;
      try {
        payload = JSON.parse(cipher);
      } catch {
        if (!sessionId) return { status: 'error', error: new Error('Cannot decrypt legacy message: Missing session ID.') };
        const key = await retrieveSessionKeySecurely(conversationId, sessionId);
        if (!key) {
            emitSessionKeyRequest(conversationId, sessionId);
            return { status: 'pending', reason: '[Requesting key to decrypt...]' };
        }
        const combined = sodium.from_base64(cipher, sodium.base64_variants.URLSAFE_NO_PADDING);
        const nonce = combined.slice(0, XCHACHA20_NONCE_BYTES);
        const encrypted = combined.slice(XCHACHA20_NONCE_BYTES);
        const decrypted = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, key);
        return { status: 'success', value: sodium.to_string(decrypted) };
      }

      if (!payload.dr || !payload.ciphertext) {
        if (!sessionId) return { status: 'error', error: new Error('Cannot decrypt legacy message: Missing session ID.') };
        const key = await retrieveSessionKeySecurely(conversationId, sessionId);
        if (!key) {
            emitSessionKeyRequest(conversationId, sessionId);
            return { status: 'pending', reason: '[Requesting key to decrypt...]' };
        }
        const combined = sodium.from_base64(cipher, sodium.base64_variants.URLSAFE_NO_PADDING);
        const nonce = combined.slice(0, XCHACHA20_NONCE_BYTES);
        const encrypted = combined.slice(XCHACHA20_NONCE_BYTES);
        const decrypted = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, key);
        return { status: 'success', value: sodium.to_string(decrypted) };
      }

      const drHeader = payload.dr;
      const actualCipher = payload.ciphertext;
      const headerKey = `${conversationId}_${drHeader.dh}_${drHeader.n}`;

      const skippedMkStr = await retrieveSkippedMessageKeySecurely(headerKey);
      if (skippedMkStr) {
          const mk = sodium.from_base64(skippedMkStr, sodium.base64_variants.URLSAFE_NO_PADDING);
          const combined = sodium.from_base64(actualCipher, sodium.base64_variants.URLSAFE_NO_PADDING);
          const nonce = combined.slice(0, XCHACHA20_NONCE_BYTES);
          const encrypted = combined.slice(XCHACHA20_NONCE_BYTES);
          const decrypted = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
          
          await deleteSkippedKey(headerKey);
          return { status: 'success', value: sodium.to_string(decrypted) };
      }

      const state = await retrieveRatchetStateSecurely(conversationId);
      if (!state) {
          return { status: 'pending', reason: 'waiting_for_ratchet_state' };
      }

      const { worker_dr_ratchet_decrypt } = await getWorkerProxy();
      const combined = sodium.from_base64(actualCipher, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      const result = await worker_dr_ratchet_decrypt({
          serializedState: state,
          header: drHeader,
          ciphertext: combined
      });

      await storeRatchetStateSecurely(conversationId, result.state);

      if (messageId) {
          await storeMessageKeySecurely(messageId, result.mk);
      }

      for (const sk of result.skippedKeys) {
          const hKey = `${conversationId}_${sk.dh}_${sk.n}`;
          await storeSkippedMessageKeySecurely(hKey, sk.mk);
      }

      return { status: 'success', value: sodium.to_string(result.plaintext) };

    } catch (e: any) {
      console.error(`DR Decryption failed for convo ${conversationId}:`, e);
      return { status: 'error', error: new Error('Failed to decrypt message') };
    }
  }
}

// --- Pre-Key Handshake (Full X3DH with OTPK) ---

export async function establishSessionFromPreKeyBundle(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  preKeyBundle: PreKeyBundle
): Promise<{ sessionKey: Uint8Array, ephemeralPublicKey: string, otpkId?: number }> {
  const sodium = await getSodiumLib();
  const { worker_x3dh_initiator } = await getWorkerProxy();

  const theirIdentityKey = sodium.from_base64(preKeyBundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSignedPreKey = sodium.from_base64(preKeyBundle.signedPreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSigningKey = sodium.from_base64(preKeyBundle.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const signature = sodium.from_base64(preKeyBundle.signedPreKey.signature, sodium.base64_variants.URLSAFE_NO_PADDING);

  let theirOneTimePreKey: Uint8Array | undefined;
  if (preKeyBundle.oneTimePreKey) {
    theirOneTimePreKey = sodium.from_base64(preKeyBundle.oneTimePreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  const result = await worker_x3dh_initiator({
    myIdentityKey: myIdentityKeyPair,
    theirIdentityKey,
    theirSignedPreKey,
    theirSigningKey,
    signature,
    theirOneTimePreKey // Pass OTPK if available
  });

  return {
    ...result,
    otpkId: preKeyBundle.oneTimePreKey?.keyId
  };
}

export async function deriveSessionKeyAsRecipient(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  mySignedPreKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  initiatorIdentityKeyStr: string,
  initiatorEphemeralKeyStr: string,
  otpkId?: number
): Promise<Uint8Array> {
  const sodium = await getSodiumLib();
  const { worker_x3dh_recipient, worker_decrypt_session_key } = await getWorkerProxy();

  const theirIdentityKey = sodium.from_base64(initiatorIdentityKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirEphemeralKey = sodium.from_base64(initiatorEphemeralKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  let myOneTimePreKey: { privateKey: Uint8Array } | undefined;

  if (otpkId !== undefined) {
    const masterSeed = await getMasterSeedOrThrow();
    
    // 1. Try Retrieve Encrypted OTPK Private Key from Local Storage
    const encryptedOtpk = await getOneTimePreKey(otpkId);
    
    if (encryptedOtpk) {
      try {
        const otpkPrivateKey = await worker_decrypt_session_key(encryptedOtpk, masterSeed);
        myOneTimePreKey = { privateKey: otpkPrivateKey };
      } catch (e) {
        console.error("Failed to decrypt stored OTPK:", e);
      }
    } 
    
    // 2. RECOVERY: If not found (e.g. after logout/restore), Regenerate Deterministically
    if (!myOneTimePreKey) {
        try {
            const { worker_x3dh_recipient_regenerate } = await getWorkerProxy();
            const sessionKey = await worker_x3dh_recipient_regenerate({
                keyId: otpkId,
                masterSeed,
                myIdentityKey: myIdentityKeyPair,
                mySignedPreKey: mySignedPreKeyPair,
                theirIdentityKey: sodium.from_base64(initiatorIdentityKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING),
                theirEphemeralKey: sodium.from_base64(initiatorEphemeralKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING)
            });
            return sessionKey;
        } catch (e) {
            console.error(`[X3DH] Failed to regenerate OTPK ${otpkId}:`, e);
        }
    }
  }

  try {
    const sessionKey = await worker_x3dh_recipient({
      myIdentityKey: myIdentityKeyPair,
      mySignedPreKey: mySignedPreKeyPair,
      theirIdentityKey,
      theirEphemeralKey,
      myOneTimePreKey
    });

    // 3. Perfect Forward Secrecy: Delete the OTPK after use
    // Even if we regenerated it, we don't store it back, just use and forget.
    if (otpkId !== undefined) {
      await deleteOneTimePreKey(otpkId);
    }

    return sessionKey;
  } finally {
    // Cleanup if needed (worker handles most)
  }
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
  senderId?: string; // New: Needed for Group Sender Keys
  initiatorEphemeralKey?: string; // Need this for X3DH calc
  initiatorIdentityKey?: string; // Need this for X3DH calc
}

export async function fulfillGroupKeyRequest(payload: GroupFulfillRequestPayload): Promise<void> {
  const { conversationId, requesterId, requesterPublicKey: requesterPublicKeyB64 } = payload;
  const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (!conversation || !conversation.participants.some(p => p.id === requesterId)) return;

  const key = await retrieveGroupKeySecurely(conversationId);
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
  const key = await retrieveSessionKeySecurely(conversationId, sessionId);
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
  const { conversationId, sessionId, encryptedKey, type, senderId, initiatorEphemeralKey, initiatorIdentityKey } = payload;
  
  if (encryptedKey === 'dummy' || (sessionId && sessionId.startsWith('dummy'))) {
      console.warn("🛡️ [Crypto] BERHASIL MEMBLOKIR KUNCI DUMMY DARI SERVER!", { conversationId, sessionId });
      return; 
  }

  if (type === 'GROUP_KEY') {
    if (!senderId) {
        console.error("Received GROUP_KEY but missing senderId. Cannot store key.");
        return;
    }
    const pendingRequest = pendingGroupKeyRequests.get(conversationId);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timerId);
      pendingGroupKeyRequests.delete(conversationId);
    }
    
    // Use the NEW handler for Sender Key
    await handleGroupKeyDistribution(conversationId, encryptedKey, senderId);
    
  } else if (sessionId) {
    let newSessionKey: Uint8Array | undefined;

    if (encryptedKey.startsWith('{') && encryptedKey.includes('"x3dh":true')) {
        try {
            const metadata = JSON.parse(encryptedKey);
            if (metadata.x3dh && initiatorEphemeralKey && initiatorIdentityKey) {
                const { getEncryptionKeyPair, getSignedPreKeyPair } = useAuthStore.getState();
                const myIdentityKeyPair = await getEncryptionKeyPair();
                const mySignedPreKeyPair = await getSignedPreKeyPair();

                newSessionKey = await deriveSessionKeyAsRecipient(
                    myIdentityKeyPair,
                    mySignedPreKeyPair,
                    initiatorIdentityKey,
                    initiatorEphemeralKey,
                    metadata.otpkId
                );
            } else {
                throw new Error("Invalid X3DH payload");
            }
        } catch (e) {
            console.error("X3DH derivation failed, falling back to legacy decrypt:", e);
            if (encryptedKey.length > 20) {
                const { publicKey, privateKey } = await getMyEncryptionKeyPair();
                newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
            } else {
                console.warn("[Crypto] Skipping decryption for invalid/placeholder key.");
                return;
            }
        }
    } else {
        if (!encryptedKey || encryptedKey.length < 20) {
             console.warn("[Crypto] Received empty or short session key. Ignoring placeholder.");
             return;
        }

        const { publicKey, privateKey } = await getMyEncryptionKeyPair();
        newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
    }

    if (newSessionKey) {
        await storeSessionKeySecurely(conversationId, sessionId, newSessionKey);
        
        import('@store/message').then(({ useMessageStore }) => {
            useMessageStore.getState().reDecryptPendingMessages(conversationId);
        });
    }
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
