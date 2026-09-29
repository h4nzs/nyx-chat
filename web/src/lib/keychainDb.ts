import { isPlainObject } from '@utils/typeGuards';
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { db, VaultEntry } from './db';
import { asConversationId, asUserId } from '@nyx/shared';
import type { ConversationId, UserId, MessageId } from '@nyx/shared';

// ============================================================
// AT-REST ENCRYPTION (masterSeed-bound)
// Group chain keys (CK), skipped message keys, dan story keys
// dienkripsi dengan masterSeed sebelum disimpan ke IndexedDB.
// Skema sama dengan ratchet state (worker_encrypt_session_key).
// Nilai legacy (plaintext, tanpa prefix) tetap terbaca transparan
// dan dienkripsi ulang lewat migrateKeychainAtRestEncryption().
// ============================================================
export const AT_REST_PREFIX = 'ENC1:';

async function getMasterSeedOrUndefined(): Promise<Uint8Array | undefined> {
  const { useAuthStore } = await import('@store/auth');
  return useAuthStore.getState().getMasterSeed();
}

export async function encryptValueAtRest(value: string): Promise<string> {
  if (value.startsWith(AT_REST_PREFIX)) return value;
  try {
    const masterSeed = await getMasterSeedOrUndefined();
    if (!masterSeed) {
      console.warn('[KeychainDB] Master seed unavailable — storing value without at-rest encryption');
      return value;
    }
    const { worker_encrypt_session_key } = await import('@lib/crypto-worker-proxy');
    const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
    const bytes = await worker_encrypt_session_key(new TextEncoder().encode(value), masterSeed);
    return AT_REST_PREFIX + sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch (e) {
    console.warn('[KeychainDB] At-rest encryption failed — falling back to plaintext:', e);
    return value;
  }
}

export async function decryptValueAtRest(value: string): Promise<string | null> {
  if (!value.startsWith(AT_REST_PREFIX)) return value; // legacy plaintext
  try {
    const masterSeed = await getMasterSeedOrUndefined();
    if (!masterSeed) return null;
    const { worker_decrypt_session_key } = await import('@lib/crypto-worker-proxy');
    const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
    const bytes = await worker_decrypt_session_key(
      sodium.from_base64(value.slice(AT_REST_PREFIX.length), sodium.base64_variants.URLSAFE_NO_PADDING),
      masterSeed
    );
    return new TextDecoder().decode(bytes);
  } catch (e) {
    console.warn('[KeychainDB] At-rest decryption failed:', e);
    return null;
  }
}

async function encryptSkippedKeysAtRest(skippedKeys: Record<string, string> | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!skippedKeys) return out;
  for (const [k, v] of Object.entries(skippedKeys)) {
    out[k] = await encryptValueAtRest(v);
  }
  return out;
}

async function decryptSkippedKeysAtRest(skippedKeys: Record<string, string> | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!skippedKeys) return out;
  for (const [k, v] of Object.entries(skippedKeys)) {
    const plain = await decryptValueAtRest(v);
    if (plain === null) continue; // unreadable entry — skip (forward secrecy preserved)
    out[k] = plain;
  }
  return out;
}

// --- Types ---
export interface GroupSenderState {
  conversationId: ConversationId;
  CK: string;
  N: number;
  createdAt?: number;
  messageCount?: number;
  lastActivityTime?: number;
  requiresImmediateRotation?: boolean;
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  conversationId: ConversationId;
  senderId: UserId;
  CK: string;
  N: number;
  skippedKeys?: Record<string, string>;
  // [T2 FIX #9 2026-09-28] Public signing key pengirim, diikat SEJAK distribusi
  // kunci (pola libsignal SenderKeyState: sender_signing_key tersimpan di state
  // penerima). Sumber utama verifikasi signature pesan grup — menghapus
  // ketergantungan decrypt pada pseudonymMap/bundle API (chicken-and-egg).
  signingKey?: string;
}

// --- GLOBAL WRITE QUEUE ---
const dbWriteQueue: Promise<unknown> = Promise.resolve();
let queueTail = dbWriteQueue;

async function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const prev = queueTail;
    queueTail = (async () => {
        try {
            await prev;
        } catch (_e) {}
        return op();
    })();
    return queueTail as Promise<T>;
}

export async function closeDatabaseConnection() {
  if (db.isOpen()) {
    db.close();
  }
}

