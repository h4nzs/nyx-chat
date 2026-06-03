import { dbRequest } from './base';
import { encryptField, decryptField } from '../encryption';
import type { ConversationId, MessageId, UserId } from '@nyx/shared';

export class KeychainRepository {
  // --- One-Time Pre-Keys ---
  static async savePreKey(keyId: number, encryptedPrivateKey: Uint8Array, pqPublicKey?: string): Promise<void> {
    const record = {
      keyId,
      pqPublicKey: pqPublicKey || null,
      encryptedPrivateKey: await encryptField(encryptedPrivateKey)
    };
    await dbRequest('insert', 'preKeys', record);
  }

  static async getPreKey(keyId: number): Promise<Uint8Array | null> {
    const r = await dbRequest('get', 'preKeys', keyId);
    if (!r) return null;
    const decrypted = await decryptField(r.encryptedPrivateKey);
    return decrypted as Uint8Array;
  }

  static async deletePreKey(keyId: number): Promise<void> {
      await dbRequest('delete', 'preKeys', keyId);
  }

  static async clearPreKeys(): Promise<void> {
      await dbRequest('clear_table', 'preKeys', null);
  }

  static async listPreKeys(): Promise<any[]> {
      return dbRequest('list', 'preKeys', null);
  }

  // --- Session Keys ---
  static async saveSessionKey(conversationId: string, sessionId: string, key: Uint8Array): Promise<void> {
    const storageKey = `${conversationId}_${sessionId}`;
    const record = {
      storageKey,
      conversationId,
      sessionId,
      key: await encryptField(key)
    };
    await dbRequest('insert', 'sessionKeys', record);
  }

  static async getSessionKey(conversationId: string, sessionId: string): Promise<Uint8Array | null> {
    const storageKey = `${conversationId}_${sessionId}`;
    const r = await dbRequest('get', 'sessionKeys', storageKey);
    if (!r) return null;
    const decrypted = await decryptField(r.key);
    return decrypted as Uint8Array;
  }

  static async deleteSessionKeys(conversationId: string): Promise<void> {
      // Need a where delete by conversationId in worker
      await dbRequest('delete_by_conversation', 'sessionKeys', conversationId);
  }

  // --- Ratchet Sessions ---
  static async saveRatchetSession(conversationId: string, state: Uint8Array): Promise<void> {
    const record = {
      conversationId,
      state: await encryptField(state)
    };
    await dbRequest('insert', 'ratchetSessions', record);
  }

  static async getRatchetSession(conversationId: string): Promise<Uint8Array | null> {
    const r = await dbRequest('get', 'ratchetSessions', conversationId);
    if (!r) return null;
    const decrypted = await decryptField(r.state);
    return decrypted as Uint8Array;
  }

  static async deleteRatchetSession(conversationId: string): Promise<void> {
      await dbRequest('delete', 'ratchetSessions', conversationId);
  }

  // --- Identity Keys ---
  static async saveIdentityKey(userId: string, keyB64: string): Promise<void> {
    const record = {
      userId,
      key: await encryptField(keyB64)
    };
    await dbRequest('insert', 'identityKeys', record);
  }

  static async getIdentityKey(userId: string): Promise<string | null> {
    const r = await dbRequest('get', 'identityKeys', userId);
    if (!r) return null;
    const decrypted = await decryptField(r.key);
    return decrypted as string;
  }

