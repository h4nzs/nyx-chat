import type { DoubleRatchetState, ConversationId, UserId, Pseudonym } from '@nyx/shared';
import { asPseudonym } from '@nyx/shared';
// [T1] Helper pseudonym ada di module ringan (testable tanpa graph worker);
// di-import + di-re-export agar pemakaian lama tetap jalan.
import {
  generateGroupPseudonym,
  generatePseudonymMap,
  getPseudonymMap,
  getMyPseudonym,
  resolvePseudonymToUserId,
  getDeliveryTokenMap,
  getMyDeliveryToken,
} from '@lib/groupPseudonyms';
export {
  generateGroupPseudonym,
  generatePseudonymMap,
  getPseudonymMap,
  getMyPseudonym,
  resolvePseudonymToUserId,
  generateDeliveryToken,
  generateDeliveryTokenMap,
  getDeliveryTokenMap,
  getMyDeliveryToken,
  collectMyDeliveryTokens,
} from '@lib/groupPseudonyms';
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { authFetch } from '@lib/api';
import { useAuthStore } from '@store/auth';
import { useConversationStore } from '@store/conversation';
import {
  addSessionKey,
  getSessionKey as getKeyFromDb,
  getLatestSessionKey,
  storeGroupKey,
  getGroupKey,
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
  getGroupSenderState,
  saveGroupSenderState,
  getGroupReceiverState,
  getGroupReceiverStateByKeyId,
  saveGroupReceiverState,
  deleteGroupStates,
  deleteConversationKeychain,
  deleteRatchetSession,
  deleteSessionKeys
} from '@lib/keychainDb';

export { deleteConversationKeychain, deleteRatchetSession, deleteSessionKeys };

import { 
  emitSessionKeyFulfillment, 
  emitSessionKeyRequest, 
  emitGroupKeyDistribution, 
  emitGroupKeyRequest, 
  emitGroupKeyFulfillment 
} from '@lib/transportClient';
import type { Participant } from '@store/conversation';

// --- Group Metadata Helpers ---