// ... existing helpers ...

export async function getGroupSenderState(conversationId: string): Promise<GroupSenderState | null> {
  return enqueueWrite(async () => {
    const record = await db.groupSenderStates.get(conversationId);
    // Di GroupRatchetState yang baru, CK sudah berupa string. 
    // Jika di runtime dia berupa Uint8Array (dari legacy code), kita konversi.
    let ckString = '';
    if (record) {
        const rawCk: unknown = record.state.CK;
        if (typeof rawCk === 'string') {
            ckString = rawCk;
        } else if (rawCk instanceof Uint8Array) {
            const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
            ckString = sodium.to_base64(rawCk, sodium.base64_variants.URLSAFE_NO_PADDING);
        }
    }

    const ckPlain = await decryptValueAtRest(ckString);
    if (ckPlain === null) return null; // encrypted but unreadable (locked/corrupt)
    
    return record ? {
        conversationId: asConversationId(record.conversationId),
        CK: ckPlain,
        N: record.state.N,
        createdAt: record.state.createdAt,
        messageCount: record.state.messageCount,
        lastActivityTime: record.state.lastActivityTime,
        requiresImmediateRotation: record.state.requiresImmediateRotation
    } : null;
  });
}

export async function saveGroupSenderState(state: GroupSenderState): Promise<void> {
  return enqueueWrite(async () => {
      // Sama seperti di atas, kita simpan sesuai schema yang baru (string)
      // CK dienkripsi at-rest dengan masterSeed (prefix ENC1:)
      await db.groupSenderStates.put({
          conversationId: state.conversationId,
          state: {
            CK: await encryptValueAtRest(state.CK),
            N: state.N,
            createdAt: state.createdAt,
            messageCount: state.messageCount,
            lastActivityTime: state.lastActivityTime,
            requiresImmediateRotation: state.requiresImmediateRotation
          }
      });  });
}

export async function getGroupReceiverState(conversationId: string, senderId: string, senderDeviceKey?: string): Promise<GroupReceiverState | null> {
  return enqueueWrite(async () => {
    const id = senderDeviceKey ? `${conversationId}_${senderId}_${senderDeviceKey}` : `${conversationId}_${senderId}`;
    const record = await db.groupReceiverStates.get(id);
    
    let ckString = '';
    if (record) {
        const rawCk: unknown = record.state.CK;
        if (typeof rawCk === 'string') {
            ckString = rawCk;
        } else if (rawCk instanceof Uint8Array) {
            const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
            ckString = sodium.to_base64(rawCk, sodium.base64_variants.URLSAFE_NO_PADDING);
        }
    }

    const ckPlain = await decryptValueAtRest(ckString);
    if (ckPlain === null) return null;

    return record ? {
        id: record.id,
        conversationId: asConversationId(conversationId),
        senderId: asUserId(senderId),
        CK: ckPlain,
        N: record.state.N,
        skippedKeys: await decryptSkippedKeysAtRest(record.state.skippedKeys),
        signingKey: record.state.signingKey
    } : null;
  });
}

export async function saveGroupReceiverState(state: GroupReceiverState): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupReceiverStates.put({
          id: state.id,
          state: {
            CK: await encryptValueAtRest(state.CK),
            N: state.N,
            skippedKeys: await encryptSkippedKeysAtRest(state.skippedKeys),
            // Public key — tidak sensitif (bukan private), simpan plaintext.
            signingKey: state.signingKey
          }
      });
  });
}

/**
 * Stores a group skipped message key atomically.
 */
