// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { db, VaultEntry } from './db';
import { asConversationId, asUserId } from '@nyx/shared';
import type { ConversationId, UserId, MessageId } from '@nyx/shared';

// --- Types ---
export interface GroupSenderState {
  conversationId: ConversationId;
  CK: string;
  N: number;
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  conversationId: ConversationId;
  senderId: UserId;
  CK: string;
  N: number;
}

// --- GLOBAL WRITE QUEUE ---
// This ensures that even if multiple async processes try to update the database,
// they do so in a strict, predictable sequence.
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
  const record = await db.groupSenderStates.get(conversationId);
  return record ? {
      conversationId: asConversationId(record.conversationId),
      CK: record.state.CK,
      N: record.state.N
  } : null;
}

export async function saveGroupSenderState(state: GroupSenderState): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupSenderStates.put({
          conversationId: state.conversationId,
          state: { CK: state.CK, N: state.N }
      });
  });
}

export async function getGroupReceiverState(conversationId: string, senderId: string, senderDeviceKey?: string): Promise<GroupReceiverState | null> {
  const id = senderDeviceKey ? `${conversationId}_${senderId}_${senderDeviceKey}` : `${conversationId}_${senderId}`;
  const record = await db.groupReceiverStates.get(id);
  return record ? {
      id: record.id,
      conversationId: asConversationId(conversationId),
      senderId: asUserId(senderId),
      CK: record.state.CK,
      N: record.state.N
  } : null;
}

export async function saveGroupReceiverState(state: GroupReceiverState): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupReceiverStates.put({
          id: state.id,
          state: { CK: state.CK, N: state.N }
      });
  });
}

/**
 * Stores a group skipped message key atomically.
 */
export async function storeGroupSkippedKey(conversationId: string, senderId: string, n: number, mk: string): Promise<void> {
    return enqueueWrite(async () => {
        const key = `${conversationId}_${senderId}_${n}`;
        await db.groupSkippedKeys.put({ key, mk });
    });
}

/**
 * Retrieves and deletes a group skipped message key.
 */
export async function takeGroupSkippedKey(conversationId: string, senderId: string, n: number): Promise<string | null> {
    return enqueueWrite(async () => {
        const key = `${conversationId}_${senderId}_${n}`;
        const record = await db.groupSkippedKeys.get(key);
        if (record) {
            await db.groupSkippedKeys.delete(key);
            return record.mk;
        }
        return null;
    });
}

export async function deleteGroupStates(conversationId: string): Promise<void> {
  await enqueueWrite(async () => {
      // 1. Hapus Sender State (Ini aman menggunakan exact match karena key-nya adalah conversationId)
      await db.groupSenderStates.delete(conversationId);
      
      // 2. Hapus SEMUA Receiver States yang berawalan dari conversationId_
      await db.groupReceiverStates
          .where('id')
          .between(conversationId + "_", conversationId + "_\uffff", true, true)
          .delete();
          
      // 3. Hapus SEMUA Skipped Keys yang berawalan dari conversationId_
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

/**
 * Stores a pending X3DH header for a conversation.
 */
export async function storePendingHeader(conversationId: string, header: Record<string, unknown>): Promise<void> {
  return enqueueWrite(async () => {
      await db.pendingHeaders.put({ conversationId: conversationId as ConversationId, header });
  });
}

/**
 * Retrieves a pending X3DH header.
 */
export async function getPendingHeader(conversationId: string): Promise<Record<string, unknown> | null> {
  const record = await db.pendingHeaders.get(conversationId);
  return record ? record.header : null;
}

/**
 * Deletes a pending X3DH header.
 */
export async function deletePendingHeader(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.pendingHeaders.delete(conversationId);
  });
}

/**
 * Stores a One-Time Pre-Key (private part) securely.
 */
export async function storeOneTimePreKey(keyId: number, encryptedPrivateKey: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.preKeys.put({ keyId, keyPair: encryptedPrivateKey });
  });
}

/**
 * Retrieves a One-Time Pre-Key (private part) by ID.
 */
export async function getOneTimePreKey(keyId: number): Promise<Uint8Array | null> {
  const record = await db.preKeys.get(keyId);
  return record ? record.keyPair : null;
}

/**
 * Deletes a One-Time Pre-Key after use (for Forward Secrecy).
 */
export async function deleteOneTimePreKey(keyId: number): Promise<void> {
  return enqueueWrite(async () => {
      await db.preKeys.delete(keyId);
  });
}

/**
 * Gets the highest keyId currently in the store.
 */
export async function getLastOtpkId(): Promise<number> {
  const lastKey = await db.preKeys.orderBy('keyId').last();
  return lastKey ? lastKey.keyId : 0;
}