  // --- Group Keys ---
  static async saveGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
      const record = {
          conversationId,
          key: await encryptField(key)
      };
      await dbRequest('insert', 'groupKeys', record);
  }

  static async getGroupKey(conversationId: string): Promise<Uint8Array | null> {
      const r = await dbRequest('get', 'groupKeys', conversationId);
      if (!r) return null;
      const decrypted = await decryptField(r.key);
      return decrypted as Uint8Array;
  }

  static async deleteGroupKey(conversationId: string): Promise<void> {
      await dbRequest('delete', 'groupKeys', conversationId);
  }

  // --- Group States ---
  static async saveGroupSenderState(conversationIdOrState: string | any, possibleState?: any): Promise<void> {
      let conversationId: string;
      let state: any;
      
      if (typeof conversationIdOrState === 'string' && possibleState) {
          conversationId = conversationIdOrState;
          state = possibleState;
      } else if (typeof conversationIdOrState === 'object' && conversationIdOrState.conversationId) {
          conversationId = conversationIdOrState.conversationId;
          state = conversationIdOrState;
      } else {
          throw new Error('Invalid arguments to saveGroupSenderState');
      }

      const record = {
          conversationId,
          state: await encryptField(JSON.stringify(state))
      };
      await dbRequest('insert', 'groupSenderStates', record);
  }

  static async getGroupSenderState(conversationId: string): Promise<any | null> {
      const r = await dbRequest('get', 'groupSenderStates', conversationId);
      if (!r) return null;
      const decrypted = await decryptField(r.state);
      return JSON.parse(decrypted as string);
  }

  static async deleteGroupSenderState(conversationId: string): Promise<void> {
      await dbRequest('delete', 'groupSenderStates', conversationId);
  }

  static async saveGroupReceiverState(id: string, state: any): Promise<void> {
      const record = {
          id,
          state: await encryptField(JSON.stringify(state))
      };
      await dbRequest('insert', 'groupReceiverStates', record);
  }

  static async getGroupReceiverState(id: string): Promise<any | null> {
      const r = await dbRequest('get', 'groupReceiverStates', id);
      if (!r) return null;
      const decrypted = await decryptField(r.state);
      return JSON.parse(decrypted as string);
  }

  static async deleteGroupReceiverStates(conversationId: string): Promise<void> {
      await dbRequest('delete_by_prefix', 'groupReceiverStates', conversationId + '_');
  }

  // --- Skipped Keys ---
  static async saveSkippedKey(headerKey: string, key: Uint8Array): Promise<void> {
      const record = {
          headerKey,
          key: await encryptField(key)
      };
      await dbRequest('insert', 'skippedKeys', record);
  }

  static async getSkippedKey(headerKey: string): Promise<Uint8Array | null> {
      const r = await dbRequest('get', 'skippedKeys', headerKey);
      if (!r) return null;
      const decrypted = await decryptField(r.key);
      return decrypted as Uint8Array;
  }

  static async deleteSkippedKey(headerKey: string): Promise<void> {
      await dbRequest('delete', 'skippedKeys', headerKey);
  }

  // --- Group Skipped Keys ---
  static async saveGroupSkippedKey(key: string, mk: string): Promise<void> {
      const record = {
          key,
          mk: await encryptField(mk)
      };
      await dbRequest('insert', 'groupSkippedKeys', record);
  }

  static async getGroupSkippedKey(key: string): Promise<string | null> {
      const r = await dbRequest('get', 'groupSkippedKeys', key);
      if (!r) return null;
      const decrypted = await decryptField(r.mk);
      return decrypted as string;
  }

  static async deleteGroupSkippedKey(key: string): Promise<void> {
      await dbRequest('delete', 'groupSkippedKeys', key);
  }

  static async deleteGroupSkippedKeys(conversationId: string): Promise<void> {
      await dbRequest('delete_by_prefix', 'groupSkippedKeys', conversationId + '_');
  }

  // --- Message Keys ---
  static async saveMessageKey(messageId: string, key: Uint8Array): Promise<void> {
      const record = {
          messageId,
          key: await encryptField(key)
      };
      await dbRequest('insert', 'messageKeys', record);
  }

  static async getMessageKey(messageId: string): Promise<Uint8Array | null> {
      const r = await dbRequest('get', 'messageKeys', messageId);
      if (!r) return null;
      const decrypted = await decryptField(r.key);
      return decrypted as Uint8Array;
  }

  static async deleteMessageKey(messageId: string): Promise<void> {
      await dbRequest('delete', 'messageKeys', messageId);
  }

  // --- Pending Headers ---
  static async savePendingHeader(conversationId: string, header: Record<string, unknown>): Promise<void> {
      const record = {
          conversationId,
          header: await encryptField(JSON.stringify(header))
      };
      await dbRequest('insert', 'pendingHeaders', record);
  }

  static async getPendingHeader(conversationId: string): Promise<Record<string, unknown> | null> {
      const r = await dbRequest('get', 'pendingHeaders', conversationId);
      if (!r) return null;
      const decrypted = await decryptField(r.header);
      return JSON.parse(decrypted as string);
  }

  static async deletePendingHeader(conversationId: string): Promise<void> {
      await dbRequest('delete', 'pendingHeaders', conversationId);
  }

  // --- PQ Double Ratchet Sessions ---
  static async savePqDrSession(conversationId: string, state: any): Promise<void> {
      const record = {
          conversationId,
          state: await encryptField(JSON.stringify(state.state)),
          peerClassicalPk: state.peerClassicalPk,
          peerDeviceId: state.peerDeviceId,
          version: state.version,
          negotiationStatus: state.negotiationStatus,
          lastActivity: state.lastActivity
      };
      await dbRequest('insert', 'pqDrSessions', record);
  }

  static async getPqDrSession(conversationId: string): Promise<any | null> {
      const r = await dbRequest('get', 'pqDrSessions', conversationId);
      if (!r) return null;
      const decryptedState = await decryptField(r.state);
      return {
          ...r,
          state: JSON.parse(decryptedState as string)
      };
  }

  static async deletePqDrSession(conversationId: string): Promise<void> {
      await dbRequest('delete', 'pqDrSessions', conversationId);
  }

  static async hasPqDrSession(conversationId: string): Promise<boolean> {
      const r = await dbRequest('get', 'pqDrSessions', conversationId);
      return !!r;
  }

  static async clearAll(): Promise<void> {
      const tables = [
        'sessionKeys', 'groupKeys', 'preKeys', 'identityKeys', 
        'ratchetSessions', 'groupSenderStates', 'groupReceiverStates', 
        'skippedKeys', 'messageKeys', 'pendingHeaders', 'groupSkippedKeys', 'pqDrSessions'
      ];
      await Promise.all(tables.map(t => dbRequest('clear_table', t, null)));
  }
}