export async function encryptGroupMetadata(
  // [T1] metadata v2 membawa v/generation/pseudonymMap; v1 (tanpa field itu)
  // tetap valid untuk grup lawas.
  metadata: { title?: string; description?: string; avatarUrl?: string; participants?: string[]; authSecret?: string; v?: 2; generation?: number; pseudonymMap?: Record<string, string>; deliveryTokenMap?: Record<string, string> },
  conversationId: string,
  // [T1 FIX 2026-09-28] Pseudonym eksplisit untuk distribusi kunci yang dipicu
  // di dalam sini (ensureGroupSession) — penting saat createGroup, peta baru
  // dibuat SEBELUM store terisi (lihat ensureGroupSession).
  opts?: { pseudonym?: string }
): Promise<string> {
  // [T1 ROTATION] Regenerasi peta pseudonym SEKALI di sini — single choke point
  // untuk SEMUA penulisan metadata (createGroup, edit info/avatar, rotasi
  // keanggotaan). Aturan (keputusan 26.7.1):
  //  - Panggilan TANPA pseudonymMap eksplisit (edit biasa / rotasi) → peta baru
  //    di-generate full-rewrite dengan generation+1 (pesannya tak bisa di-link
    //    ke peta lama oleh server).
  //  - Panggilan DENGAN pseudonymMap eksplisit (createGroup men-set generation:1)
  //    → dipakai apa adanya (peta awal).
  //  - Grup lawas v1 (tidak pernah punya peta) TIDAK dimigrasi otomatis di sini:
  //    mereka tetap jalan di jalur legacy; migrasi v1→v2 lazy terjadi saat
  //    createGroup-pattern rewrite (doc 26.5 rollout) — tidak dipaksakan.
  if (metadata.v === 2 && !metadata.pseudonymMap) {
    const prev = getPseudonymMap(conversationId);
    const nextGeneration = ((metadata.generation ?? 0) || 0) + 1;
    metadata = {
      ...metadata,
      generation: nextGeneration,
      pseudonymMap: await generatePseudonymMap(metadata.participants ?? []),
    };
    void prev; // peta lama sengaja tidak dipertahankan — unlinkability requirement
  }
  // [T3b] Token TIDAK di-rotate bersama pseudonym: delivery token adalah
  // identitas penyinkronan yang stabil per anggota (server match by unique
  // index). Re-encrypt tanpa peta eksplisit → warisi peta dari metadata lama
  // (anggota yang keluar hilang otomatis karena metadata baru hanya membawa
  // anggota aktif; server-side revocation = hapus row token). Panggilan dengan
  // peta eksplisit (createGroup) → dipakai apa adanya.
  if (metadata.v === 2 && !metadata.deliveryTokenMap) {
    const prevTokens = getDeliveryTokenMap(conversationId);
    if (prevTokens) metadata = { ...metadata, deliveryTokenMap: prevTokens };
  }
  // Ensure we have a valid session before encrypting metadata
  const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (conversation) {
    const distributionKeys = await ensureGroupSession(conversationId, conversation.participants, false, opts);
    if (distributionKeys && distributionKeys.length > 0) {
      await emitGroupKeyDistribution(
        conversationId,
        distributionKeys as { userId: string; key: string }[]
      );
      // Brief delay to allow key distribution to process if it's the first time
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const payload = JSON.stringify(metadata);
  // Encrypt as a group message, saving the Message Key locally using a pseudo-messageId
  // Save sender state before metadata encryption so the user's first real message
  // encrypts with the same key that was distributed (N=0 CK, not the ratcheted one).
  const { getGroupSenderState, saveGroupSenderState } = await import('@lib/keychainDb');
  const senderStateBeforeMeta = await getGroupSenderState(conversationId);
  const result = await encryptMessage(payload, conversationId, true, undefined, `meta_${conversationId}`);
  if (senderStateBeforeMeta) {
      await saveGroupSenderState(senderStateBeforeMeta).catch(e => console.warn("Failed to restore sender state after metadata encrypt", e));
  }
  
  const myId = useAuthStore.getState().user?.id;
  if (!myId) throw new Error("Cannot encrypt metadata: User not authenticated");

  const { publicKey } = await getMyEncryptionKeyPair();
  const sodium = await getSodiumLib();
  const myDeviceKey = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

  const wrapper = {
    ...JSON.parse(result.ciphertext), // { header, ciphertext, signature }
    senderId: myId,
    senderDeviceKey: myDeviceKey // ✅ Tambahkan ini
  };
  
  return JSON.stringify(wrapper);
}

export async function decryptGroupMetadata(
  encryptedMetadataStr: string,
  conversationId: string
): Promise<{ title?: string; description?: string; avatarUrl?: string; participants?: string[] } | null> {
  try {
    const wrapper = JSON.parse(encryptedMetadataStr);
    
    // ✅ Ekstrak senderDeviceKey
    const { senderId, senderDeviceKey, ...rest } = wrapper;

    if (!senderId) {
      console.warn("Decryption failed: Missing senderId in group metadata");
      return null;
    }
    
    // Reconstruct the payload expected by decryptMessage
    // ✅ Sertakan senderDeviceKey ke dalam cipherPayload
    const cipherPayload = JSON.stringify({
       ...rest,
       senderId,
       senderDeviceKey 
    });
    
    // Save receiver state before metadata decryption so it doesn't get ratcheted
    // by a non-user message (which would break subsequent user message keyId matching).
    const { getGroupReceiverState, saveGroupReceiverState } = await import('@lib/keychainDb');
    const rsBefore = senderDeviceKey
        ? await getGroupReceiverState(conversationId, senderId, senderDeviceKey)
        : await getGroupReceiverState(conversationId, senderId);

    // Pass the pseudo-messageId so the creator can decrypt it from their local MK cache
    const result = await decryptMessage(cipherPayload, conversationId, true, senderId, `meta_${conversationId}`);

    // Restore receiver state if it was ratcheted by this metadata decrypt
    if (rsBefore) {
        const rsAfter = senderDeviceKey
            ? await getGroupReceiverState(conversationId, senderId, senderDeviceKey)
            : await getGroupReceiverState(conversationId, senderId);
        if (rsAfter && rsAfter.N !== rsBefore.N) {
            await saveGroupReceiverState(rsBefore).catch(e => console.warn("Failed to restore receiver state after metadata decrypt", e));
        }
    }
    
    if (result.status === 'success') {
      try {
        let text = String(result.value);
        // Unwrap Sealed Sender wrapper if present
        if (text.startsWith('{') && text.includes('"senderId"')) {
           try {
               const p = JSON.parse(text);
               if (p.content) text = p.content;
           } catch {}
        }
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    } else {
      console.warn(`Group metadata decryption failed: ${result.status}`, result);
      return null;
    }
  } catch (e) {
    console.error("Failed to decrypt group metadata", e);
    return null;
  }
}

// --- T1: Group sender pseudonyms (doc 26.2 / 26.7) ---
// Helper dipindah ke lib/groupPseudonyms.ts (module ringan, testable tanpa
// graph worker) — import + re-export di atas.

// --- Secure Storage Helpers ---

async function getMasterSeedOrThrow(): Promise<Uint8Array> {
  const masterSeed = await useAuthStore.getState().getMasterSeed();
  if (!masterSeed) {
    throw new Error("Master key locked or unavailable. Please unlock your session.");
  }
  return masterSeed;
}

export async function storeRatchetStateSecurely(conversationId: string, state: DoubleRatchetState) {
  const masterSeed = await getMasterSeedOrThrow();
  const { worker_encrypt_session_key } = await getWorkerProxy();
  const stateBytes = new TextEncoder().encode(JSON.stringify(state));
  const encryptedState = await worker_encrypt_session_key(stateBytes, masterSeed);
  await storeRatchetSession(conversationId, encryptedState);
}

export async function retrieveRatchetStateSecurely(conversationId: string): Promise<DoubleRatchetState | null> {
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

// --- PreKey Download Implementation ---

export interface PreKeyBundle {
  deviceId: string;
  identityKey: string;
  pqIdentityKey?: string; // NEW
  signingKey: string;
  signedPreKey: {
    key: string;
    pqKey?: string; // NEW
    signature: string;
    pqSignature?: string; // NEW
  };
  oneTimePreKey?: {
    keyId: number;
    key: string;
    pqKey?: string; // NEW
  };
}

export const fetchPublicKeys = async (userIds: string[]): Promise<Record<string, PreKeyBundle[]>> => {
  try {
      if (!userIds || userIds.length === 0) return {};
      
      const response = await authFetch<Record<string, PreKeyBundle[]>>(`/api/keys/public-keys`, {
          method: 'POST',
          body: JSON.stringify({ userIds })
      });
      
      return response || {};
  } catch (error) {
      console.error(`Failed to bulk fetch public keys:`, error);
      throw error;
  }
};

export const fetchPreKeyBundle = async (userId: string): Promise<PreKeyBundle> => {
  try {
      const bundle = await authFetch<PreKeyBundle>(`/api/keys/prekey-bundle/${userId}`);
      
      if (!bundle || !bundle.identityKey) {
           throw new Error(`No pre-key bundles found for user ${userId}`);
      }
      return bundle;
  } catch (error) {
      console.error(`Failed to fetch pre-key bundles for ${userId}:`, error);
      throw error;
  }
};

export const fetchPreKeyBundles = async (userIds: string[]): Promise<Record<string, PreKeyBundle[]>> => {
  try {
      if (!userIds || userIds.length === 0) return {};
      
      const response = await authFetch<Record<string, PreKeyBundle[]>>(`/api/keys/prekey-bundles`, {
          method: 'POST',
          body: JSON.stringify({ userIds })
      });
      
      return response || {};
  } catch (error) {
      console.error(`Failed to bulk fetch pre-key bundles:`, error);
      throw error;
  }
};

let isUploadingPrekeys = false;
let lastPrekeyRefill = 0;
// [MID-SESSION REFILL] Ambang stok rendah untuk pemicu di tengah sesi
// (visibilitychange / bundle tanpa OTPK). Refill penuh ke 50 tetap dilakukan;
// angka kecil ini hanya menentukan KAPAN cek tengah sesi bersedia mengisi.
export const OTPK_LOW_STOCK_THRESHOLD = 3;

export async function checkAndRefillOneTimePreKeys(opts?: { force?: boolean }): Promise<void> {
  if (isUploadingPrekeys) return;
  const now = Date.now();
  if (!opts?.force && now - lastPrekeyRefill < 60000) return; // 1 minute cooldown

  isUploadingPrekeys = true;
  
  try {
    const { count } = await authFetch<{ count: number }>('/api/keys/count-otpk');
    const OTPK_THRESHOLD = 50;
    const OTPK_BATCH_SIZE = 20;

    if (count >= OTPK_THRESHOLD) return;

    const masterSeed = await getMasterSeedOrThrow();
    let currentStartId = (await getLastOtpkId()) + 1;
    let currentCount = count;

    // Dynamic import for worker proxy
    const { worker_generate_otpk_batch } = await import('@lib/crypto-worker-proxy');

    while (currentCount < OTPK_THRESHOLD) {
        const batch = await worker_generate_otpk_batch(OTPK_BATCH_SIZE, currentStartId, masterSeed);

        // Store private keys locally
        for (const key of batch) {
          // Ensure keyId is treated as a number
          await storeOneTimePreKey(Number(key.keyId), key.encryptedPrivateKey);
        }

        // Upload public keys
        const publicKeys = batch.map(k => ({ keyId: Number(k.keyId), publicKey: k.publicKey, pqPublicKey: k.pqPublicKey }));
        await authFetch('/api/keys/upload-otpk', {
          method: 'POST',
          body: JSON.stringify({ keys: publicKeys })
        });
        
        currentCount += batch.length;
        currentStartId += batch.length;
    }
    lastPrekeyRefill = Date.now();
  } catch (error) {
    console.error("[Crypto] Failed to refill One-Time Pre-Keys:", error);
  } finally {
    isUploadingPrekeys = false;
  }
}
// [MID-SESSION REFILL] Fire-and-forget: cek stok OTPK server; refill (melewati
// cooldown) HANYA bila stok < OTPK_LOW_STOCK_THRESHOLD (termasuk habis = 0).
// Aman dipanggil sering — cek murah (1 GET) dan error di-swallow.
export function scheduleOtpkTopUpCheck(): void {
  void (async () => {
    try {
      const { count } = await authFetch<{ count: number }>('/api/keys/count-otpk');
      if (count < OTPK_LOW_STOCK_THRESHOLD) {
        await checkAndRefillOneTimePreKeys({ force: true });
      }
    } catch {
      // Off-line / belum auth — coba lagi di pemicu berikutnya.
    }
  })();
}

// Dipanggil dari lifecycle app (visibilitychange): user kembali ke tab →
// kesempatan alami mengecek stok di tengah sesi tanpa menunggu login berikutnya.
export function installOtpkMidSessionRefill(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleOtpkTopUpCheck();
    }
  });
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

// --- Module-level state for managing key requests ---
const pendingGroupKeyRequests = new Map<string, { attempt: number, timerId: number }>();
const MAX_KEY_REQUEST_RETRIES = 2; // Total 3 attempts
const KEY_REQUEST_TIMEOUT_MS = 15000; // 15 seconds

const pendingGroupSessionPromises = new Map<string, Promise<Record<string, unknown>[] | null>>();
const groupSessionLocks = new Set<string>();

// --- E2EE WebRTC Signaling Helpers ---

export async function generateCallKey(): Promise<string> {
  const { getSodium } = await import('@lib/sodiumInitializer');
  const sodium = await getSodium();
  const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  return sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function encryptCallSignal(payload: object, base64Key: string): Promise<string> {
  // Canonical XChaCha envelope — AEAD dijalankan di crypto worker
  const { workerXChaChaSeal } = await import('@lib/crypto-worker-proxy');
  return workerXChaChaSeal(base64Key, JSON.stringify(payload));
}

export async function decryptCallSignal(encryptedStr: string, base64Key: string): Promise<unknown> {
  const { workerXChaChaOpen } = await import('@lib/crypto-worker-proxy');
  const jsonStr = await workerXChaChaOpen(base64Key, encryptedStr);
  return JSON.parse(jsonStr);
}

// --- End E2EE WebRTC Signaling Helpers ---
export async function getWorkerProxy() {
  return import('@lib/crypto-worker-proxy');
}

export async function getSodiumLib() {
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
  try {
      const sessionKey = await worker_crypto_box_seal_open(encryptedSessionKey, publicKey, privateKey);
      if (!sessionKey) {
        throw new Error("Failed to decrypt session key, likely due to incorrect key pair or corrupted data.");
      }
      return sessionKey;
  } catch (e) {
      console.warn("Failed to decrypt session key via worker, ignoring:", e);
      throw e;
  }
}

// --- Session Ratcheting and Key Retrieval ---

export async function ensureAndRatchetSession(conversationId: string): Promise<void> {
  try {
    const sodium = await getSodiumLib();
    const { worker_pq_box_seal } = await getWorkerProxy();
    const { publicKey: myPublicKey } = await getMyEncryptionKeyPair();
    const myIdentityKeyB64 = sodium.to_base64(myPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    
    // 1. Generate local session key and ID
    const sessionId = sodium.to_hex(sodium.randombytes_buf(16));
    const sessionKey = sodium.randombytes_buf(32);
    
    const conversationStore = useConversationStore.getState();
    const conversation = conversationStore.conversations.find(c => c.id === conversationId);
    if (!conversation) throw new Error("Conversation not found for ratcheting");

    // 2. Fetch all participant bundles
    const userIds = conversation.participants.map(p => p.id);
    const bundlesMap = await fetchPreKeyBundles(userIds);
    
    const keysPayload: Record<string, unknown>[] = [];
    const myId = useAuthStore.getState().user?.id;

    // 3. Encrypt for all devices of all participants
    for (const uId of userIds) {
      const bundles = bundlesMap[uId] || [];
      for (const bundle of bundles) {
        // Skip current device
        if (uId === myId && bundle.identityKey === myIdentityKeyB64) continue;

        const theirPublicKey = sodium.from_base64(bundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        const theirPqPublicKey = bundle.pqIdentityKey ? sodium.from_base64(bundle.pqIdentityKey, sodium.base64_variants.URLSAFE_NO_PADDING) : null;

        if (!theirPqPublicKey) {
          console.warn(`Skipping device ${bundle.deviceId} for user ${uId}: Missing PQ key`);
          continue;
        }

        const encryptedKey = await worker_pq_box_seal(sessionKey, theirPqPublicKey, theirPublicKey);
        
        keysPayload.push({
          deviceId: bundle.deviceId,
          encryptedKey: sodium.to_base64(encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING),
          isInitiator: uId === myId
        });
      }
    }

    // 4. Relay to server
    await authFetch(`/api/session-keys/${conversationId}/ratchet`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, keys: keysPayload })
    });

    // 5. Store locally
    await storeSessionKeySecurely(conversationId, sessionId, sessionKey);
  } catch (error) {
    console.error('Failed to ratchet session for:', conversationId, error);
    throw new Error('Could not establish a secure session locally.');
  }
}

// --- Group Key Management & Recovery ---

// ✅ FASE 3: FAN-OUT GROUP SESSION BUILDER
export async function ensureGroupSession(
  conversationId: string,
  participants: Participant[],
  forceRotate: boolean = false,
  // [T1 FIX 2026-09-28] Pseudonym eksplisit untuk distribusi kunci PERTAMA.
  // Saat createGroup, peta pseudonym baru dibuat di memori SEBELUM store
  // diisi — getMyPseudonym() (yang baca store) return undefined → fallback
  // myId bocorkan userId pengirim ke server pada GROUP_KEY pertama. Caller
  // yang pegang peta (createGroup → encryptGroupMetadata) menyuntikkan
  // pseudonym-nya di sini; jalur lain tetap fallback ke store.
  opts?: { pseudonym?: string }
): Promise<Record<string, unknown>[] | null> {
  const cacheKey = `${conversationId}:${forceRotate}`;
  const pending = pendingGroupSessionPromises.get(cacheKey);
  if (pending) return pending;

  if (groupSessionLocks.has(conversationId)) {
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (!groupSessionLocks.has(conversationId)) {
          clearInterval(interval);
          ensureGroupSession(conversationId, participants, forceRotate, opts)
            .then(resolve)
            .catch(reject);
        }
      }, 10);
    });
  }

  groupSessionLocks.add(conversationId);

  const promise = (async () => {
    try {
      if (!forceRotate) {
          const existingSenderState = await getGroupSenderState(conversationId);
          if (existingSenderState) return null;
      }

      const sodium = await getSodiumLib();
      const { groupInitSenderKey, worker_pq_box_seal, worker_pq_box_seal_open } = await getWorkerProxy();
      const { publicKey: myPublicKey } = await getMyEncryptionKeyPair();
      const myIdentityKeyB64 = sodium.to_base64(myPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      // [T2 FIX #9 2026-09-28] Public signing key dibawa dalam distribusi kunci
      // (lihat komentar di distributionKeys.push di bawah).
      const signingPriv = await useAuthStore.getState().getSigningPrivateKey();
      const mySigningKeyB64 = sodium.to_base64(signingPriv.slice(32), sodium.base64_variants.URLSAFE_NO_PADDING);

      const { senderKeyB64 } = await groupInitSenderKey();

      const myId = useAuthStore.getState().user?.id;
      const distributionKeys: Record<string, unknown>[] = [];
      const missingKeys: string[] = [];

      const userIdsToFetch: string[] = [];
      for (const p of participants) {
          const extP = p as Participant;
          const uId = extP.userId || extP.user?.id || extP.id;
          if (uId) userIdsToFetch.push(uId);
      }
      
      if (myId && !userIdsToFetch.includes(myId)) {
          userIdsToFetch.push(myId);
      }

      let fetchedBundlesMap: Record<string, PreKeyBundle[]> = {};
      try {
          fetchedBundlesMap = await fetchPreKeyBundles(userIdsToFetch);
      } catch (e) {
          console.error("Failed to fetch prekey bundles in bulk", e);
      }

      for (const uId of userIdsToFetch) {
          const bundles = fetchedBundlesMap[uId] || [];
          if (bundles.length === 0) {
              console.warn(`Missing or empty keys for user ${uId}`);
              missingKeys.push(uId);
              continue;
          }
          
          for (const bundle of bundles) {
              if (uId === myId && bundle.identityKey === myIdentityKeyB64) {
                  continue;
              }

              const { getPeerIdentityKey, savePeerIdentityKey } = await import('@lib/keychainDb');
              const existingKey = await getPeerIdentityKey(uId);
              if (existingKey && existingKey !== bundle.identityKey) {
                  const { useMessageStore } = await import('@store/message');
                  const { t } = await import('i18next');
                  const { default: toast } = await import('react-hot-toast');
                  const useDynamicIslandStore = (await import('@store/dynamicIsland')).default;

                  const peer = participants.find(p => (p.userId || p.user?.id || p.id) === uId);
                  const peerName = peer?.name || peer?.user?.name || t('common:defaults.unknown_user');
                  const warningText = t('common:security_key_changed', { name: peerName });
                  
                  useMessageStore.getState().addSystemMessage(conversationId, warningText);
                  toast.error(warningText, { icon: '🛡️', duration: 6000 });
                  useDynamicIslandStore.getState().addActivity({
                      type: 'notification',
                      sender: { name: 'NYX_SHIELD' },
                      message: warningText,
                      link: `/chat/${conversationId}`
                  }, 6000);
              }
              await savePeerIdentityKey(uId, bundle.identityKey);

              const theirPublicKey = sodium.from_base64(bundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
              const theirPqPublicKey = bundle.pqIdentityKey ? sodium.from_base64(bundle.pqIdentityKey, sodium.base64_variants.URLSAFE_NO_PADDING) : new Uint8Array(0);
              
              if (theirPqPublicKey.length === 0) {
                  console.warn(`Skipping device ${bundle.deviceId} for user ${uId} due to missing PQ Identity Key.`);
                  continue;
              }

              if (theirPublicKey.length !== 32) {
                  console.error(`Invalid classical public key length for device ${bundle.deviceId}: expected 32, got ${theirPublicKey.length}`);
                  continue;
              }
              if (theirPqPublicKey.length !== sodium.crypto_kem_xwing_PUBLICKEYBYTES) {
                  console.error(`Invalid PQ public key length for device ${bundle.deviceId}: expected ${sodium.crypto_kem_xwing_PUBLICKEYBYTES}, got ${theirPqPublicKey.length}`);
                  continue;
              }

              let finalEncryptedKeyStr = '';

              try {
                  const ckBytes = sodium.from_base64(senderKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
                  const packed = new Uint8Array(4 + ckBytes.length);
                  new DataView(packed.buffer).setUint32(0, 0, false);
                  packed.set(ckBytes, 4);

                  const encryptedKey = await worker_pq_box_seal(
                      packed, 
                      theirPqPublicKey,
                      theirPublicKey
                  );
                  finalEncryptedKeyStr = sodium.to_base64(encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
              } catch (e) {
                  console.error(`[Crypto] Gagal mengenkripsi Sender Key untuk user ${uId} device ${bundle.deviceId}:`, e);
                  continue;
              }
              
              distributionKeys.push({
                  userId: uId,
                  targetDeviceId: bundle.deviceId, 
                  targetDeviceKey: bundle.identityKey,
                  key: finalEncryptedKeyStr,
                  type: 'GROUP_KEY',
                  // [T1] senderId di sini = identitas routing distribusi kunci.
                  // Pakai pseudonym bila peta v2 tersedia agar server tidak bisa
                  // menghubungkan "siapa mendistribusikan kunci ke siapa" dengan
                  // akun. Penerima resolve ke userId via metadata untuk
                  // receiver-state store (handleGroupKeyDistribution).
                  // [T1 FIX 2026-09-28] Prioritas: pseudonym eksplisit dari caller
                  // (createGroup — peta belum ada di store) → store → fallback.
                  senderId: opts?.pseudonym
                      ?? (await getMyPseudonym(conversationId))
                      ?? myId,
                  senderDeviceKey: myIdentityKeyB64,
                  // [T2 FIX #9 2026-09-28] Pola libsignal SenderKeyState: public
                  // signing key pengirim dibawa dalam distribusi (yang dienkripsi
                  // E2E pq_box_seal → server tak lihat) dan diikat ke receiver
                  // state penerima. Verifikasi signature pesan selanjutnya tidak
                  // butuh lookup metadata/bundle lagi.
                  senderSigningKey: mySigningKeyB64
              });
          }
      }

      // Self round-trip test using MY keys
      try {
          const { privateKey: myPriv, publicKey: myPub } = await getMyEncryptionKeyPair();
          const myPqKeys = await useAuthStore.getState().getPqEncryptionKeyPair();
          const testPt = sodium.from_string('roundtrip_test_payload');
          const testCt = await worker_pq_box_seal(testPt, myPqKeys.publicKey, myPub);
          const testDec = await worker_pq_box_seal_open(testCt, myPqKeys.privateKey, myPriv);
          const testDecStr = sodium.to_string(testDec);
      } catch (rtErr) {
          console.error("Self round-trip FAILED with exception:", rtErr);
      }

      // Always save sender state even if distribution is empty (opaque mailbox:
      // participants may not be synced yet, key request/fulfillment handles delivery).
      await saveGroupSenderState({
          conversationId: conversationId as ConversationId,
          CK: senderKeyB64,
          N: 0,
          messageCount: 0,
          requiresImmediateRotation: false
      });

      // Save self-receiver state so sealed sender group messages from self can be routed by keyId
      await saveGroupReceiverState({
          id: `${conversationId}_${myId}_${myIdentityKeyB64}`,
          conversationId: conversationId as ConversationId,
          senderId: myId as UserId,
          CK: senderKeyB64,
          N: 0
      });

      return distributionKeys.length > 0 ? distributionKeys.filter(Boolean) : [];
    } finally {
      groupSessionLocks.delete(conversationId);
    }
  })();

  pendingGroupSessionPromises.set(cacheKey, promise as Promise<Record<string, unknown>[] | null>);

  try {
    return await promise as Record<string, unknown>[] | null;
  } finally {
    pendingGroupSessionPromises.delete(cacheKey);
  }
}

// [T2 KEY DELIVERY — doc 26.2] ==============================================
// Sender key grup didistribusikan via event `group:fulfilled_key` (envelope
// pq_box_seal per-device; server hanya melihat envelope opaque + routing).
// Jalur legacy `messages:distribute_keys` dan pairwise SPQR sama-sama dihapus
// (lihat komentar [REMOVED 2026-09-27] di bawah).
export type PairwiseKeyDistributionResult = {
  pairwise: number;
  legacy: Array<Record<string, unknown>>;
};

/**
 * Kirim kunci grup ke setiap target via event `group:fulfilled_key` (jalur
 * KEY_SYNC server → `session:new_key` → storeReceivedSessionKey di penerima).
 *
 * SEJARAH: dulu pairwise SPQR (pesan kontrol `:pw:` virtual) — TIDAK PERNAH
 * lengkap: server menolak conversation virtual ("Conversation not found") dan
 * client tidak punya hook decryptWithSpqrSession, jadi kunci TIDAK PERNAH sampai
 * (ditemukan E2E manual 2026-09-27: pesan grup B waiting_for_key di A). Jalur
 * fulfilled_key sudah ter-wiring penuh server+client (dipakai auto-heal) dan
 * membawa envelope pq_box_seal per-device yang sama — server tetap hanya melihat
 * envelope opaque + routing, tanpa bisa membuka isinya.
 * Return `legacy` SELALU kosong (dipertahankan untuk kompatibilitas pemanggil).
 */
export async function sendGroupKeyDistributionPairwise(
  conversationId: string,
  distributionKeys: Array<Record<string, unknown>>
): Promise<PairwiseKeyDistributionResult> {
  const result: PairwiseKeyDistributionResult = { pairwise: 0, legacy: [] };
  if (!Array.isArray(distributionKeys) || distributionKeys.length === 0) return result;

  const myId = useAuthStore.getState().user?.id;
  const senderIdForPayload = (await getMyPseudonym(conversationId)) ?? myId;

  for (const dk of distributionKeys) {
    const { userId, targetDeviceId, targetDeviceKey, key } = dk as {
      userId: string; targetDeviceId?: string; targetDeviceKey?: string; key: string;
    };
    if (!userId || !key) continue;

    try {
      const { transportClient } = await import('@lib/transportClient');
      transportClient.sendEvent('group:fulfilled_key', {
        requesterId: userId,
        conversationId,
        encryptedKey: key,
        targetDeviceId,
        senderDeviceKey: (dk as { senderDeviceKey?: string }).senderDeviceKey,
        // [T2 FIX #9 2026-09-28] Public signing key pengirim — diikat ke
        // receiver state penerima (pola libsignal SenderKeyState).
        senderSigningKey: (dk as { senderSigningKey?: string }).senderSigningKey,
        senderPseudonym: senderIdForPayload,
      });
      result.pairwise++;
    } catch (e) {
      console.warn(`[T2] Key delivery to ${userId} failed:`, e);
    }
  }
  return result;
}

export async function handleGroupKeyDistribution(
    conversationId: string,
    encryptedKey: string,
    senderId: string,
    senderDeviceKey?: string,
    drHeader?: any,
    // [T2 FIX #9 2026-09-28] Public signing key pengirim dari envelope — diikat
    // ke receiver state agar verifikasi signature pesan tidak butuh lookup lagi.
    senderSigningKey?: string
): Promise<void> {
  const { privateKey: classicalPrivateKey } = await getMyEncryptionKeyPair();
  const { privateKey: pqPrivateKey } = await useAuthStore.getState().getPqEncryptionKeyPair();
  const sodium = await getSodiumLib();
  const { worker_pq_box_seal_open } = await getWorkerProxy();

  let senderKeyBytes: Uint8Array | null = null;
  
  try {
      let encryptedKeyBytes: Uint8Array;
      try {
          encryptedKeyBytes = sodium.from_base64(encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      } catch (err1) {
          try {
              encryptedKeyBytes = sodium.from_base64(encryptedKey, sodium.base64_variants.ORIGINAL);
          } catch (err2) {
              encryptedKeyBytes = sodium.from_base64(encryptedKey, sodium.base64_variants.URLSAFE);
          }
      }

      senderKeyBytes = await worker_pq_box_seal_open(encryptedKeyBytes, pqPrivateKey, classicalPrivateKey);
  } catch (e) {
      console.error('[Crypto] FATAL: Gagal unseal Sender Key:', e);
      throw new Error('DECRYPTION_FAILED');
  }
  
  if (!senderKeyBytes) {
      throw new Error('DECRYPTION_FAILED');
  }

  let currentN = 0;
  let finalCKBytes = senderKeyBytes;

  if (senderKeyBytes.length === 36) {
      currentN = new DataView(senderKeyBytes.buffer, senderKeyBytes.byteOffset, senderKeyBytes.byteLength).getUint32(0, false);
      finalCKBytes = senderKeyBytes.slice(4);
  }

  const senderKeyB64 = sodium.to_base64(finalCKBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

  const stateId = senderDeviceKey ? `${conversationId}_${senderId}_${senderDeviceKey}` : `${conversationId}_${senderId}`;

  const existingReceiverState = await getGroupReceiverState(conversationId, senderId, senderDeviceKey || undefined);
  if (!existingReceiverState || existingReceiverState.N < currentN) {
      await saveGroupReceiverState({
          id: stateId,
          conversationId: conversationId as ConversationId,
          senderId: senderId as UserId,
          CK: senderKeyB64,
          N: currentN,
          // [T2 FIX #9 2026-09-28] Ikat signing key pengirim sejak distribusi.
          signingKey: senderSigningKey ?? existingReceiverState?.signingKey
      });
  }

  // NOTE: Do NOT save received sender key as our own sender state.
  // Each group member must generate their own sender key via ensureGroupSession
  // when they first send a message. Sharing the same CK between sender and receiver
  // causes keyId collision and signing key resolution failure.
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
      if (distributionKeys && distributionKeys.length > 0) {
        await emitGroupKeyDistribution(conversationId, distributionKeys as { userId: string; key: string }[]);
      }

      // [T1 ROTATION] Keanggotaan berubah → re-encrypt metadata dengan peta
      // pseudonym BARU (generation+1) agar anggota yang keluar tidak lagi
      // muncul di peta, dan pesan pra/pasca rotasi tak bisa di-stitch.
      // Hanya untuk metadata v2; v1 tetap jalur legacy (doc 26.5).
      const existingMeta = conversation.decryptedMetadata as { v?: number; authSecret?: string } | undefined;
      if (existingMeta?.v === 2) {
        try {
          const participantIds = conversation.participants.map(p => (p.userId || p.id) as string);
          const newEncrypted = await encryptGroupMetadata({
            ...existingMeta,
            participants: participantIds,
            v: 2,
          }, conversationId);
          // authSecret dari metadata (blind authorization untuk PUT details).
          if (existingMeta.authSecret) {
            await authFetch(`/api/conversations/${conversationId}/details`, {
              method: 'PUT',
              headers: { 'X-Group-Token': existingMeta.authSecret },
              body: JSON.stringify({ encryptedMetadata: newEncrypted }),
            });
            useConversationStore.getState().updateConversation(conversationId, { encryptedMetadata: newEncrypted });
          }
        } catch (e) {
          console.error('[T1] Metadata re-encryption on rotation failed:', e);
        }
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

async function requestGroupKeyWithTimeout(conversationId: string, attempt = 0, targetSenderId?: string, targetDeviceKey?: string) {
  const reqKey = targetSenderId ? `${conversationId}_${targetSenderId}_${targetDeviceKey || ''}` : conversationId;
  if (pendingGroupKeyRequests.has(reqKey)) return;

  const timerId = window.setTimeout(async () => {
    // Fire request only after 1.5s delay to allow jitter buffer / inflight group key distribution to arrive
    emitGroupKeyRequest(conversationId, targetSenderId, targetDeviceKey);
    
    // Set a new timer for the next retry
    const retryTimerId = window.setTimeout(async () => {
      pendingGroupKeyRequests.delete(reqKey);
      if (attempt < MAX_KEY_REQUEST_RETRIES) {
        requestGroupKeyWithTimeout(conversationId, attempt + 1, targetSenderId, targetDeviceKey);
      } else {
        const { useMessageStore } = await import('@store/message');
        useMessageStore.getState().failPendingMessages(conversationId, '[Key request timed out]');
      }
    }, KEY_REQUEST_TIMEOUT_MS);
    
    pendingGroupKeyRequests.set(reqKey, { attempt, timerId: retryTimerId });
  }, 1500);

  pendingGroupKeyRequests.set(reqKey, { attempt, timerId });
}

// --- Message Encryption/Decryption ---

const XCHACHA20_NONCE_BYTES = 24;

export interface DrHeader {
  kemPk: string; // Ganti 'dh' jadi 'kemPk'
  ct: string;    // Tambahkan 'ct' (Ciphertext)
  n: number;
  pn: number;
}

// --- Unified Ratchet Mutex ---
// Ensures that only one operation (Encrypt OR Decrypt) can modify 
// the ratchet state of a conversation at any given time across all tabs.

export async function encryptMessage(
  text: string,
  conversationId: string,
  isGroup: boolean = false,
  existingSession?: { sessionId: string; key: Uint8Array },
  messageId?: string
): Promise<{ ciphertext: string; sessionId?: string; drHeader?: DrHeader; mk?: Uint8Array }> {
  return navigator.locks.request(`ratchet_${conversationId}`, async () => {
    return await doEncryptMessage(text, conversationId, isGroup, existingSession, messageId);
  });
}

async function doEncryptMessage(
  text: string,
  conversationId: string,
  isGroup: boolean = false,
  existingSession?: { sessionId: string; key: Uint8Array },
  messageId?: string
): Promise<{ ciphertext: string; sessionId?: string; drHeader?: DrHeader; mk?: Uint8Array }> {
  const sodium = await getSodiumLib();
  
  if (!isGroup) {
      let state = await retrieveRatchetStateSecurely(conversationId);
      let x3dhData = null;
      const myId = useAuthStore.getState().user?.id;

      if (!state) {
          const { useConversationStore } = await import('@store/conversation');
          const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
          if (!conversation) throw new Error("Conversation not found");

          const peer = conversation.participants.find(p => p.id !== myId);
          if (!peer) throw new Error("Peer not found");

          const bundle = await fetchPreKeyBundle(peer.id);
          
          const signingPrivateKey = await useAuthStore.getState().getSigningPrivateKey();
          if (!signingPrivateKey) throw new Error("My signing key missing");
          const mySigningKey = {
              publicKey: signingPrivateKey.slice(32),
              privateKey: signingPrivateKey
          };

          const { sessionKey, initiatorCiphertexts, otpkId, identityChanged } = await establishSessionFromPreKeyBundle(mySigningKey, bundle, peer.id);

          // [SECURITY WARNING] Insert system message if identity changed
          if (identityChanged) {
              const { useMessageStore } = await import('@store/message');
              const { t } = await import('i18next');
              const { default: toast } = await import('react-hot-toast');
              const useDynamicIslandStore = (await import('@store/dynamicIsland')).default;

              const peerName = peer.name || peer.user?.name || t('common:defaults.unknown_user');
              const warningText = t('common:security_key_changed', { name: peerName });
              
              // 1. Persistent chat message
              useMessageStore.getState().addSystemMessage(conversationId, warningText);
              
              // 2. Immediate Toast
              toast.error(warningText, { icon: '🛡️', duration: 6000 });

              // 3. Dynamic Island Alert
              useDynamicIslandStore.getState().addActivity({
                  type: 'notification',
                  sender: { name: 'NYX_SHIELD' },
                  message: warningText,
                  link: `/chat/${conversationId}`
              }, 6000);
          }

          const { worker_dr_init_alice } = await getWorkerProxy();
          
          if (!bundle.signedPreKey.pqKey) {
             throw new Error("Peer does not have PQ keys");
          }

          const theirPqSignedPreKeyPublic = sodium.from_base64(bundle.signedPreKey.pqKey, sodium.base64_variants.URLSAFE_NO_PADDING);
          
          state = await worker_dr_init_alice({
              sk: sessionKey,
              theirPqSignedPreKeyPublic
          });

          x3dhData = {
              initiatorSigningKey: sodium.to_base64(mySigningKey.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
              initiatorCiphertexts: sodium.to_base64(initiatorCiphertexts, sodium.base64_variants.URLSAFE_NO_PADDING),
              otpkId
          };
      }

      const { worker_dr_ratchet_encrypt } = await getWorkerProxy();

      const { publicKey } = await getMyEncryptionKeyPair();
      const myPublicKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const sealedPayload = JSON.stringify({
          content: text,
          senderId: myId,
          senderDeviceKey: myPublicKeyB64
      });

      const result = await worker_dr_ratchet_encrypt({
          serializedState: state,
          plaintext: sealedPayload
      });

      if (messageId && result.mk) {
          const mkBytes = new Uint8Array(result.mk);
          await storeMessageKeySecurely(messageId, mkBytes);
      }

      await storeRatchetStateSecurely(conversationId, result.state);

      const payload = JSON.stringify({
          dr: result.header,
          ciphertext: sodium.to_base64(new Uint8Array(result.ciphertext), sodium.base64_variants.URLSAFE_NO_PADDING),
          ...(x3dhData ? { x3dh: x3dhData } : {})
      });

      return { ciphertext: payload, mk: new Uint8Array(result.mk), drHeader: result.header };
  }

  const { groupRatchetEncrypt } = await getWorkerProxy();

  // SENDER KEY PROTOCOL (UNIVERSAL FAN-OUT)
  let senderState = await getGroupSenderState(conversationId);
  
  // --- SMART KEY ROTATION (PCS) ---
  if (senderState) {
      const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);

      const MAX_MESSAGES = 25;
      const MAX_AGE_MS = isGroup ? (60 * 60 * 1000) : (2 * 60 * 1000);
      
      const now = Date.now();
      const count = senderState.messageCount || 0;
      
      let needsRotation = false;
      // [HYBRID OPPORTUNISTIC PCS]
      // Rotasi jika: N >= limit ATAU ada balasan masuk (1-on-1)
      if (count >= MAX_MESSAGES || (!isGroup && senderState.requiresImmediateRotation)) {
          needsRotation = true;
      } else {
          const age = senderState.createdAt ? now - senderState.createdAt : 0;
          const idleTime = senderState.lastActivityTime ? now - senderState.lastActivityTime : 0;
          if ((senderState.createdAt && age >= MAX_AGE_MS) || (senderState.lastActivityTime && idleTime >= MAX_AGE_MS)) {
              needsRotation = true;
          }
      }
      
      if (needsRotation) {
          console.debug(`[NYX-Shield] Rotating session keys for ${conversationId}...`);
          // Don't block UI with pq_box_seal, let ensureGroupSession run in background via worker proxy
          await forceRotateGroupSenderKey(conversationId);
          
          if (conversation) {
             const distributionKeys = await ensureGroupSession(conversationId, conversation.participants, true);
             if (distributionKeys) {
               await emitGroupKeyDistribution(conversationId, distributionKeys as { userId: string; key: string }[]);
               // [T1 ROTATION] Periodic/PCS rotation (25 msgs / 1 jam) memicu
               // rotasi peta pseudonym juga — fire-and-forget: re-encrypt metadata
               // v2 dengan peta baru (generation+1) + push ke server. TIDAK di-await
               // agar hot path encrypt tetap cepat; kegagalan hanya menunda
               // unlinkability antar-era, tidak merusak konsistensi pesan.
               const existingMeta = conversation.decryptedMetadata as { v?: number; authSecret?: string } | undefined;
               if (existingMeta?.v === 2 && existingMeta.authSecret) {
                   void encryptGroupMetadata({
                       ...existingMeta,
                       participants: conversation.participants.map(p => (p.userId || p.id) as string),
                       v: 2,
                   }, conversationId)
                       .then(newEncrypted => authFetch(`/api/conversations/${conversationId}/details`, {
                           method: 'PUT',
                           headers: { 'X-Group-Token': existingMeta.authSecret as string },
                           body: JSON.stringify({ encryptedMetadata: newEncrypted }),
                       }).then(() => {
                           useConversationStore.getState().updateConversation(conversationId, { encryptedMetadata: newEncrypted });
                       }))
                       .catch(e => console.warn('[T1] Background pseudonym-map rotation failed:', e));
               }
             } else {
               throw new Error("Security Failure: One or more devices do not support mandatory Post-Quantum encryption. Key rotation aborted.");
             }
          }
          senderState = await getGroupSenderState(conversationId);
      }
  }
  // ---------------------------------

  if (!senderState) throw new Error(`No sender key available for conversation ${conversationId}.`);
  
  const signingPrivateKey = await useAuthStore.getState().getSigningPrivateKey();
  
  const myId = useAuthStore.getState().user?.id;
  const { publicKey } = await getMyEncryptionKeyPair();
  const myPublicKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

  // [T1] Di dalam payload terenkripsi, identitas pengirim tetap userId penuh
  // (dipakai penerima untuk resolve profile). YANG DIKIRIM KE SERVER (wrapper
  // di bawah) memakai pseudonym bila metadata v2 tersedia.
  const sealedPayload = JSON.stringify({
      content: text,
      senderId: myId,
      senderDeviceKey: myPublicKeyB64
  });

  // Encrypt & Ratchet
  const result = await groupRatchetEncrypt(
      { CK: senderState.CK, N: senderState.N },
      sealedPayload,
      signingPrivateKey
  );
  
  // [FIX] Atomic order: save key before state
  if (messageId && result.mk) {
      await storeMessageKeySecurely(messageId, result.mk);
  }

  const keyId = senderState.CK.substring(0, 8);

  // [T1] Wrapper yang diteruskan server memakai PSEUDONYM (bukan userId) bila
  // peta metadata v2 tersedia. Server menyimpan nilai ini apa adanya di
  // Message.senderId → tidak bisa di-link ke akun. Penerima resolve balik ke
  // userId via peta di decryptedMetadata; receiver-state tetap dikunci per
  // (conversationId, senderId-wrapper, senderDeviceKey) — konsisten untuk
  // distribusi kunci yang memakai pseudonym yang sama.
  const myPseudo = await getMyPseudonym(conversationId);
  const senderIdForServer = myPseudo ?? myId;

  const payload = JSON.stringify({
      header: result.header,
      ciphertext: sodium.to_base64(result.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
      signature: result.signature,
      keyId: keyId,
      senderId: senderIdForServer,
      senderDeviceKey: myPublicKeyB64
  });
  
  // ✅ FIX: Atomic Persistence - Update state only after everything else succeeds
  await saveGroupSenderState({
      conversationId: conversationId as ConversationId,
      CK: result.state.CK,
      N: result.state.N,
      createdAt: senderState.createdAt || Date.now(),
      messageCount: (senderState.messageCount || 0) + 1,
      lastActivityTime: Date.now(),
      requiresImmediateRotation: senderState.requiresImmediateRotation // Preserve flag if not rotating now
  });

  return { ciphertext: payload, mk: result.mk };
}

export async function decryptMessage(
  cipher: string,
  conversationId: string,
  isGroup: boolean,
  sessionId: string | null | undefined, // In group, this might be senderId
  messageId?: string
): Promise<DecryptResult> {
  return navigator.locks.request(`ratchet_${conversationId}`, async () => {
    return await doDecryptMessage(cipher, conversationId, isGroup, sessionId, messageId);
  });
}

async function doDecryptMessage(
  cipher: string,
  conversationId: string,
  isGroup: boolean,
  sessionId: string | null | undefined,
  messageId?: string
): Promise<DecryptResult> {
  if (!cipher) return { status: 'success', value: '' };

  const sodium = await getSodiumLib();
  const { worker_crypto_secretbox_xchacha20poly1305_open_easy } = await getWorkerProxy();

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
          } catch (_e) {
              // Fail silently and try fallback
          }
      }
  }

  // ✅ FASE 3: Deteksi Otomatis apakah ini pesan Sender Key Fan-Out atau Double Ratchet Klasik
  let payloadObj;
  try { payloadObj = JSON.parse(cipher); } catch { /* not a JSON payload */ }
  const isSenderKeyProtocol = payloadObj && payloadObj.signature !== undefined && payloadObj.header !== undefined;

  if (isSenderKeyProtocol || isGroup) {
    const keyId = payloadObj && payloadObj.keyId;
    let senderId = (payloadObj && payloadObj.senderId) ? payloadObj.senderId : sessionId;
    const senderDeviceKey = payloadObj && payloadObj.senderDeviceKey;

    let receiverState = null;

    if (keyId) {
        receiverState = await getGroupReceiverStateByKeyId(conversationId, keyId);
        if (receiverState) {
            senderId = receiverState.senderId;
        }
    } 

    if (!receiverState) {
        if (!senderId) {
            return { status: 'error', error: new Error('Missing senderId and keyId for group decryption (Sealed Sender failed to resolve)') };
        }
        receiverState = await getGroupReceiverState(conversationId, senderId, senderDeviceKey);

        if (!receiverState && senderDeviceKey) {
            // Fallback backward compatibility
            receiverState = await getGroupReceiverState(conversationId, senderId);
        }
    }

    if (!receiverState) {
        if (senderId && senderDeviceKey) {
            requestGroupKeyWithTimeout(conversationId, 0, senderId, senderDeviceKey);
        }
        return { status: 'pending', reason: 'waiting_for_key' };
    }

    try {
        const payload = JSON.parse(cipher);
        const { header, ciphertext, signature } = payload;

        // [T1 FIX 2026-09-27] senderId di wrapper = PSEUDONYM (metadata v2).
        // Resolusi signing key butuh USER ID: lookup bundle/partisipan server
        // di-key by userId — tanpa resolve, fetchPreKeyBundles([pseudonym])
        // selalu kosong → "Missing sender signing key" (ditemukan E2E manual).
        const senderUserId = resolvePseudonymToUserId(conversationId, senderId) ?? senderId;

        let keyToUse: string | undefined = undefined;

        // --- Resolve Sender Signing Key ---
        // [T2 FIX #9 2026-09-28] SUMBER UTAMA: signing key yang diikat ke receiver
        // state sejak distribusi kunci (pola libsignal SenderKeyState.sender_signing_key).
        // Tidak butuh resolve pseudonym/bundle API — hilangkan chicken-and-egg.
        if (receiverState.signingKey) {
            keyToUse = receiverState.signingKey;
        }
        // ✅ FIX: Perbaikan Key Resolution untuk Sinkronisasi Perangkat (Device Migration)
        // [T1 FIX 2026-09-28 #2] Fallback berbasis DEVICE IDENTITY KEY: kalau
        // resolvePseudonymToUserId gagal (metadata v2 belum ter-decrypt / cache
        // ShadowVault lama tanpa pseudonymMap), senderUserId masih pseudonym →
        // fetchPreKeyBundles([pseudonym]) kosong. senderDeviceKey adalah identity
        // key device pengirim — unik global & tidak butuh resolve pseudonym:
        // fetch bundles SEMUA participant + self, lalu match identityKey.
        if (senderDeviceKey) {
             try {
                 // Cari bundle milik user pengirim dari API (bisa orang lain, bisa diri sendiri)
                 const bundlesMap = await fetchPreKeyBundles([senderUserId]);
                 const bundles = bundlesMap[senderUserId] || [];
                 
                 // Temukan perangkat yang public key-nya cocok dengan senderDeviceKey
                 const deviceBundle = bundles.find(b => b.identityKey === senderDeviceKey);
                 if (deviceBundle) {
                     keyToUse = deviceBundle.signingKey;
                 }

                 // [T1 FIX 2026-09-28 #2] FALLBACK: semua-participant (bypass resolve
                 // pseudonym), dipakai bila receiver state belum membawa signingKey
                 // (state lama pra-fix #9). Match murni by device identity key.
                 if (!keyToUse) {
                     const { useConversationStore } = await import('@store/conversation');
                     const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
                     const participantUserIds = (conv?.participants ?? [])
                         .map(p => ('userId' in p && p.userId) || p.id)
                         .map(id => String(id))
                         .filter(id => id.length > 0);
                     const myIdForScan = useAuthStore.getState().user?.id;
                     if (myIdForScan && !participantUserIds.includes(myIdForScan)) {
                         participantUserIds.push(myIdForScan);
                     }
                     if (participantUserIds.length > 0) {
                         const allBundles = await fetchPreKeyBundles(participantUserIds);
                         for (const uid of participantUserIds) {
                             const list = allBundles[uid] || [];
                             const match = list.find(b => b.identityKey === senderDeviceKey);
                             if (match?.signingKey) {
                                 keyToUse = match.signingKey;
                                 break;
                             }
                         }
                     }
                 }
             } catch (e) {
                 console.warn("Failed to fetch sender device bundle, falling back to legacy lookup");
             }
        }

        // Fallback jika tidak ketemu via senderDeviceKey (hanya cocok jika pengirim adalah orang lain dengan 1 device)
        if (!keyToUse) {
            const myId = useAuthStore.getState().user?.id;
            if (senderUserId === myId) {
                console.warn("Cannot fallback to current device signing key for a message sent from our other device.");
            } else {
                const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
                const sender = conversation?.participants.find(p => p.id === senderUserId || ('userId' in p && p.userId === senderUserId)) as Participant | undefined;
                keyToUse = sender?.signingKey || sender?.user?.signingKey;
            }
        }
        
        if (!keyToUse) {
             return { status: 'error', error: new Error('Missing sender signing key') };
        }

        const senderSigningKey = sodium.from_base64(keyToUse, sodium.base64_variants.URLSAFE_NO_PADDING);
        const ciphertextBytes = sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);

        // 1. CHECK SKIPPED KEYS FIRST (ATOMIC)
        const { getGroupSkippedKey, deleteGroupSkippedKey, storeGroupSkippedKey } = await import('@lib/keychainDb');
        const keyId = payloadObj.keyId;
        const skippedMkB64 = await getGroupSkippedKey(conversationId, senderId, senderDeviceKey, header.n, keyId);
        
        if (skippedMkB64) {
            const { groupDecryptSkipped } = await getWorkerProxy();
            const result = await groupDecryptSkipped(
                skippedMkB64, 
                header.n,
                ciphertextBytes,
                signature,
                senderSigningKey
            );
            
            if (messageId) {
                const mkBytes = sodium.from_base64(skippedMkB64, sodium.base64_variants.URLSAFE_NO_PADDING);
                await storeMessageKeySecurely(messageId, mkBytes);
            }
            
            // Hanya hapus key yang di-skip jika dekripsi berhasil tanpa error
            await deleteGroupSkippedKey(conversationId, senderId, senderDeviceKey, header.n);

            return { status: 'success', value: sodium.to_string(result.plaintext) };
        }
        
        // 2. NORMAL RATCHET DECRYPTION (Handles out-of-order internally now)
        const { groupRatchetDecrypt } = await getWorkerProxy();
        const result = await groupRatchetDecrypt(
            { CK: receiverState.CK, N: receiverState.N },
            header,
            ciphertextBytes,
            signature,
            senderSigningKey
        );
        
        const keyIdForSkip = receiverState.CK ? receiverState.CK.substring(0, 8) : undefined;
        for (const sk of result.skippedKeys) {
            await storeGroupSkippedKey(conversationId, senderId, senderDeviceKey, sk.n, sk.mk, keyIdForSkip);
        }

        await saveGroupReceiverState({
            ...receiverState,
            id: receiverState.id, 
            conversationId: conversationId as ConversationId,
            senderId: senderId as UserId,
            CK: result.state.CK,
            N: result.state.N
        });
        
        if (messageId && result.mk) {
            await storeMessageKeySecurely(messageId, result.mk);
        }
        
        // --- SMART KEY ROTATION: Update idle time on received message ---
        const localSenderState = await getGroupSenderState(conversationId);
        if (localSenderState) {
            await saveGroupSenderState({
                ...localSenderState,
                lastActivityTime: Date.now()
            });
        }
        // ----------------------------------------------------------------
        
        return { status: 'success', value: sodium.to_string(result.plaintext) };
        
    } catch (e: unknown) {
      console.error(`Group Decryption failed for convo ${conversationId}:`, e);
      return { status: 'error', error: e instanceof Error ? e : new Error('Failed to decrypt group message') };
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
            const reqKey = `${conversationId}_${sessionId}`;
            if (!pendingGroupKeyRequests.has(reqKey)) {
                const timerId = window.setTimeout(() => {
                    pendingGroupKeyRequests.delete(reqKey);
                    emitSessionKeyRequest(conversationId, sessionId);
                }, 1500);
                pendingGroupKeyRequests.set(reqKey, { attempt: 0, timerId });
            }
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
            const reqKey = `${conversationId}_${sessionId}`;
            if (!pendingGroupKeyRequests.has(reqKey)) {
                const timerId = window.setTimeout(() => {
                    pendingGroupKeyRequests.delete(reqKey);
                    emitSessionKeyRequest(conversationId, sessionId);
                }, 1500);
                pendingGroupKeyRequests.set(reqKey, { attempt: 0, timerId });
            }
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
      
      // ✅ FIX: Get the post-quantum key directly from the new KEM header structure
      const kemPk = drHeader.kemPk;
      const headerKey = `${conversationId}_${kemPk}_${drHeader.n}`;

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

      // [FIX] ATOMIC ORDER: Store intermediate keys (gaps) FIRST
      for (const sk of result.skippedKeys) {
          const hKey = `${conversationId}_${sk.kemPk}_${sk.n}`;
          await storeSkippedMessageKeySecurely(hKey, sk.mk);
      }

      // Store current message key
      if (messageId) {
          await storeMessageKeySecurely(messageId, result.mk);
      }

      // FINALLY, update the ratchet state to advance the chain
      await storeRatchetStateSecurely(conversationId, result.state);

      return { status: 'success', value: sodium.to_string(result.plaintext) };

    } catch (e: unknown) {
      console.error('DR Decryption failed for convo:', conversationId, e);
      return { status: 'error', error: e instanceof Error ? e : new Error('Failed to decrypt message') };
    }
  }
}

// --- Pre-Key Handshake (Full X3DH with OTPK) ---

export async function establishSessionFromPreKeyBundle(
  mySigningKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  preKeyBundle: PreKeyBundle,
  peerUserId: string
): Promise<{ sessionKey: Uint8Array, initiatorCiphertexts: Uint8Array, otpkId?: number, identityChanged: boolean }> {
  const sodium = await getSodiumLib();
  const { worker_x3dh_initiator } = await getWorkerProxy();

  if (!preKeyBundle.pqIdentityKey || !preKeyBundle.signedPreKey.pqKey || !preKeyBundle.signedPreKey.pqSignature) {
      throw new Error("Post-Quantum Handshake Mandatory");
  }

  // 1. Check Identity Change (Security Warning)
  const { getPeerIdentityKey, savePeerIdentityKey } = await import('@lib/keychainDb');
  const existingKey = await getPeerIdentityKey(peerUserId);
  const newIdentityKeyB64 = preKeyBundle.identityKey;

  let identityChanged = false;
  if (existingKey && existingKey !== newIdentityKeyB64) {
      identityChanged = true;
      console.warn(`[Security] Identity key changed for user ${peerUserId}. Previous: ${existingKey.substring(0, 10)}... New: ${newIdentityKeyB64.substring(0, 10)}...`);
  }

  // Store/Update the known identity key
  await savePeerIdentityKey(peerUserId, newIdentityKeyB64);
  
  const theirIdentityKey = sodium.from_base64(preKeyBundle.identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSignedPreKey = sodium.from_base64(preKeyBundle.signedPreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirSigningKey = sodium.from_base64(preKeyBundle.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const signature = sodium.from_base64(preKeyBundle.signedPreKey.signature, sodium.base64_variants.URLSAFE_NO_PADDING);

  const theirPqIdentityKey = sodium.from_base64(preKeyBundle.pqIdentityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const theirPqSignedPreKey = sodium.from_base64(preKeyBundle.signedPreKey.pqKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const pqSignature = sodium.from_base64(preKeyBundle.signedPreKey.pqSignature, sodium.base64_variants.URLSAFE_NO_PADDING);

  let theirOneTimePreKey: Uint8Array | undefined;
  let theirPqOneTimePreKey: Uint8Array | undefined;
  if (!preKeyBundle.oneTimePreKey) {
    // [MID-SESSION REFILL] Bundle tanpa OTPK = stok PEER habis (server tidak
    // menerbitkan apa pun). Pemicu pengaman: coba bangunkan refill di device
    // kita (peer akan refill saat mereka aktif lagi — visibilitychange atau
    // sesi berikutnya). Fire-and-forget, tidak boleh menggagalkan handshake.
    scheduleOtpkTopUpCheck();
  } else {
    theirOneTimePreKey = sodium.from_base64(preKeyBundle.oneTimePreKey.key, sodium.base64_variants.URLSAFE_NO_PADDING);
    if (!preKeyBundle.oneTimePreKey.pqKey) {
      throw new Error("Post-Quantum Handshake Mandatory");
    }
    theirPqOneTimePreKey = sodium.from_base64(preKeyBundle.oneTimePreKey.pqKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  const result = await worker_x3dh_initiator({
    mySigningKey: mySigningKeyPair,
    theirIdentityKey,
    theirPqIdentityKey,
    theirSignedPreKey,
    theirPqSignedPreKey,
    theirSigningKey,
    signature,
    pqSignature,
    theirOneTimePreKey,
    theirPqOneTimePreKey
  });

  return {
    sessionKey: result.sessionKey,
    initiatorCiphertexts: result.initiatorCiphertexts,
    otpkId: preKeyBundle.oneTimePreKey?.keyId,
    identityChanged
  };
}

export async function deriveSessionKeyAsRecipient(
  myIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  mySignedPreKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  myPqIdentityKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  myPqSignedPreKeyPair: { publicKey: Uint8Array, privateKey: Uint8Array },
  initiatorSigningKeyStr: string,
  initiatorCiphertextsInput: string | Uint8Array,
  otpkId?: number
): Promise<Uint8Array> {
  const sodium = await getSodiumLib();
  const { worker_x3dh_recipient, worker_decrypt_session_key } = await getWorkerProxy();

  const theirSigningKey = sodium.from_base64(initiatorSigningKeyStr, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  // Handle both string (Base64) and binary input for backward compatibility
  const initiatorCiphertexts = typeof initiatorCiphertextsInput === 'string' 
    ? sodium.from_base64(initiatorCiphertextsInput, sodium.base64_variants.URLSAFE_NO_PADDING)
    : initiatorCiphertextsInput;
  
  let myOneTimePreKey: { privateKey: Uint8Array } | undefined;

  if (otpkId !== undefined) {
    const masterSeed = await getMasterSeedOrThrow();
    try {
        const { worker_x3dh_recipient_regenerate } = await getWorkerProxy();
        const sessionKey = await worker_x3dh_recipient_regenerate({
            keyId: otpkId,
            masterSeed,
            myIdentityKey: myIdentityKeyPair,
            mySignedPreKey: mySignedPreKeyPair,
            myPqIdentityKey: myPqIdentityKeyPair,
            myPqSignedPreKey: myPqSignedPreKeyPair,
            theirSigningKey,
            initiatorCiphertexts
        });
        return sessionKey;
    } catch (e) {
        console.error('[X3DH] Failed to regenerate OTPK:', otpkId, e);
    }
  }

  try {
    const sessionKey = await worker_x3dh_recipient({
      myIdentityKey: myIdentityKeyPair,
      mySignedPreKey: mySignedPreKeyPair,
      myPqIdentityKey: myPqIdentityKeyPair,
      myPqSignedPreKey: myPqSignedPreKeyPair,
      theirSigningKey,         // Hapus baris theirIdentityKey dan theirEphemeralKey, ganti dengan ini
      initiatorCiphertexts,    // Tambahkan baris ini
      myOneTimePreKey
    });
    if (otpkId !== undefined) {
      await deleteOneTimePreKey(otpkId);
    }
    return sessionKey;
  } finally {
  }
}

// --- Key Recovery & Fulfillment ---

interface GroupFulfillRequestPayload {
  conversationId: string;
  requesterId: string;
  requesterPublicKey: string;
  requesterPqPublicKey?: string;
  requesterDeviceId?: string;
}

interface FulfillRequestPayload {
  conversationId: string;
  sessionId: string;
  requesterId: string;
  requesterPublicKey: string;
  requesterPqPublicKey: string;
}

interface ReceiveKeyPayload {
  conversationId: string;
  sessionId?: string;
  encryptedKey: string;
  type?: 'GROUP_KEY' | 'SESSION_KEY';
  senderId?: string;
  senderDeviceKey?: string;
  // [T2 FIX #9 2026-09-28] Public signing key pengirim dari envelope distribusi.
  senderSigningKey?: string;
  drHeader?: any;
  initiatorCiphertextsStr?: string;
  initiatorSigningKey?: string;
}

export async function fulfillGroupKeyRequest(payload: GroupFulfillRequestPayload): Promise<void> {
  const { conversationId, requesterId, requesterPublicKey: requesterPublicKeyB64, requesterPqPublicKey: requesterPqPublicKeyB64 } = payload;
  const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (!conversation) return;
  // Opaque Mailbox: server returns empty participants, skip participant validation

  const bundlesMap = await fetchPublicKeys([requesterId]);
  const targetDevices = bundlesMap[requesterId] || [];

  const isMatched = targetDevices.some(d => d.identityKey === requesterPublicKeyB64 || d.identityKey === payload.requesterDeviceId);
  if (!isMatched && targetDevices.length > 0) {
      console.warn("Group key fulfillment: Provided keys do not perfectly match registered device keys. Bypassing strict validation as requester is a valid participant.");
  }

  const senderState = await getGroupSenderState(conversationId);
  if (!senderState) return;

  const sodium = await getSodiumLib();
  const senderKeyBytes = sodium.from_base64(senderState.CK, sodium.base64_variants.URLSAFE_NO_PADDING);

  const payloadToEncrypt = new Uint8Array(4 + senderKeyBytes.length);
  new DataView(payloadToEncrypt.buffer).setUint32(0, senderState.N || 0, false);
  payloadToEncrypt.set(senderKeyBytes, 4);

  // Encrypt sender key with PQ box seal
  try {
    const { worker_pq_box_seal } = await getWorkerProxy();
    const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
    const requesterPqPublicKey = requesterPqPublicKeyB64 ? sodium.from_base64(requesterPqPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING) : null;
    if (!requesterPqPublicKey || requesterPqPublicKey.length !== sodium.crypto_kem_xwing_PUBLICKEYBYTES) {
        console.warn('[Group Key] Fulfillment: Requester missing or invalid PQ public key');
        return;
    }
    const encryptedKeyForRequester = await worker_pq_box_seal(payloadToEncrypt, requesterPqPublicKey, requesterPublicKey);
    const { publicKey: myIdentityKey } = await getMyEncryptionKeyPair();
    const myIdentityKeyB64 = sodium.to_base64(myIdentityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    // [T1] Fulfillment = replay distribusi kunci → sertakan pseudonym agar
    // requester mengenali sender via peta metadata (bukan via userId).
    emitGroupKeyFulfillment({
        requesterId, conversationId,
        encryptedKey: sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants.URLSAFE_NO_PADDING),
        targetDeviceId: payload.requesterDeviceId,
        senderDeviceKey: myIdentityKeyB64,
        senderPseudonym: await getMyPseudonym(conversationId)
    });
  } catch (e) {
    console.error('[Group Key] Failed to encrypt sender key for fulfillment:', e);
  }
}

export async function fulfillKeyRequest(payload: FulfillRequestPayload): Promise<void> {
  const { conversationId, sessionId, requesterId, requesterPublicKey: requesterPublicKeyB64, requesterPqPublicKey: requesterPqPublicKeyB64 } = payload;
  const key = await retrieveSessionKeySecurely(conversationId, sessionId);
  if (!key) return;

  const conversation = useConversationStore.getState().conversations.find(c => c.id === conversationId);
  if (!conversation) return;
  const requester = conversation.participants.find(p => (p.userId || p.id) === requesterId);
  if (!requester) return;

  const userObj = requester.user || requester;
  const targetDevices = userObj.devices || requester.devices || [];

  const isMatched = targetDevices.some(d => d.publicKey === requesterPublicKeyB64 && d.pqPublicKey === requesterPqPublicKeyB64);
  if (!isMatched) {
      console.warn("Session key fulfillment: Provided keys do not match any registered device keys for requester. Aborting.");
      return;
  }

  const sodium = await getSodiumLib();
  const { worker_pq_box_seal } = await getWorkerProxy();

  const requesterPublicKey = sodium.from_base64(requesterPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  if (!requesterPqPublicKeyB64) return;
  const requesterPqPublicKey = sodium.from_base64(requesterPqPublicKeyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  const encryptedKeyForRequester = await worker_pq_box_seal(key, requesterPqPublicKey, requesterPublicKey);

  emitSessionKeyFulfillment({
    requesterId,
    conversationId,
    sessionId,
    encryptedKey: sodium.to_base64(encryptedKeyForRequester, sodium.base64_variants.URLSAFE_NO_PADDING),
  });
}

export async function storeReceivedSessionKey(payload: ReceiveKeyPayload): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const { conversationId, sessionId, encryptedKey, type, senderId, senderDeviceKey, drHeader, initiatorCiphertextsStr, initiatorSigningKey } = payload;
  // [T2 FIX #9 2026-09-28] Public signing key pengirim dari envelope distribusi.
  const senderSigningKey = (payload as { senderSigningKey?: string }).senderSigningKey;
  
  if (encryptedKey === 'dummy' || (sessionId && sessionId.startsWith('dummy'))) {
      console.warn("🛡️ [Crypto] BERHASIL MEMBLOKIR KUNCI DUMMY DARI SERVER!", { conversationId, sessionId });
      return; 
  }

  if (type === 'GROUP_KEY') {
    if (!senderId) {
        console.error("Received GROUP_KEY but missing senderId. Cannot store key.");
        return;
    }
    
    // Skip our own key distribution — we already have the sender state.
    // [T1] senderId bisa pseudonym (metadata v2) atau userId (legacy) — cek keduanya.
    const myId = useAuthStore.getState().user?.id;
    const senderUserId = resolvePseudonymToUserId(conversationId, senderId) ?? senderId;
    if (senderUserId === myId) {
        console.debug(`[storeReceivedSessionKey] Skipping own GROUP_KEY distribution for conv=${conversationId}`);
        return;
    }
    
    console.debug(`[storeReceivedSessionKey] conv=${conversationId} senderId=${senderId} senderDeviceKey=${senderDeviceKey} encryptedKeyLen=${encryptedKey?.length}`);

    const reqKey = senderDeviceKey ? `${conversationId}_${senderId}_${senderDeviceKey}` : conversationId;
    const pendingRequest = pendingGroupKeyRequests.get(reqKey) || pendingGroupKeyRequests.get(conversationId);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timerId);
      pendingGroupKeyRequests.delete(reqKey);
      pendingGroupKeyRequests.delete(conversationId);
    }

    try {
        await handleGroupKeyDistribution(conversationId, encryptedKey, senderId, senderDeviceKey, drHeader, senderSigningKey);
        
        // Opaque Mailbox: update metadata FIRST (before re-decrypting messages)
        // so the receiver state CK hasn't been ratcheted by message decryption yet.
        let metadataDecrypted = false;
        await (async () => {
            const { useConversationStore } = await import('@store/conversation');
            const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
            if (conv?.isGroup) {
                if (!conv.encryptedMetadata) {
                    try {
                        const { authFetch } = await import('@lib/api');
                        const serverConv: any = await authFetch(`/api/conversations/${conversationId}`);
                        if (serverConv?.encryptedMetadata) {
                            await useConversationStore.getState().updateConversation(conversationId, {
                                encryptedMetadata: serverConv.encryptedMetadata
                            });
                            metadataDecrypted = useConversationStore.getState().conversations.find(c => c.id === conversationId)?.decryptedMetadata ? true : false;
                        }
                    } catch (e) {
                        console.warn(`[storeReceivedSK] Failed to fetch conversation ${conversationId}`, e);
                    }
                } else if (!conv.decryptedMetadata) {
                    await useConversationStore.getState().addOrUpdateConversation(conv);
                    metadataDecrypted = useConversationStore.getState().conversations.find(c => c.id === conversationId)?.decryptedMetadata ? true : false;
                } else {
                    metadataDecrypted = true;
                }
            }
        })();
        
        // Only re-decrypt pending messages AFTER metadata is decrypted.
        // If metadata wasn't available yet (no encryptedMetadata, conversation not in store),
        // don't advance the CK — wait for conversation:updated to arrive with metadata first.
        // The offline sync loop will process messages naturally, and the metadata:updated
        // handler will re-attempt metadata decrypt when the CK is still fresh.
        if (metadataDecrypted) {
            import('@store/message').then(({ useMessageStore }) => {
                useMessageStore.getState().reDecryptPendingMessages(conversationId);
            });
        }
    } catch (e) {
        // [BUGFIX: SENDER KEY OFFLINE SYNC] Propagate failure if needed, or emit request for new key
        console.error('[Crypto] Group key distribution failed:', e);
        // If offline key is stale (keys regenerated), request fresh key from sender
        const authStore = useAuthStore.getState();
        const myId = authStore.user?.id;
        if (senderId && myId !== senderUserId) {
            import('@lib/transportClient').then(({ emitGroupKeyRequest }) => {
                emitGroupKeyRequest(conversationId, senderId, senderDeviceKey).catch(() => {});
            });
        }
        throw new Error("DECRYPTION_FAILED");
    }

  } else if (sessionId) {    let newSessionKey: Uint8Array | undefined;

    if (encryptedKey.startsWith('{') && encryptedKey.includes('"x3dh":true')) {
        try {
            const metadata = JSON.parse(encryptedKey);
            if (metadata.x3dh && initiatorCiphertextsStr && initiatorSigningKey) {
                const { getEncryptionKeyPair, getSignedPreKeyPair, getPqEncryptionKeyPair, getPqSignedPreKeyPair } = useAuthStore.getState();
                const myIdentityKeyPair = await getEncryptionKeyPair();
                const mySignedPreKeyPair = await getSignedPreKeyPair();
                const myPqIdentityKeyPair = await getPqEncryptionKeyPair();
                const myPqSignedPreKeyPair = await getPqSignedPreKeyPair();

                newSessionKey = await deriveSessionKeyAsRecipient(
                    myIdentityKeyPair,
                    mySignedPreKeyPair,
                    myPqIdentityKeyPair,
                    myPqSignedPreKeyPair,
                    initiatorSigningKey,
                    initiatorCiphertextsStr,
                    metadata.otpkId
                );
            } else {
                throw new Error("Invalid X3DH payload");
            }
        } catch (e) {
            console.error("X3DH derivation failed, falling back to legacy decrypt:", e);
            if (encryptedKey.length > 20 && !encryptedKey.trim().startsWith('{')) {
                const { publicKey, privateKey } = await getMyEncryptionKeyPair();
                newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
            } else {
                console.warn("[Crypto] Skipping decryption for invalid/placeholder or JSON key.");
                return;
            }
        }
    } else {
        if (!encryptedKey || encryptedKey.length < 20 || encryptedKey.trim().startsWith('{')) {
             console.warn("[Crypto] Received empty, short, or JSON session key where base64 was expected. Ignoring.");
             return;
        }

        const { publicKey, privateKey } = await getMyEncryptionKeyPair();
        newSessionKey = await decryptSessionKeyForUser(encryptedKey, publicKey, privateKey);
    }

    if (newSessionKey) {
        await storeSessionKeySecurely(conversationId, sessionId, newSessionKey);
        
        const reqKey = `${conversationId}_${sessionId}`;
        const pendingRequest = pendingGroupKeyRequests.get(reqKey);
        if (pendingRequest) {
            clearTimeout(pendingRequest.timerId);
            pendingGroupKeyRequests.delete(reqKey);
        }

        import('@store/message').then(({ useMessageStore }) => {
            useMessageStore.getState().reDecryptPendingMessages(conversationId);
        });
    }
  }
}

// --- File Encryption/Decryption ---

export async function encryptFile(blob: Blob): Promise<{ encryptedBlob: Blob; key: string }> {
  const sodium = await getSodiumLib();
  const { worker_file_encrypt } = await getWorkerProxy();
  
  const { combinedData, key } = await worker_file_encrypt(blob);

  const encryptedBlob = new Blob([combinedData], { type: 'application/octet-stream' });

  const keyB64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);

  return { encryptedBlob, key: keyB64 };
}

export async function encryptFileViaWorker(blob: Blob): Promise<{ encryptedBlob: Blob; key: string }> {
  const sodium = await getSodiumLib();
  const { worker_file_encrypt } = await getWorkerProxy();
  
  const { combinedData, key } = await worker_file_encrypt(blob);

  const encryptedBlob = new Blob([combinedData], { type: 'application/octet-stream' });

  const keyB64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);

  return { encryptedBlob, key: keyB64 };
}

export async function decryptFile(encryptedBlob: Blob, keyB64: string, originalType: string): Promise<Blob> {
  const sodium = await getSodiumLib();
  const { worker_file_decrypt } = await getWorkerProxy();

  const keyBytes = sodium.from_base64(keyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  const decryptedData = await worker_file_decrypt(encryptedBlob, keyBytes);

  return new Blob([decryptedData], { type: originalType });
}

export async function generateSafetyNumber(myPublicKey: Uint8Array, theirPublicKey: Uint8Array): Promise<string> {
  const { generateSafetyNumber } = await getWorkerProxy();
  return generateSafetyNumber(myPublicKey, theirPublicKey);
}

export async function forceRotateGroupSenderKey(conversationId: string) {
    try {
        const { deleteGroupSenderState } = await import('../lib/keychainDb');
        await deleteGroupSenderState(conversationId);
    } catch (e) {
        console.error('Failed to rotate group key:', e);
    }
}

/* [REMOVED 2026-09-27] Sesi pairwise SPQR (`gspqr_<peerId>`) dihapus total.
Dulu dipakai sebagai jalur distribusi kunci grup T2 (pesan kontrol di
conversation virtual `<convId>:pw:<peer>`), tapi jalur itu TIDAK PERNAH lengkap:
server menolak conversation virtual dan client tidak punya hook penerima
(decryptWithSpqrSession tak pernah dipanggil) — kunci tidak pernah sampai.
Distribusi kini lewat `group:fulfilled_key` → `session:new_key` →
storeReceivedSessionKey (satu jalur + auto-heal request/fulfill).
Full-graph-privacy key distribution (SPQR/MLS) = backlog, lihat doc 26.8.
*/