/**
 * Adds a session key to the keychain atomically.
 */
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

/**
 * Retrieves a specific session key from the keychain.
 */
export async function getSessionKey(
  conversationId: string,
  sessionId: string
): Promise<Uint8Array | null> {
  const storageKey = `${conversationId}_${sessionId}`;
  const record = await db.sessionKeys.get(storageKey);
  return record ? record.key : null;
}

/**
 * Retrieves the most recently added session key for a conversation.
 */
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

/**
 * Stores a group key for a specific conversation.
 */
export async function storeGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupKeys.put({ conversationId: conversationId as ConversationId, key });
  });
}

/**
 * Retrieves the group key for a specific conversation.
 */
export async function getGroupKey(conversationId: string): Promise<Uint8Array | null> {
  const record = await db.groupKeys.get(conversationId);
  return record ? record.key : null;
}

/**
 * Stores a group key received from another user.
 */
export async function receiveGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return storeGroupKey(conversationId, key);
}

/**
 * Deletes the group key for a specific conversation.
 */
export async function deleteGroupKey(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.groupKeys.delete(conversationId);
  });
}

/**
 * Stores the encrypted RatchetState for a conversation.
 */
export async function storeRatchetSession(conversationId: string, encryptedState: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.ratchetSessions.put({ conversationId: conversationId as ConversationId, state: encryptedState });
  });
}

/**
 * Retrieves the encrypted RatchetState for a conversation.
 */
export async function getRatchetSession(conversationId: string): Promise<Uint8Array | null> {
  const record = await db.ratchetSessions.get(conversationId);
  return record ? record.state : null;
}

/**
 * Stores an encrypted skipped message key.
 */
export async function storeSkippedKey(headerKey: string, encryptedKey: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.skippedKeys.put({ headerKey, key: encryptedKey });
  });
}

/**
 * Retrieves an encrypted skipped message key.
 */
export async function getSkippedKey(headerKey: string): Promise<Uint8Array | null> {
  const record = await db.skippedKeys.get(headerKey);
  return record ? record.key : null;
}

/**
 * Deletes a skipped message key.
 */
export async function deleteSkippedKey(headerKey: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.skippedKeys.delete(headerKey);
  });
}

/**
 * Deletes the encrypted RatchetState for a conversation.
 */
export async function deleteRatchetSession(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.ratchetSessions.delete(conversationId);
  });
}

/**
 * Deletes all session keys for a conversation.
 */
export async function deleteSessionKeys(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.sessionKeys
          .where('storageKey')
          .between(conversationId + "_", conversationId + "_\uffff", true, true)
          .delete();
  });
}

/**
 * Deletes all group receiver states for a conversation.
 */
export async function deleteGroupReceiverStates(conversationId: string): Promise<void> {
  return enqueueWrite(async () => {
     // Delete states
     await db.groupReceiverStates
         .where('id')
         .between(conversationId + "_", conversationId + "_\uffff", true, true)
         .delete();

     // Delete skipped keys (assuming key starts with conversationId_)
     await db.groupSkippedKeys
         .where('key')
         .between(conversationId + "_", conversationId + "_\uffff", true, true)
         .delete();
  });
}

/**
 * Stores an encrypted Message Key locally for history decryption.
 */
export async function storeMessageKey(messageId: string, encryptedMk: Uint8Array): Promise<void> {
  return enqueueWrite(async () => {
      await db.messageKeys.put({ messageId: messageId as MessageId, key: encryptedMk });
  });
}

/**
 * Retrieves an encrypted Message Key.
 */
export async function getMessageKey(messageId: string): Promise<Uint8Array | null> {
  const record = await db.messageKeys.get(messageId);
  return record ? record.key : null;
}

/**
 * Deletes an encrypted Message Key locally.
 */
export async function deleteMessageKey(messageId: string): Promise<void> {
  return enqueueWrite(async () => {
      await db.messageKeys.delete(messageId);
  });
}

/**
 * Clears all data related to a conversation from the keychain.
 */
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

/**
 * Clears all keys from the database. Used on logout.
 */
export async function clearAllKeys(): Promise<void> {
  return enqueueWrite(async () => {
      // Clear all keychain-related tables
      await Promise.all([
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
          db.groupSkippedKeys.clear()
      ]);
  });
}

export type { VaultEntry };

/**
 * Mengekspor seluruh isi brankas kunci menjadi string JSON.
 */