export async function storeGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string, n: number, mk: string, keyId?: string): Promise<void> {
    return enqueueWrite(async () => {
        const key = keyId ? `${conversationId}_${senderId}_${senderDeviceKey}_${keyId}_${n}` : `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
        await db.groupSkippedKeys.put({ key, mk: await encryptValueAtRest(mk) });
    });
}

/**
 * Retrieves a group skipped message key without deleting it.
 */
export async function getGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string | undefined, n: number, keyId?: string): Promise<string | null> {
    return enqueueWrite(async () => {
        if (senderDeviceKey && senderDeviceKey !== 'undefined') {
            const key = keyId ? `${conversationId}_${senderId}_${senderDeviceKey}_${keyId}_${n}` : `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
            const record = await db.groupSkippedKeys.get(key);
            if (record) return decryptValueAtRest(record.mk);
            
            if (keyId) {
                // Fallback to legacy format without keyId
                const fallbackKey = `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
                const fallbackRecord = await db.groupSkippedKeys.get(fallbackKey);
                if (fallbackRecord) return decryptValueAtRest(fallbackRecord.mk);
            }
        }
        
        // Fallback for older messages that didn't include senderDeviceKey
        const prefix = `${conversationId}_${senderId}_`;
        const suffix = `_${n}`;
        const records = await db.groupSkippedKeys.toArray();
        const found = records.find(r => r.key.startsWith(prefix) && r.key.endsWith(suffix));
        return found ? decryptValueAtRest(found.mk) : null;
    });
}

/**
 * Deletes a group skipped message key.
 */
export async function deleteGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string | undefined, n: number): Promise<void> {
    return enqueueWrite(async () => {
        if (senderDeviceKey && senderDeviceKey !== 'undefined') {
            const key = `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
            await db.groupSkippedKeys.delete(key);
            return;
        }
        
        const prefix = `${conversationId}_${senderId}_`;
        const suffix = `_${n}`;
        const records = await db.groupSkippedKeys.toArray();
        const found = records.find(r => r.key.startsWith(prefix) && r.key.endsWith(suffix));
        if (found) {
            await db.groupSkippedKeys.delete(found.key);
        }
    });
}

export async function deleteGroupStates(conversationId: string): Promise<void> {
  await enqueueWrite(async () => {
      // 1. Hapus Sender State
      await db.groupSenderStates.delete(conversationId);
      
      // 2. Hapus SEMUA Receiver States
      await db.groupReceiverStates
          .where('id')
          .between(conversationId + "_", conversationId + "_\uffff", true, true)
          .delete();
          
      // 3. Hapus SEMUA Skipped Keys
      await db.groupSkippedKeys
          .where('key')
          .between(conversationId + "_", conversationId + "_\uffff", true, true)
          .delete();
  });
}

export async function deleteGroupSenderState(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupSenderStates.delete(conversationId);
  });
}

export async function storePendingHeader(conversationId: string, header: Record<string, unknown>): Promise<void> {
  return enqueueWrite(async () => {
      await db.pendingHeaders.put({ conversationId: conversationId as ConversationId, header });
  });
}

export async function getPendingHeader(conversationId: string): Promise<Record<string, unknown> | null> {
  const record = await db.pendingHeaders.get(conversationId);
  return record ? record.header : null;
}

export async function deletePendingHeader(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.pendingHeaders.delete(conversationId);
  });
}

export async function storeOneTimePreKey(keyId: number, encryptedPrivateKey: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      try {
          // Explicit casting to number to prevent IndexedDB type mismatch
          await db.preKeys.put({ keyId: Number(keyId), encryptedPrivateKey });
      } catch (err) {
          console.error(`[KeychainDB] CRITICAL: Failed to save OneTimePreKey ${keyId}`, err);
          throw err;
      }
  });
}

export async function getOneTimePreKey(keyId: number): Promise<Uint8Array | null> {
  const record = await db.preKeys.get(keyId);
  return record ? record.encryptedPrivateKey : null;
}

export async function deleteOneTimePreKey(keyId: number): Promise<void> {
  return enqueueWrite(async () => {
      await db.preKeys.delete(keyId);
  });
}

export async function getLastOtpkId(): Promise<number> {
  const lastKey = await db.preKeys.orderBy('keyId').last();
  return lastKey ? lastKey.keyId : 0;
}

export async function addSessionKey(
  conversationId: string,
  sessionId: string,
  key: Uint8Array
): Promise<void> {
  return enqueueWrite(async () => {
      const storageKey = `${conversationId}_${sessionId}`;
      await db.sessionKeys.put({ storageKey, conversationId: conversationId as ConversationId, sessionId, key });
  });
}

export async function getSessionKey(
  conversationId: string,
  sessionId: string
): Promise<Uint8Array | null> {
  const storageKey = `${conversationId}_${sessionId}`;
  const record = await db.sessionKeys.get(storageKey);
  return record ? record.key : null;
}

export async function getLatestSessionKey(
  conversationId: string
): Promise<{ sessionId: string; key: Uint8Array } | null> {
  const lastSession = await db.sessionKeys
      .where('storageKey')
      .between(conversationId + "_", conversationId + "_\uffff", true, true)
      .last();

  if (lastSession) {
      return { sessionId: lastSession.sessionId, key: lastSession.key };
  }
  return null;
}

