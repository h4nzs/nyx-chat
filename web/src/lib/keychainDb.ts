
import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'keychain-db';
const SESSION_KEYS_STORE_NAME = 'session-keys';
const GROUP_KEYS_STORE_NAME = 'group-keys';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(SESSION_KEYS_STORE_NAME);
        }
        if (oldVersion < 2) {
          db.createObjectStore(GROUP_KEYS_STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
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
  console.log(`[keychainDb] Storing group key for conversation: ${conversationId}`);
  const db = await getDb();
  await db.put(GROUP_KEYS_STORE_NAME, key, conversationId);
}

/**
 * Retrieves the group key for a specific conversation.
 */
export async function getGroupKey(conversationId: string): Promise<Uint8Array | null> {
  console.log(`[keychainDb] Getting group key for conversation: ${conversationId}`);
  const db = await getDb();
  const key = (await db.get(GROUP_KEYS_STORE_NAME, conversationId)) || null;
  console.log(`[keychainDb] Key for ${conversationId}`, key ? 'found' : 'NOT found');
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
 * Clears all keys from the database. Used on logout.
 */
export async function clearAllKeys(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([SESSION_KEYS_STORE_NAME, GROUP_KEYS_STORE_NAME], 'readwrite');
  await tx.objectStore(SESSION_KEYS_STORE_NAME).clear();
  await tx.objectStore(GROUP_KEYS_STORE_NAME).clear();
  await tx.done;
}