export async function exportDatabaseToJson(): Promise<string> {
  const exportData: Record<string, unknown[]> = {};

  // ✅ FIX: HANYA ekspor/impor tabel riwayat dan status penerima.
  const tables = [
    'messages', 
    'messageKeys', // ✅ Menambahkan messageKeys agar histori bisa didekripsi
    'storyKeys', 
    'offlineQueue',
    'identityKeys', 
    'groupReceiverStates', 
    'groupSkippedKeys'
  ];

  for (const tableName of tables) {
     const table = db.table(tableName);
     if (table) {
         exportData[tableName] = await table.toArray();
     }
  }

  // --- DEVICE-SPECIFIC DECRYPTION FOR HISTORY SYNC ---
  // Kita harus mendekripsi messages dan messageKeys sebelum diekspor karena kunci enkripsi
  // bersifat lokal per perangkat (masterSeed / privateKey).
  try {
      const { useAuthStore } = await import('@store/auth');
      const masterSeed = await useAuthStore.getState().getMasterSeed();
      if (masterSeed) {
          const { worker_decrypt_session_key } = await import('@lib/crypto-worker-proxy');

          if (exportData['messageKeys']) {
              for (const mk of exportData['messageKeys']) {
                  try {
                      const m = mk as { key: Uint8Array, plaintext?: string };
                      const decrypted = await worker_decrypt_session_key(m.key, masterSeed);
                      // Temporary store as array so JSON.stringify can handle it
                      m.plaintext = Buffer.from(decrypted).toString('base64');
                  } catch (e) {}
              }
          }
      }

      const { decryptVaultText } = await import('@lib/shadowVaultDb');
      if (exportData['messages']) {
          for (const msg of exportData['messages']) {
              const m = msg as any;
              if (m.content) m.content = await decryptVaultText(m.content) || m.content;
              if (m.preview) m.preview = await decryptVaultText(m.preview) || m.preview;
              if (m.fileUrl) m.fileUrl = await decryptVaultText(m.fileUrl) || m.fileUrl;
              if (m.fileMeta) m.fileMeta = await decryptVaultText(m.fileMeta) || m.fileMeta;
          }
      }
  } catch (e) {
      console.warn("Failed to decrypt local payload for export", e);
  }

  return JSON.stringify(exportData, (key, value) => {
    if (value instanceof Uint8Array) {
      return { __type: 'Uint8Array', data: Array.from(value) };
    }
    return value;
  });
}
/**
 * Mengimpor dan menimpa isi brankas kunci dari string JSON.
 */
export async function importDatabaseFromJson(jsonString: string): Promise<void> {
  return enqueueWrite(async () => {
      let importData: Record<string, unknown[]>;
      try {
          importData = JSON.parse(jsonString, (key, value) => {
            if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
              return new Uint8Array(value.data);
            }
            return value;
          }) as Record<string, unknown[]>;
      } catch (_e) {
          throw new Error("Invalid vault file format.");
      }

      // ✅ FIX: Harus sejajar dengan variabel tables di fungsi export
      const tables = [
        'messages', 
        'messageKeys', // ✅ Menambahkan messageKeys
        'storyKeys', 
        'offlineQueue',
        'identityKeys', 
        'groupReceiverStates', 
        'groupSkippedKeys'
      ];

      // --- DEVICE-SPECIFIC ENCRYPTION FOR HISTORY SYNC ---
      try {
          const { useAuthStore } = await import('@store/auth');
          const masterSeed = await useAuthStore.getState().getMasterSeed();
          if (masterSeed) {
              const { worker_encrypt_session_key } = await import('@lib/crypto-worker-proxy');
              
              if (importData['messageKeys']) {
                  for (const mk of importData['messageKeys']) {
                      try {
                          const m = mk as { key: Uint8Array, plaintext?: string };
                          if (m.plaintext) {
                              const mkBytes = Buffer.from(m.plaintext, 'base64');
                              m.key = await worker_encrypt_session_key(mkBytes, masterSeed);
                              delete m.plaintext;
                          }
                      } catch (e) {}
                  }
              }
          }

          const { encryptVaultText } = await import('@lib/shadowVaultDb');
          if (importData['messages']) {
              for (const msg of importData['messages']) {
                  const m = msg as { content?: string, preview?: string, fileUrl?: string, fileMeta?: string };
                  // Only re-encrypt if it's plaintext (not starting with typical base64 ciphertext headers/flags if any)
                  // For shadowVaultDb, messages are exported as plaintext now!
                  if (m.content) m.content = await encryptVaultText(m.content);
                  if (m.preview) m.preview = await encryptVaultText(m.preview);
                  if (m.fileUrl) m.fileUrl = await encryptVaultText(m.fileUrl);
                  if (m.fileMeta) m.fileMeta = await encryptVaultText(m.fileMeta);
              }
          }
      } catch (e) {
          console.warn("Failed to encrypt imported payload", e);
      }

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
