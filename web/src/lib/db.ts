import Dexie, { Table } from 'dexie';
import type { Message } from '@store/conversation';
import type { ConversationId, UserId, MessageId, StoryId } from '@nyx/shared';

// --- Interfaces for ShadowVault (Messages) ---
export interface DecryptedMessageRecord {
  id: MessageId;
  conversationId: ConversationId;
  content: string | null; // ENCRYPTED Base64 string at rest
  repliedToId?: MessageId;
  repliedTo?: string; // Encrypted JSON string of the replied message
  createdAt: string | Date;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  senderId: UserId;
  senderName?: string; // Encrypted sender name
  senderUsername?: string; // Encrypted sender username
  senderAvatarUrl?: string; // Encrypted avatar URL
  isViewOnce?: boolean;
  isDeletedLocal?: boolean;
  fileMeta?: string;
}

// --- Interfaces for OfflineQueue ---
export interface QueueItem {
  tempId: number;
  conversationId: string;
  data: Partial<Message>;
  timestamp: number;
  attempt: number;
}

// --- Interfaces for Keychain (Signal Protocol) ---
export interface SessionKey {
  storageKey: string; // conversationId_sessionId
  conversationId: ConversationId;
  sessionId: string;
  key: Uint8Array;
}

export interface GroupKey {
  conversationId: ConversationId;
  key: Uint8Array;
}

export interface PreKey {
  keyId: number;
  keyPair: Uint8Array; // Encrypted private key
}

export interface IdentityKey {
  userId: UserId;
  key: string; // Base64 public key
}

export interface RatchetSession {
  conversationId: ConversationId;
  state: Uint8Array;
}

export interface GroupSenderState {
  conversationId: ConversationId;
  state: {
    CK: string;
    N: number;
  };
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  state: {
    CK: string;
    N: number;
  };
}

export interface SkippedKey {
  headerKey: string;
  key: Uint8Array;
}

export interface MessageKey {
  messageId: MessageId;
  key: Uint8Array;
}

export interface PendingHeader {
  conversationId: ConversationId;
  header: Record<string, unknown>;
}

// --- Interface for KeyStorage (KV) ---
export interface KVItem {
  key: string;
  value: unknown;
}

export interface VaultEntry {
  key: unknown;
  value: unknown;
}

export class NyxDatabase extends Dexie {
  // ShadowVault
  messages!: Table<DecryptedMessageRecord, string>;
  storyKeys!: Table<{ storyId: StoryId; key: string }, string>;

  // OfflineQueue
  offlineQueue!: Table<QueueItem, number>;

  // KeyStorage (KV)
  kvStore!: Table<KVItem, string>;

  // Keychain (Signal)
  sessionKeys!: Table<SessionKey, string>;
  groupKeys!: Table<GroupKey, string>;
  preKeys!: Table<PreKey, number>; // OTPKs
  identityKeys!: Table<IdentityKey, string>; // Profile Keys
  ratchetSessions!: Table<RatchetSession, string>;
  groupSenderStates!: Table<GroupSenderState, string>;
  groupReceiverStates!: Table<GroupReceiverState, string>;
  skippedKeys!: Table<SkippedKey, string>;
  messageKeys!: Table<MessageKey, string>;
  pendingHeaders!: Table<PendingHeader, string>;
  groupSkippedKeys!: Table<{ key: string; mk: string }, string>;

  constructor() {
    super('NyxUnifiedDB');
    
    // Define schema
    this.version(1).stores({
      // ShadowVault
      messages: 'id, conversationId, [conversationId+createdAt], senderId, isDeletedLocal',
      storyKeys: 'storyId',

      // OfflineQueue
      offlineQueue: 'tempId, timestamp',

      // KeyStorage
      kvStore: 'key',

      // Keychain
      sessionKeys: 'storageKey, conversationId', // Indexed by storageKey (PK) and conversationId
      groupKeys: 'conversationId',
      preKeys: 'keyId',
      identityKeys: 'userId',
      ratchetSessions: 'conversationId',
      groupSenderStates: 'conversationId',
      groupReceiverStates: 'id',
      skippedKeys: 'headerKey',
      messageKeys: 'messageId',
      pendingHeaders: 'conversationId',
      groupSkippedKeys: 'key'
    });
  }
}

export const db = new NyxDatabase();
