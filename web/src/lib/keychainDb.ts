
import { openDB, IDBPDatabase } from 'idb';

const SESSION_KEYS_STORE_NAME = 'session-keys';
const GROUP_KEYS_STORE_NAME = 'group-keys';
const OTPK_STORE_NAME = 'one-time-pre-keys';
const PENDING_HEADERS_STORE_NAME = 'pending-headers';
const RATCHET_SESSIONS_STORE_NAME = 'ratchet-sessions';
const SKIPPED_KEYS_STORE_NAME = 'skipped-keys';
const MESSAGE_KEYS_STORE_NAME = 'message-keys';
const PROFILE_KEYS_STORE_NAME = 'profile_keys';
const GROUP_SENDER_STATES_STORE = 'group_sender_states';
const GROUP_RECEIVER_STATES_STORE = 'group_receiver_states';
const DB_VERSION = 8;

export interface GroupSenderState {
  conversationId: string;
  CK: string;
  N: number;
}

export interface GroupReceiverState {
  id: string; // conversationId_senderId
  conversationId: string;
  senderId: string;
  CK: string;
  N: number;
  skippedKeys: { n: number, mk: string }[];
}

// Cache DB connections by userId to handle switching accounts without reloading
const dbCache = new Map<string, Promise<IDBPDatabase>>();

function getDb(): Promise<IDBPDatabase> {
  const savedUser = localStorage.getItem("user");
  const user = savedUser ? JSON.parse(savedUser) : null;
  const userId = user?.id;

  if (!userId) {
    // If called during logout after localStorage clear, we might want to fail gracefully
    // But ideally clearKeys should be called BEFORE clearing localStorage.
    return Promise.reject(new Error("Database access denied: No active user session found."));
  }

  if (!dbCache.has(userId)) {
    const dbName = `keychain-db-${userId}`;
    const promise = openDB(dbName, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(SESSION_KEYS_STORE_NAME);
        }
        if (oldVersion < 2) {
          db.createObjectStore(GROUP_KEYS_STORE_NAME);
        }
        if (oldVersion < 3) {
          // Store OTPKs by keyId (integer)
          db.createObjectStore(OTPK_STORE_NAME);
        }
        if (oldVersion < 4) {
          db.createObjectStore(PENDING_HEADERS_STORE_NAME);
        }
        if (oldVersion < 5) {
          db.createObjectStore(RATCHET_SESSIONS_STORE_NAME);
          db.createObjectStore(SKIPPED_KEYS_STORE_NAME);
        }
        if (oldVersion < 6) {
          db.createObjectStore(MESSAGE_KEYS_STORE_NAME);
        }
        if (oldVersion < 7) {
          if (!db.objectStoreNames.contains(PROFILE_KEYS_STORE_NAME)) {
             db.createObjectStore(PROFILE_KEYS_STORE_NAME);
          }
        }
        if (oldVersion < 8) {
          if (!db.objectStoreNames.contains(GROUP_SENDER_STATES_STORE)) {
             db.createObjectStore(GROUP_SENDER_STATES_STORE, { keyPath: 'conversationId' });
          }
          if (!db.objectStoreNames.contains(GROUP_RECEIVER_STATES_STORE)) {
             db.createObjectStore(GROUP_RECEIVER_STATES_STORE, { keyPath: 'id' });
          }
        }
      },
    }).catch(err => {
      dbCache.delete(userId);
      throw err;
    });
    dbCache.set(userId, promise);
  }
  
  return dbCache.get(userId)!;
}

// ... existing helpers ...

export async function getGroupSenderState(conversationId: string): Promise<GroupSenderState | null> {
  const db = await getDb();
  return (await db.get(GROUP_SENDER_STATES_STORE, conversationId)) || null;
}

export async function saveGroupSenderState(state: GroupSenderState): Promise<void> {
  const db = await getDb();
  await db.put(GROUP_SENDER_STATES_STORE, state);
}

export async function getGroupReceiverState(conversationId: string, senderId: string): Promise<GroupReceiverState | null> {
  const db = await getDb();
  const id = `${conversationId}_${senderId}`;
  return (await db.get(GROUP_RECEIVER_STATES_STORE, id)) || null;
}

export async function saveGroupReceiverState(state: GroupReceiverState): Promise<void> {
  const db = await getDb();
  await db.put(GROUP_RECEIVER_STATES_STORE, state);
}

export async function deleteGroupStates(conversationId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([GROUP_SENDER_STATES_STORE], 'readwrite');
  
  // ONLY Delete sender state (my own keys).
  // Do NOT delete receiver states, otherwise I can't read messages from others 
  // who haven't rotated their keys yet.
  await tx.objectStore(GROUP_SENDER_STATES_STORE).delete(conversationId);
  
  await tx.done;
}

export async function deleteGroupSenderState(conversationId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([GROUP_SENDER_STATES_STORE], 'readwrite');
  await tx.objectStore(GROUP_SENDER_STATES_STORE).delete(conversationId);
  await tx.done;
}

