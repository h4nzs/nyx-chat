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
  createdAt?: number;
  messageCount?: number;
  lastActivityTime?: number;
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  conversationId: ConversationId;
  senderId: UserId;
  CK: string;
  N: number;
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
  const record = await db.groupSenderStates.get(conversationId);
  // Di GroupRatchetState yang baru, CK sudah berupa string. 
  // Jika di runtime dia berupa Uint8Array (dari legacy code), kita konversi.
  let ckString = '';
  if (record) {
      if (typeof record.state.CK === 'string') {
          ckString = record.state.CK;
      } else if ((record.state.CK as unknown) instanceof Uint8Array) {
          const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
          ckString = sodium.to_base64(record.state.CK as unknown as Uint8Array, sodium.base64_variants.URLSAFE_NO_PADDING);
      }
  }
  
  return record ? {
      conversationId: asConversationId(record.conversationId),
      CK: ckString,
      N: record.state.N,
      createdAt: record.state.createdAt,
      messageCount: record.state.messageCount,
      lastActivityTime: record.state.lastActivityTime
  } : null;
}

export async function saveGroupSenderState(state: GroupSenderState): Promise<void> {
  return enqueueWrite(async () => {
      // Sama seperti di atas, kita simpan sesuai schema yang baru (string)
      await db.groupSenderStates.put({
          conversationId: state.conversationId,
          state: {
            CK: state.CK,
            N: state.N,
            createdAt: state.createdAt,
            messageCount: state.messageCount,
            lastActivityTime: state.lastActivityTime
          }
      });  });
}

export async function getGroupReceiverState(conversationId: string, senderId: string, senderDeviceKey?: string): Promise<GroupReceiverState | null> {
  const id = senderDeviceKey ? `${conversationId}_${senderId}_${senderDeviceKey}` : `${conversationId}_${senderId}`;
  const record = await db.groupReceiverStates.get(id);
  
  let ckString = '';
  if (record) {
      if (typeof record.state.CK === 'string') {
          ckString = record.state.CK;
      } else if ((record.state.CK as unknown) instanceof Uint8Array) {
          const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
          ckString = sodium.to_base64(record.state.CK as unknown as Uint8Array, sodium.base64_variants.URLSAFE_NO_PADDING);
      }
  }

  return record ? {
      id: record.id,
      conversationId: asConversationId(conversationId),
      senderId: asUserId(senderId),
      CK: ckString,
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
export async function storeGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string, n: number, mk: string): Promise<void> {
    return enqueueWrite(async () => {
        const key = `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
        await db.groupSkippedKeys.put({ key, mk });
    });
}

/**
 * Retrieves a group skipped message key without deleting it.
 */
export async function getGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string | undefined, n: number): Promise<string | null> {
    return enqueueWrite(async () => {
        if (senderDeviceKey && senderDeviceKey !== 'undefined') {
            const key = `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
            const record = await db.groupSkippedKeys.get(key);
            if (record) return record.mk;
        }
        
        // Fallback for older messages that didn't include senderDeviceKey
        const prefix = `${conversationId}_${senderId}_`;
        const suffix = `_${n}`;
        const records = await db.groupSkippedKeys.toArray();
        const found = records.find(r => r.key.startsWith(prefix) && r.key.endsWith(suffix));
        return found ? found.mk : null;
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
    'groupSkippedKeys'
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
              finalJsonStr = await decryptWithKey(key, parsedInit.data) as string;
          }

          const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
          importData = JSON.parse(finalJsonStr, (key, value) => {
            if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
              if (typeof value.data === 'string') {
                  return sodium.from_base64(value.data, sodium.base64_variants.URLSAFE_NO_PADDING);
              }
              return new Uint8Array(value.data);
            }
            return value;
          }) as Record<string, unknown[]>;
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
        'groupSkippedKeys'
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
