import { Dexie, type Table } from 'dexie';
import {
  normalizeMessageRow,
  type KvItem,
  type KvStore,
  type MessageRow,
  type MessageStore,
} from './types';

/**
 * Bentuk minimum database Dexie yang dipakai adapter. `db` dari
 * `lib/db.ts` memenuhi bentuk ini; tes kontrak memakai database sendiri agar
 * tidak menghapus data tes lain.
 */
export interface DexieStorageLike {
  kvStore: Table<KvItem, string>;
  messages: Table<MessageRow, string>;
}

export function createDexieKvStore(
  database: Pick<DexieStorageLike, 'kvStore'>,
): KvStore {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const item = await database.kvStore.get(key);
      return item?.value as T | undefined;
    },

    async put(item: KvItem): Promise<void> {
      await database.kvStore.put(item);
    },

    async delete(key: string): Promise<void> {
      await database.kvStore.delete(key);
    },

    async deleteByPrefix(prefix: string): Promise<void> {
      await database.kvStore.where('key').startsWith(prefix).delete();
    },

    async clear(): Promise<void> {
      await database.kvStore.clear();
    },

    async keys(): Promise<string[]> {
      return (await database.kvStore.toCollection().primaryKeys()) as string[];
    },
  };
}

export function createDexieMessageStore(
  database: Pick<DexieStorageLike, 'messages'>,
): MessageStore {
  return {
    async get(id: string): Promise<MessageRow | undefined> {
      return database.messages.get(id);
    },

    async put(row: MessageRow): Promise<void> {
      await database.messages.put(normalizeMessageRow(row));
    },

    async bulkPut(rows: MessageRow[]): Promise<void> {
      if (rows.length === 0) return;
      await database.messages.bulkPut(rows.map(normalizeMessageRow));
    },

    async delete(id: string): Promise<void> {
      await database.messages.delete(id);
    },

    async clear(): Promise<void> {
      await database.messages.clear();
    },

    async listByConversation(
      conversationId: string,
      options?: { limit?: number; beforeOrderBucketMs?: number },
    ): Promise<MessageRow[]> {
      const limit = options?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        return [];
      }

      const upper = options?.beforeOrderBucketMs ?? Dexie.maxKey;
      const collection = database.messages
        .where('[conversationId+orderBucketMs]')
        .between(
          [conversationId, Dexie.minKey],
          [conversationId, upper],
          true,
          true,
        )
        .reverse();
      const rows = limit === undefined
        ? await collection.toArray()
        : await collection.limit(limit).toArray();

      return rows.reverse();
    },

    async listAll(): Promise<MessageRow[]> {
      return database.messages.toArray();
    },

    async getMany(ids: string[]): Promise<MessageRow[]> {
      if (ids.length === 0) return [];
      const rows = await database.messages.bulkGet(ids);
      return rows.filter((row): row is MessageRow => !!row);
    },

    async deleteByConversation(conversationId: string): Promise<void> {
      await database.messages.where('conversationId').equals(conversationId).delete();
    },
  };
}