export async function storeGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupKeys.put({ conversationId: conversationId as ConversationId, key });
  });
}

export async function getGroupKey(conversationId: string): Promise<Uint8Array | null> {
  const record = await db.groupKeys.get(conversationId);
  return record ? record.key : null;
}

export async function receiveGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return storeGroupKey(conversationId, key);
}

export async function deleteGroupKey(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupKeys.delete(conversationId);
  });
}

export async function storeRatchetSession(conversationId: string, encryptedState: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.ratchetSessions.put({ conversationId: conversationId as ConversationId, state: encryptedState });
  });
}

export async function getRatchetSession(conversationId: string): Promise<Uint8Array | null> {
  const record = await db.ratchetSessions.get(conversationId);
  return record ? record.state : null;
}

export async function storeSkippedKey(headerKey: string, encryptedKey: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.skippedKeys.put({ headerKey, key: encryptedKey });
  });
}

export async function getSkippedKey(headerKey: string): Promise<Uint8Array | null> {
  const record = await db.skippedKeys.get(headerKey);
  return record ? record.key : null;
}

export async function deleteSkippedKey(headerKey: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.skippedKeys.delete(headerKey);
  });
}

export async function deleteRatchetSession(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.ratchetSessions.delete(conversationId);
  });
}

export async function deleteSessionKeys(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.sessionKeys
          .where('storageKey')
          .between(conversationId + "_", conversationId + "_\uffff", true, true)
          .delete();
  });
}

export async function deleteGroupReceiverStates(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
     await db.groupReceiverStates
         .where('id')
         .between(conversationId + "_", conversationId + "_\uffff", true, true)
         .delete();

     await db.groupSkippedKeys
         .where('key')
         .between(conversationId + "_", conversationId + "_\uffff", true, true)
         .delete();
  });
}

export async function storeMessageKey(messageId: string, encryptedMk: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.messageKeys.put({ messageId: messageId as MessageId, key: encryptedMk });
  });
}

export async function getMessageKey(messageId: string): Promise<Uint8Array | null> {
  const record = await db.messageKeys.get(messageId);
  return record ? record.key : null;
}

export async function deleteMessageKey(messageId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.messageKeys.delete(messageId);
  });
}

export async function deleteConversationKeychain(conversationId: string): Promise<void> {
  await Promise.all([
    deleteSessionKeys(conversationId),
    deleteGroupKey(conversationId),
    deleteRatchetSession(conversationId),
    deletePendingHeader(conversationId),
    deleteGroupSenderState(conversationId),
    deleteGroupReceiverStates(conversationId)
  ]);
}

export async function saveProfileKey(userId: string, keyB64: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.identityKeys.put({ userId: userId as UserId, key: keyB64 });
  });
}

export async function getProfileKey(userId: string): Promise<string | undefined> {
  const record = await db.identityKeys.get(userId);
  return record?.key;
}

export async function savePeerIdentityKey(userId: string, keyB64: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.identityKeys.put({ userId: `ID_PUB_${userId}` as UserId, key: keyB64 });
  });
}

export async function getPeerIdentityKey(userId: string): Promise<string | undefined> {
  const record = await db.identityKeys.get(`ID_PUB_${userId}`);
  return record?.key;
}

export async function clearAllKeys(): Promise<void> {
  return enqueueWrite(async () => {
      await Promise.all([
          db.messages.clear(),
          db.storyKeys.clear(),
          db.offlineQueue.clear(),
          db.kvStore.clear(),
          db.sessionKeys.clear(),
          db.groupKeys.clear(),
          db.preKeys.clear(),
          db.identityKeys.clear(),
          db.ratchetSessions.clear(),
          db.groupSenderStates.clear(),
          db.groupReceiverStates.clear(),
          db.skippedKeys.clear(),
          db.messageKeys.clear(),
          db.pendingHeaders.clear(),
          db.groupSkippedKeys.clear(),
          db.pqDrSessions.clear()
      ]);
  });
}

export type { VaultEntry };

