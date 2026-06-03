import { pgTable, text, timestamp, integer, boolean, customType, index, primaryKey } from 'drizzle-orm/pg-core';

// Custom type for PostgreSQL bytea (binary data) which maps to Uint8Array in JS
const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value: unknown) {
    if (value instanceof Uint8Array) return value;
    if (value && typeof (value as any).byteLength === 'number') {
       const buffer = value as ArrayBuffer | SharedArrayBuffer | Uint8Array;
       if (buffer instanceof SharedArrayBuffer) {
           return new Uint8Array(buffer);
       }
       return new Uint8Array(buffer as ArrayBuffer | ArrayLike<number>);
    }
    if (typeof value === 'string') {
        let hex = value;
        if (hex.startsWith('\\x')) hex = hex.slice(2);
        else if (hex.startsWith('0x')) hex = hex.slice(2);
        
        const match = hex.match(/.{1,2}/g);
        return new Uint8Array(match ? match.map(byte => parseInt(byte, 16)) : []);
    }
    return new Uint8Array();
  },
  toDriver(value: Uint8Array) {
    return value;
  }
});

// 1. Messages (ShadowVault)
export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  senderId: text('sender_id').notNull(),
  content: bytea('content'), // Encrypted
  repliedToId: text('replied_to_id'),
  repliedTo: bytea('replied_to'), // Encrypted
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  status: text('status', { enum: ['sending', 'sent', 'delivered', 'read', 'failed'] }).default('sent'),
  senderName: bytea('sender_name'), // Encrypted
  senderUsername: bytea('sender_username'), // Encrypted
  senderAvatarUrl: bytea('sender_avatar_url'), // Encrypted
  isViewOnce: boolean('is_view_once').default(false),
  isDeletedLocal: boolean('is_deleted_local').default(false),
  fileMeta: bytea('file_meta'), // Encrypted
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
}, (table) => [
  index('idx_messages_conversation_created').on(table.conversationId, table.createdAt),
  index('idx_messages_sender').on(table.senderId),
  index('idx_messages_deleted').on(table.isDeletedLocal),
]);

// 2. Story Keys
export const storyKeys = pgTable('story_keys', {
  storyId: text('story_id').primaryKey(),
  key: bytea('key').notNull(),
});

// 3. Offline Queue
export const offlineQueue = pgTable('offline_queue', {
  tempId: integer('temp_id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  data: bytea('data').notNull(), // JSON stringified partial message (Encrypted)
  timestamp: integer('timestamp').notNull(),
  attempt: integer('attempt').default(0).notNull(),
}, (table) => [
  index('idx_offline_queue_timestamp').on(table.timestamp),
]);

// 4. Key-Value Store
export const kvStore = pgTable('kv_store', {
  key: text('key').primaryKey(),
  value: bytea('value').notNull(),
});

// 5. Session Keys (Signal Protocol)
export const sessionKeys = pgTable('session_keys', {
  storageKey: text('storage_key').primaryKey(), // conversationId_sessionId
  conversationId: text('conversation_id').notNull(),
  sessionId: text('session_id').notNull(),
  key: bytea('key').notNull(),
}, (table) => [
  index('idx_session_keys_conversation').on(table.conversationId),
]);

// 6. Group Keys
export const groupKeys = pgTable('group_keys', {
  conversationId: text('conversation_id').primaryKey(),
  key: bytea('key').notNull(),
});

// 7. One-Time Pre-Keys (OTPK)
export const preKeys = pgTable('pre_keys', {
  keyId: integer('key_id').primaryKey(),
  pqPublicKey: text('pq_public_key'),
  encryptedPrivateKey: bytea('encrypted_private_key').notNull(),
});

// 8. Identity Keys (Profile Keys)
export const identityKeys = pgTable('identity_keys', {
  userId: text('user_id').primaryKey(),
  key: bytea('key').notNull(),
});

// 9. Ratchet Sessions
export const ratchetSessions = pgTable('ratchet_sessions', {
  conversationId: text('conversation_id').primaryKey(),
  state: bytea('state').notNull(), // Encrypted serialized state
});

// 10. Group Sender States
export const groupSenderStates = pgTable('group_sender_states', {
  conversationId: text('conversation_id').primaryKey(),
  state: text('state').notNull(), // JSON stringified state
});

// 11. Group Receiver States
export const groupReceiverStates = pgTable('group_receiver_states', {
  id: text('id').primaryKey(), // conversationId_senderId
  state: text('state').notNull(), // JSON stringified state
});

// 12. Skipped Keys
export const skippedKeys = pgTable('skipped_keys', {
  headerKey: text('header_key').primaryKey(), // conversationId_kemPk_n
  key: bytea('key').notNull(),
});

// 13. Message Keys
export const messageKeys = pgTable('message_keys', {
  messageId: text('message_id').primaryKey(),
  key: bytea('key').notNull(),
});

// 14. Pending Headers
export const pendingHeaders = pgTable('pending_headers', {
  conversationId: text('conversation_id').primaryKey(),
  header: text('header').notNull(), // JSON stringified
});

// 15. Group Skipped Keys
export const groupSkippedKeys = pgTable('group_skipped_keys', {
  key: text('key').primaryKey(), // conversationId_senderId_n
  mk: text('mk').notNull(), // Base64 or JSON
});

// 16. PQ Double Ratchet Sessions
export const pqDrSessions = pgTable('pq_dr_sessions', {
  conversationId: text('conversation_id').primaryKey(),
  state: text('state').notNull(), // JSON stringified (encrypted by Vault)
  peerClassicalPk: text('peer_classical_pk'),
  peerDeviceId: text('peer_device_id'),
  version: integer('version').default(1),
  negotiationStatus: text('negotiation_status', { enum: ['INITIATED', 'ESTABLISHED', 'FAILED'] }),
  lastActivity: integer('last_activity'),
});
