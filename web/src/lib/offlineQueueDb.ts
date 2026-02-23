import { openDB, IDBPDatabase } from 'idb';
import { Message } from '@store/conversation';

const DB_NAME = 'offline-queue-db';
const STORE_NAME = 'message-queue';
const DB_VERSION = 1;

export interface QueueItem {
  tempId: number;
  conversationId: string;
  data: Partial<Message>;
  timestamp: number;
  attempt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'tempId' });
          store.createIndex('timestamp', 'timestamp');
        }
      },
    }).catch(err => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export async function addToQueue(conversationId: string, data: Partial<Message>, tempId: number): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, {
    tempId,
    conversationId,
    data,
    timestamp: Date.now(),
    attempt: 0,
  });
}

export async function getQueueItems(): Promise<QueueItem[]> {
  const db = await getDb();
  // Get all items sorted by timestamp (oldest first)
  return db.getAllFromIndex(STORE_NAME, 'timestamp');
}

export async function removeFromQueue(tempId: number): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, tempId);
}

export async function clearQueue(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE_NAME);
}

export async function updateQueueAttempt(tempId: number, attempt: number): Promise<void> {
  const db = await getDb();
  const item = await db.get(STORE_NAME, tempId);
  if (item) {
    item.attempt = attempt;
    await db.put(STORE_NAME, item);
  }
}