// ============================================================
// MIGRASI AT-REST: enkripsi ulang nilai plaintext legacy (tanpa
// prefix ENC1:) yang tersimpan sebelum versi ini. Dijalankan
// sekali setelah sesi ter-unlock. Idempotent & aman dijalankan
// berulang. Semua tulis lewat queue agar tidak race.
// ============================================================
export async function migrateKeychainAtRestEncryption(): Promise<void> {
  return enqueueWrite(async () => {
    const masterSeed = await getMasterSeedOrUndefined();
    if (!masterSeed) return; // session belum ter-unlock — tunda sampai unlock berikutnya

    // 1. Group sender states (CK)
    const senderRecords = await db.groupSenderStates.toArray();
    for (const r of senderRecords) {
      const rawCk: unknown = r.state.CK;
      if (typeof rawCk === 'string' && !rawCk.startsWith(AT_REST_PREFIX)) {
        await db.groupSenderStates.put({ conversationId: r.conversationId, state: { ...r.state, CK: await encryptValueAtRest(rawCk) } });
      }
    }

    // 2. Group receiver states (CK + skippedKeys)
    const receiverRecords = await db.groupReceiverStates.toArray();
    for (const r of receiverRecords) {
      const rawCk: unknown = r.state.CK;
      const needsCk = typeof rawCk === 'string' && !rawCk.startsWith(AT_REST_PREFIX);
      let needsSkipped = false;
      for (const v of Object.values(r.state.skippedKeys || {})) {
        if (!v.startsWith(AT_REST_PREFIX)) { needsSkipped = true; break; }
      }
      if (needsCk || needsSkipped) {
        await db.groupReceiverStates.put({
          id: r.id,
          state: {
            ...r.state,
            CK: needsCk ? await encryptValueAtRest(rawCk as string) : r.state.CK,
            skippedKeys: needsSkipped ? await encryptSkippedKeysAtRest(r.state.skippedKeys) : r.state.skippedKeys
          }
        });
      }
    }

    // 3. Group skipped keys (mk)
    const groupSkippedRecords = await db.groupSkippedKeys.toArray();
    for (const r of groupSkippedRecords) {
      if (!r.mk.startsWith(AT_REST_PREFIX)) {
        await db.groupSkippedKeys.put({ key: r.key, mk: await encryptValueAtRest(r.mk) });
      }
    }

    // 4. Story keys (di store storyKeys — shared dengan ShadowVault)
    const storyRecords = await db.storyKeys.toArray();
    for (const r of storyRecords) {
      if (!r.key.startsWith(AT_REST_PREFIX)) {
        await db.storyKeys.put({ storyId: r.storyId, key: await encryptValueAtRest(r.key) });
      }
    }
  });
}

// --- Opaque Mailbox: Cached Group Participants ---

/**
 * Menyimpan daftar user IDs partisipan grup ke IndexedDB.
 * Digunakan oleh Opaque Mailbox agar non-creator tetap tahu anggota grup
 * meskipun metadata belum didekripsi.
 */
export async function saveCachedGroupParticipants(conversationId: string, userIds: string[]): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupCachedParticipants.put({ conversationId, userIds });
  });
}

/**
 * Mengembalikan daftar user IDs partisipan grup dari cache IndexedDB.
 * Returns null jika belum pernah di-cache.
 */
export async function getCachedGroupParticipants(conversationId: string): Promise<string[] | null> {
  const record = await db.groupCachedParticipants.get(conversationId);
  return record ? record.userIds : null;
}

/**
 * Mengekspor seluruh isi brankas kunci menjadi string JSON.
 */
export async function exportDatabaseToJson(): Promise<string> {
  const exportData: Record<string, unknown[]> = {};

  const tables = [
    'messages', 
    'messageKeys', 
    'storyKeys', 
    'offlineQueue',
    'identityKeys', 
    'groupReceiverStates', 
    'groupSkippedKeys',
    'sessionKeys',
    'groupKeys',
    'preKeys',
    'ratchetSessions',
    'groupSenderStates',
    'skippedKeys',
    'pendingHeaders',
    'pqDrSessionsV2',
    'kvStore'
  ];

  for (const tableName of tables) {
     const table = db.table(tableName);
     if (table) {
         exportData[tableName] = await table.toArray();
     }
  }

  const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());

  return JSON.stringify(exportData, (key, value) => {
    if (value instanceof Uint8Array) {
      return { __type: 'Uint8Array', data: sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING) };
    }
    if (value instanceof ArrayBuffer) {
      return { __type: 'Uint8Array', data: sodium.to_base64(new Uint8Array(value), sodium.base64_variants.URLSAFE_NO_PADDING) };
    }
    // Handle objects that might contain buffers (like states)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Recursive serialization for state objects is handled by JSON.stringify
    }
    return value;
  });
}

