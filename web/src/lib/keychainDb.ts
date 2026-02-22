
import { openDB, IDBPDatabase } from 'idb';

const SESSION_KEYS_STORE_NAME = 'session-keys';
const GROUP_KEYS_STORE_NAME = 'group-keys';
const OTPK_STORE_NAME = 'one-time-pre-keys';
const PENDING_HEADERS_STORE_NAME = 'pending-headers';
const DB_VERSION = 4;

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
      },
    });
    dbCache.set(userId, promise);
  }
  
  return dbCache.get(userId)!;
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
 * Clears all keys from the database. Used on logout.
 */
export async function clearAllKeys(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([SESSION_KEYS_STORE_NAME, GROUP_KEYS_STORE_NAME, OTPK_STORE_NAME, PENDING_HEADERS_STORE_NAME], 'readwrite');
  await tx.objectStore(SESSION_KEYS_STORE_NAME).clear();
  await tx.objectStore(GROUP_KEYS_STORE_NAME).clear();
  await tx.objectStore(OTPK_STORE_NAME).clear();
  await tx.objectStore(PENDING_HEADERS_STORE_NAME).clear();
  await tx.done;
}