/**
 * Stores a pending X3DH header for a conversation.
 * Used when a session is created but no message has been sent yet.
 */
export async function storePendingHeader(conversationId: string, header: any): Promise<void> {
  const db = await getDb();
  await db.put(PENDING_HEADERS_STORE_NAME, header, conversationId);
}

/**
 * Retrieves a pending X3DH header.
 */
export async function getPendingHeader(conversationId: string): Promise<any | null> {
  const db = await getDb();
  return (await db.get(PENDING_HEADERS_STORE_NAME, conversationId)) || null;
}

/**
 * Deletes a pending X3DH header.
 */
export async function deletePendingHeader(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.delete(PENDING_HEADERS_STORE_NAME, conversationId);
}

/**
 * Stores a One-Time Pre-Key (private part) securely.
 */
export async function storeOneTimePreKey(keyId: number, encryptedPrivateKey: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.put(OTPK_STORE_NAME, encryptedPrivateKey, keyId);
}

/**
 * Retrieves a One-Time Pre-Key (private part) by ID.
 */
export async function getOneTimePreKey(keyId: number): Promise<Uint8Array | null> {
  const db = await getDb();
  return (await db.get(OTPK_STORE_NAME, keyId)) || null;
}

/**
 * Deletes a One-Time Pre-Key after use (for Forward Secrecy).
 */
export async function deleteOneTimePreKey(keyId: number): Promise<void> {
  const db = await getDb();
  await db.delete(OTPK_STORE_NAME, keyId);
}

/**
 * Gets the highest keyId currently in the store.
 * Useful for generating the next batch of keys.
 */
export async function getLastOtpkId(): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(OTPK_STORE_NAME, 'readonly');
  const store = tx.objectStore(OTPK_STORE_NAME);
  const cursor = await store.openKeyCursor(null, 'prev'); // 'prev' gets the last key first
  return (cursor?.key as number) || 0;
}

/**
 * Adds a session key to the keychain for a specific conversation.
 * The keychain for a conversation is an array of key objects.
 */
export async function addSessionKey(
  conversationId: string,
  sessionId: string,
  key: Uint8Array
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(SESSION_KEYS_STORE_NAME, 'readwrite');
  const store = tx.objectStore(SESSION_KEYS_STORE_NAME);
  const currentKeys = (await store.get(conversationId)) || [];
  
  // Avoid adding duplicate keys
  if (!currentKeys.some((k: any) => k.sessionId === sessionId)) {
    await store.put([...currentKeys, { sessionId, key }], conversationId);
  }
  await tx.done;
}

/**
 * Retrieves a specific session key from the keychain.
 */
export async function getSessionKey(
  conversationId: string,
  sessionId: string
): Promise<Uint8Array | null> {
  const db = await getDb();
  const keys = (await db.get(SESSION_KEYS_STORE_NAME, conversationId)) as any[];
  if (!keys) return null;
  
  const keyObj = keys.find(k => k.sessionId === sessionId);
  return keyObj ? keyObj.key : null;
}

/**
 * Retrieves the most recently added session key for a conversation.
 */
export async function getLatestSessionKey(
  conversationId: string
): Promise<{ sessionId: string; key: Uint8Array } | null> {
  const db = await getDb();
  const keys = (await db.get(SESSION_KEYS_STORE_NAME, conversationId)) as any[];
  if (!keys || keys.length === 0) return null;
  
  return keys[keys.length - 1]; // The last key is the latest
}

/**
 * Stores a group key for a specific conversation.
 * This overwrites any existing key for the conversation.
 */
export async function storeGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.put(GROUP_KEYS_STORE_NAME, key, conversationId);
}

/**
 * Retrieves the group key for a specific conversation.
 */
export async function getGroupKey(conversationId: string): Promise<Uint8Array | null> {
  const db = await getDb();
  const key = (await db.get(GROUP_KEYS_STORE_NAME, conversationId)) || null;
  return key;
}

/**
 * Stores a group key received from another user.
 * This is an alias for storeGroupKey for semantic clarity.
 */
export async function receiveGroupKey(conversationId: string, key: Uint8Array): Promise<void> {
  return storeGroupKey(conversationId, key);
}

/**
 * Deletes the group key for a specific conversation.
 */
export async function deleteGroupKey(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.delete(GROUP_KEYS_STORE_NAME, conversationId);
}

/**
 * Stores the encrypted RatchetState for a conversation.
 */
export async function storeRatchetSession(conversationId: string, encryptedState: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.put(RATCHET_SESSIONS_STORE_NAME, encryptedState, conversationId);
}

/**
 * Retrieves the encrypted RatchetState for a conversation.
 */
export async function getRatchetSession(conversationId: string): Promise<Uint8Array | null> {
  const db = await getDb();
  return (await db.get(RATCHET_SESSIONS_STORE_NAME, conversationId)) || null;
}

/**
 * Stores an encrypted skipped message key.
 */
export async function storeSkippedKey(headerKey: string, encryptedKey: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.put(SKIPPED_KEYS_STORE_NAME, encryptedKey, headerKey);
}

