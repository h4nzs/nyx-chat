/**
 * [docs/43 §43.11.6 B1/P7] Kontrak store dijalankan terhadap SQLite, satu-satunya
 * backend sejak Dexie dihapus. Sisi SQLite memakai `node:sqlite` in-memory
 * sebagai driver; yang diuji adalah skema + semantik store, bukan VFS OPFS atau
 * SQLite3MC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import type {
  KeyStore,
  KvStore,
  MessageRow,
  MessageStore,
  SqlDriver,
  SqlValue,
} from '../types';
import { initializeStorageSchema } from '../schema';
import {
  createSqliteKvStore,
  createSqliteMessageStore,
} from '../sqliteStores';
import { createKeyStore } from '../keyStore';

interface NodeStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabase;
};

interface Backend {
  kv: KvStore;
  keys: KeyStore;
  messages: MessageStore;
  close(): Promise<void>;
}

function nodeDriver(database: NodeDatabase): SqlDriver {
  const runNow = (sql: string, params: SqlValue[] = []) => {
    database.prepare(sql).run(...params);
  };

  return {
    async exec(sql) {
      database.exec(sql);
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql, params = []) {
      runNow(sql, params);
    },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of statements) {
          runNow(statement.sql, statement.params);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function createSqliteBackend(): Promise<Backend> {
  const database = new DatabaseSync(':memory:');
  const driver = nodeDriver(database);
  await initializeStorageSchema(driver);
  const kv = createSqliteKvStore(driver);
  return {
    kv,
    keys: createKeyStore(kv),
    messages: createSqliteMessageStore(driver),
    close: async () => database.close(),
  };
}

const rows: MessageRow[] = [
  { id: 'm1', conversationId: 'c1', orderBucketMs: 100, content: 'satu' },
  { id: 'm2', conversationId: 'c1', orderBucketMs: 300, content: 'tiga' },
  { id: 'm3', conversationId: 'c1', orderBucketMs: 200, content: 'dua' },
  { id: 'm4', conversationId: 'c2', orderBucketMs: 400, content: 'lain' },
];

describe('sqlite storage contract', () => {
  let backend: Backend;

  beforeEach(async () => {
    backend = await createSqliteBackend();
  });

  afterEach(async () => {
    await backend.close();
  });

  it('kvStore: put, overwrite, get, keys, delete, clear', async () => {
    expect(await backend.kv.get('missing')).toBeUndefined();

    await backend.kv.put({ key: 'b', value: { n: 2 } });
    await backend.kv.put({ key: 'a', value: 'satu' });

    expect(await backend.kv.get('b')).toEqual({ n: 2 });
    expect(await backend.kv.keys()).toEqual(['a', 'b']);

    await backend.kv.put({ key: 'b', value: [1, 2] });
    expect(await backend.kv.get('b')).toEqual([1, 2]);

    await backend.kv.delete('a');
    expect(await backend.kv.get('a')).toBeUndefined();
    expect(await backend.kv.keys()).toEqual(['b']);

    await backend.kv.clear();
    expect(await backend.kv.keys()).toEqual([]);
  });

  it('keys: byte round-trip, prefix listing, overwrite, delete, clear', async () => {
    await backend.keys.put('keychain:a', Uint8Array.of(0, 1, 2, 255));
    await backend.keys.put('keychain:b', Uint8Array.of(9));
    await backend.keys.put('other', Uint8Array.of(7));

    expect(Array.from((await backend.keys.get('keychain:a'))!))
      .toEqual([0, 1, 2, 255]);
    expect(await backend.keys.keys('keychain:')).toEqual(['keychain:a', 'keychain:b']);

    await backend.keys.put('keychain:a', Uint8Array.of(3));
    expect(Array.from((await backend.keys.get('keychain:a'))!)).toEqual([3]);

    await backend.keys.delete('keychain:b');
    expect(await backend.keys.get('keychain:b')).toBeUndefined();

    await backend.keys.clear();
    expect(await backend.keys.keys()).toEqual([]);
  });

  it('keys: rejects a corrupted value instead of returning garbage', async () => {
    await backend.kv.put({ key: 'broken', value: { v: 42 } });
    await expect(backend.keys.get('broken')).rejects.toThrow(/rusak/);
  });

  it('messages: bulkPut, get, conversation order, limit', async () => {
    await backend.messages.bulkPut(rows);

    expect(await backend.messages.get('m2')).toEqual(rows[1]);
    expect(await backend.messages.listByConversation('c1')).toEqual([
      rows[0],
      rows[2],
      rows[1],
    ]);
    expect(await backend.messages.listByConversation('c1', { limit: 2 })).toEqual([
      rows[2],
      rows[1],
    ]);
    expect(await backend.messages.listByConversation('c1', { limit: 0 })).toEqual([]);
    expect(await backend.messages.listByConversation('c1', {
      limit: 2,
      beforeOrderBucketMs: 200,
    })).toEqual([rows[0], rows[2]]);
    expect(await backend.messages.listByConversation('c2')).toEqual([rows[3]]);
    expect(await backend.messages.listByConversation('missing')).toEqual([]);

    const all = await backend.messages.listAll();
    expect(all.map((row) => row.id).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);

    const many = await backend.messages.getMany(['m1', 'missing', 'm3']);
    expect(many.map((row) => row.id).sort()).toEqual(['m1', 'm3']);
  });

  it('messages: a row without a bucket is readable but not listed', async () => {
    await backend.messages.put({
      id: 'legacy',
      conversationId: 'c1',
      orderBucketMs: null,
      content: 'tanpa bucket',
    });

    expect(await backend.messages.get('legacy')).toEqual({
      id: 'legacy',
      conversationId: 'c1',
      orderBucketMs: null,
      content: 'tanpa bucket',
    });
    expect(await backend.messages.listByConversation('c1')).toEqual([]);
  });

  it('messages: update preserves one row, delete and clear remove', async () => {
    await backend.messages.bulkPut(rows);
    const first = rows[0]!;
    await backend.messages.put({ ...first, content: 'diperbarui' });

    expect(await backend.messages.get('m1')).toEqual({
      ...first,
      content: 'diperbarui',
    });

    await backend.messages.delete('m2');
    expect(await backend.messages.get('m2')).toBeUndefined();
    expect((await backend.messages.listByConversation('c1')).map((row) => row.id))
      .toEqual(['m1', 'm3']);

    await backend.messages.deleteByConversation('c1');
    expect(await backend.messages.listByConversation('c1')).toEqual([]);
    expect(await backend.messages.listByConversation('c2')).toEqual([rows[3]]);

    await backend.messages.clear();
    expect(await backend.messages.listAll()).toEqual([]);
  });
});

describe('sqlite message bucket normalization', () => {
  it('stores a non-finite bucket as null and still returns the row', async () => {
    const database = new DatabaseSync(':memory:');
    const driver = nodeDriver(database);
    await initializeStorageSchema(driver);
    const store = createSqliteMessageStore(driver);

    await store.put({
      id: 'm1',
      conversationId: 'c1',
      orderBucketMs: Number.NaN,
      content: 'x',
    });

    expect(await store.get('m1')).toEqual({
      id: 'm1',
      conversationId: 'c1',
      orderBucketMs: null,
      content: 'x',
    });

    database.close();
  });
});