/**
 * Mengimpor dan menimpa isi brankas kunci dari string JSON.
 */
export async function importDatabaseFromJson(jsonString: string, password?: string): Promise<void> {
  return enqueueWrite(async () => {
      let importData: Record<string, unknown[]>;
      try {
          const parsedInit: unknown = JSON.parse(jsonString);
          let finalJsonStr = jsonString;

          const isVaultEnvelope = (obj: unknown): obj is { encrypted: boolean; salt: string; data: string } => {
              return typeof obj === 'object' && obj !== null && 'encrypted' in obj && 'salt' in obj && 'data' in obj;
          };

          if (isVaultEnvelope(parsedInit)) {
              if (!password) throw new Error("Password required to decrypt vault.");
              
              const { getSodiumLib } = await import('@utils/crypto');
              const sodium = await getSodiumLib();
              const { deriveKeyFromPassword, decryptWithKey } = await import('@lib/crypto-worker-proxy');
              
              const salt = sodium.from_base64(parsedInit.salt, sodium.base64_variants.URLSAFE_NO_PADDING);
              const key = await deriveKeyFromPassword(password, salt);
              finalJsonStr = String(await decryptWithKey(key, parsedInit.data));
          }

          const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
          const _parsedImport = JSON.parse(finalJsonStr, (key, value) => {
            if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
              if (typeof value.data === 'string') {
                  return sodium.from_base64(value.data, sodium.base64_variants.URLSAFE_NO_PADDING);
              }
              return new Uint8Array(value.data);
            }
            return value;
          });
          importData = isPlainObject(_parsedImport) ? _parsedImport as Record<string, unknown[]> : {};
      } catch (_e) {
          throw new Error("Invalid vault file format or incorrect password.");
      }

      const tables = [
        'messages', 
        'messageKeys', 
        'storyKeys', 
        'offlineQueue',
        'identityKeys', 
        'groupReceiverStates', 
        'groupSkippedKeys',
        'sessionKeys',
        'groupKeys',
        'preKeys',
        'ratchetSessions',
        'groupSenderStates',
        'skippedKeys',
        'pendingHeaders',
        'pqDrSessionsV2',
        'kvStore'
      ];

      await db.transaction('rw', tables.map(t => db.table(t)), async () => {
          for (const tableName of tables) {
              const table = db.table(tableName);
              if (table && importData[tableName]) {
                  await table.clear();
                  await table.bulkPut(importData[tableName]);
              }
          }
      });
  });
}

export async function getGroupReceiverStateByKeyId(conversationId: string, keyId: string): Promise<GroupReceiverState | null> {
  return enqueueWrite(async () => {
    const records = await db.groupReceiverStates
      .where('id')
      .startsWith(conversationId + '_')
      .toArray();

    const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());

    for (const record of records) {
        let ckString = '';
        const rawCk: unknown = record.state.CK;
        if (typeof rawCk === 'string') {
            ckString = rawCk;
        } else if (rawCk instanceof Uint8Array) {
            ckString = sodium.to_base64(rawCk, sodium.base64_variants.URLSAFE_NO_PADDING);
        }

        const ckPlain = await decryptValueAtRest(ckString);
        if (ckPlain === null) continue;

        if (ckPlain.substring(0, 8) === keyId) {
            const parts = record.id.split('_');
            const senderId = parts[1] ?? '';
            
            return {
                id: record.id,
                conversationId: asConversationId(conversationId),
                senderId: asUserId(senderId),
                CK: ckPlain,
                N: record.state.N,
                skippedKeys: await decryptSkippedKeysAtRest(record.state.skippedKeys ?? {}),
                // [T2 FIX #13 2026-09-29] signingKey WAJIB ikut di jalur byId —
                // semua pesan grup (dan metadata) lookup receiver state via keyId,
                // BUKAN by-id. Tanpa ini fix #9 tidak berlaku di jalur utama:
                // verifikasi signature butuh resolve pseudonym → metadata →
                // chicken-and-egg → invitee gagal dekripsi total (log 2-browser).
                signingKey: record.state.signingKey
            };
        }
    }
    return null;
  });
}