/**
 * Retrieves an encrypted skipped message key.
 */
export async function getSkippedKey(headerKey: string): Promise<Uint8Array | null> {
  const db = await getDb();
  return (await db.get(SKIPPED_KEYS_STORE_NAME, headerKey)) || null;
}

/**
 * Deletes a skipped message key.
 */
export async function deleteSkippedKey(headerKey: string): Promise<void> {
  const db = await getDb();
  await db.delete(SKIPPED_KEYS_STORE_NAME, headerKey);
}

/**
 * Stores an encrypted Message Key locally for history decryption.
 */
export async function storeMessageKey(messageId: string, encryptedMk: Uint8Array): Promise<void> {
  const db = await getDb();
  await db.put(MESSAGE_KEYS_STORE_NAME, encryptedMk, messageId);
}

/**
 * Retrieves an encrypted Message Key.
 */
export async function getMessageKey(messageId: string): Promise<Uint8Array | null> {
  const db = await getDb();
  return (await db.get(MESSAGE_KEYS_STORE_NAME, messageId)) || null;
}

/**
 * Deletes an encrypted Message Key locally.
 */
export async function deleteMessageKey(messageId: string): Promise<void> {
  const db = await getDb();
  await db.delete(MESSAGE_KEYS_STORE_NAME, messageId);
}

export async function saveProfileKey(userId: string, keyB64: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(PROFILE_KEYS_STORE_NAME, 'readwrite');
  await tx.objectStore(PROFILE_KEYS_STORE_NAME).put(keyB64, userId);
  await tx.done;
}

export async function getProfileKey(userId: string): Promise<string | undefined> {
  const db = await getDb();
  const tx = db.transaction(PROFILE_KEYS_STORE_NAME, 'readonly');
  return tx.objectStore(PROFILE_KEYS_STORE_NAME).get(userId);
}

/**
 * Clears all keys from the database. Used on logout.
 */
export async function clearAllKeys(): Promise<void> {
  const db = await getDb();
  const storeNames = db.objectStoreNames;
  const tx = db.transaction(storeNames, 'readwrite');
  
  for (const storeName of storeNames) {
      await tx.objectStore(storeName).clear();
  }
  await tx.done;
}

export interface VaultEntry {
  key: any;
  value: any;
}

/**
 * Mengekspor seluruh isi brankas kunci menjadi string JSON.
 * Aman karena setiap nilainya sudah terenkripsi oleh Master Seed.
 */
export async function exportDatabaseToJson(): Promise<string> {
  const db = await getDb();
  const stores = [
    SESSION_KEYS_STORE_NAME, GROUP_KEYS_STORE_NAME, OTPK_STORE_NAME, 
    PENDING_HEADERS_STORE_NAME, RATCHET_SESSIONS_STORE_NAME, 
    SKIPPED_KEYS_STORE_NAME, MESSAGE_KEYS_STORE_NAME, PROFILE_KEYS_STORE_NAME,
    GROUP_SENDER_STATES_STORE, GROUP_RECEIVER_STATES_STORE
  ];
  
  const exportData: Record<string, VaultEntry[]> = {};

  for (const storeName of stores) {
    if (!db.objectStoreNames.contains(storeName)) continue;
    
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const items: VaultEntry[] = [];
    let cursor = await store.openCursor();
    while (cursor) {
      items.push({ key: cursor.key, value: cursor.value });
      cursor = await cursor.continue();
    }
    exportData[storeName] = items;
  }
  
  return JSON.stringify(exportData, (key, value) => {
    // Custom replacer to preserve Uint8Array
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
  const db = await getDb();
  let importData: Record<string, VaultEntry[]>;
  try {
      importData = JSON.parse(jsonString, (key, value) => {
        // Custom reviver to restore Uint8Array
        if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
          return new Uint8Array(value.data);
        }
        return value;
      });
  } catch (e) {
      throw new Error("Invalid vault file format.");
  }

  const stores = [
    SESSION_KEYS_STORE_NAME, GROUP_KEYS_STORE_NAME, OTPK_STORE_NAME, 
    PENDING_HEADERS_STORE_NAME, RATCHET_SESSIONS_STORE_NAME, 
    SKIPPED_KEYS_STORE_NAME, MESSAGE_KEYS_STORE_NAME, PROFILE_KEYS_STORE_NAME,
    GROUP_SENDER_STATES_STORE, GROUP_RECEIVER_STATES_STORE
  ];
  
  const availableStores = stores.filter(s => db.objectStoreNames.contains(s));
  const tx = db.transaction(availableStores, 'readwrite');
  
  for (const storeName of availableStores) {
    const store = tx.objectStore(storeName);
    await store.clear(); // Selalu bersihkan brankas lama, bahkan jika importData[storeName] tidak ada
    if (importData[storeName]) {
      for (const item of importData[storeName]) {
        await store.put(item.value, item.key);
      }
    }
  }
  await tx.done;
}
