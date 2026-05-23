import { openDB, IDBPDatabase } from 'idb';
import type { INyxStorage } from './types.js';

const DB_VERSION = 2; // Incremented for new store

export class IndexedDBStorage implements INyxStorage {
  private dbPromise: Promise<IDBPDatabase>;
  
  constructor(tenantId: string) {
    const dbName = `nyx-engine-keystore-${tenantId}`;
    this.dbPromise = openDB(dbName, DB_VERSION, {
      upgrade(db) {
        // Create object stores adapted from the B2C keychainDb schema
        const stores = [
          'sessionKeys',
          'groupKeys',
          'preKeys',
          'identityKeys',
          'ratchetSessions',
          'groupSenderStates',
          'groupReceiverStates',
          'skippedKeys',
          'messageKeys',
          'pendingHeaders',
          'groupSkippedKeys',
          'pqDrSessions',
          'offline_outbox'
        ];

        for (const store of stores) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store);
          }
        }
      },
    });
  }

  async get<T>(storeName: string, key: string): Promise<T | null> {
    const db = await this.dbPromise;
    const value = await db.get(storeName, key);
    return value !== undefined ? value as T : null;
  }

  async set<T>(storeName: string, key: string, value: T): Promise<void> {
    const db = await this.dbPromise;
    await db.put(storeName, value, key);
  }

  async remove(storeName: string, key: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(storeName, key);
  }

  async clear(storeName: string): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(storeName);
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    const db = await this.dbPromise;
    return await db.getAll(storeName);
  }
}
