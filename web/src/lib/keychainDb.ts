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

// Helper: Konversi Base64 <-> Uint8Array untuk di Browser
function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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
          ckString = bytesToBase64(record.state.CK);
      }
  }
  
  return record ? {
      conversationId: asConversationId(record.conversationId),
      CK: ckString,
      N: record.state.N
  } : null;
}

export async function saveGroupSenderState(state: GroupSenderState): Promise<void> {
  return enqueueWrite(async () => {
      // Sama seperti di atas, kita simpan sesuai schema yang baru (string)
      await db.groupSenderStates.put({
          conversationId: state.conversationId,
          state: { CK: state.CK, N: state.N }
      });
  });
}

export async function getGroupReceiverState(conversationId: string, senderId: string, senderDeviceKey?: string): Promise<GroupReceiverState | null> {
  const id = senderDeviceKey ? `${conversationId}_${senderId}_${senderDeviceKey}` : `${conversationId}_${senderId}`;
  const record = await db.groupReceiverStates.get(id);
  
  let ckString = '';
  if (record) {
      if (typeof record.state.CK === 'string') {
          ckString = record.state.CK;
      } else if ((record.state.CK as unknown) instanceof Uint8Array) {
          ckString = bytesToBase64(record.state.CK);
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
 * Retrieves and deletes a group skipped message key.
 */
export async function takeGroupSkippedKey(conversationId: string, senderId: string, senderDeviceKey: string, n: number): Promise<string | null> {
    return enqueueWrite(async () => {
        const key = `${conversationId}_${senderId}_${senderDeviceKey}_${n}`;
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
      await db.preKeys.put({ keyId, encryptedPrivateKey });
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

          importData = JSON.parse(finalJsonStr, (key, value) => {
            if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
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

      // --- DEVICE-SPECIFIC ENCRYPTION FOR HISTORY SYNC ---
      const { useAuthStore } = await import('@store/auth');
      const masterSeed = await useAuthStore.getState().getMasterSeed();

      if (importData['messageKeys']) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hasPlaintext = importData['messageKeys'].some((mk: any) => mk.plaintext);
          if (hasPlaintext) {
              if (!masterSeed) {
                  throw new Error("Missing master seed: Cannot securely import plaintext message keys.");
              }
              const { worker_encrypt_session_key } = await import('@lib/crypto-worker-proxy');
              for (const mk of importData['messageKeys']) {
                  const m = mk as { key: Uint8Array, plaintext?: string };
                  if (m.plaintext) {
                      // FIX: Safe native base64 decode in browser
                      const mkBytes = base64ToBytes(m.plaintext);
                      m.key = await worker_encrypt_session_key(mkBytes, masterSeed);
                      delete m.plaintext;
                  }
              }
          }
      }
      const { encryptVaultText } = await import('@lib/shadowVaultDb');
      if (importData['messages']) {
          for (const msg of importData['messages']) {
              const m = msg as { content?: string, fileMeta?: string, senderName?: string };
              if (m.content) m.content = await encryptVaultText(m.content);
              if (m.fileMeta) m.fileMeta = await encryptVaultText(m.fileMeta);
              if (m.senderName) m.senderName = await encryptVaultText(m.senderName);
          }
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
