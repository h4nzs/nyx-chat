/**
 * [docs/43 §43.11.6 B3] Invarian skema SQLite — pengganti tes upgrade Dexie.
 *
 * Dexie sudah tidak ada di aplikasi, jadi yang perlu dikunci sekarang adalah
 * bentuk database yang benar-benar dipakai: dua tabel (kvStore, messages),
 * indeks bucket per percakapan, `user_version`, dan idempotensi migrasi
 * (`initializeStorageSchema` dipanggil setiap kali database dibuka).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { STORAGE_SCHEMA_VERSION, initializeStorageSchema } from '../schema';
import type { SqlDriver, SqlStatement, SqlValue } from '../types';

interface NodeStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabase;
};

function driverFor(database: NodeDatabase): SqlDriver {
  return {
    async exec(sql: string) {
      database.exec(sql);
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      database.prepare(sql).run(...params);
    },
    async batch(statements: SqlStatement[]) {
      for (const statement of statements) {
        database.prepare(statement.sql).run(...(statement.params ?? []));
      }
    },
  };
}

describe('skema SQLite', () => {
  it('idempoten dan menyimpan pesan per percakapan+bucket', async () => {
    const database = new DatabaseSync(':memory:');
    const driver = driverFor(database);

    await initializeStorageSchema(driver);
    await initializeStorageSchema(driver); // buka ulang tidak boleh gagal

    await driver.run(
      'INSERT INTO messages (id, conversationId, orderBucketMs, payload) VALUES (?, ?, ?, ?)',
      ['m1', 'c1', 900_000, '{"id":"m1"}'],
    );
    await driver.run(
      'INSERT INTO messages (id, conversationId, orderBucketMs, payload) VALUES (?, ?, ?, ?)',
      ['m2', 'c2', 1_800_000, '{"id":"m2"}'],
    );

    const scoped = await driver.all<{ id: string }>(
      'SELECT id FROM messages WHERE conversationId = ? AND orderBucketMs = ?',
      ['c1', 900_000],
    );
    expect(scoped).toEqual([{ id: 'm1' }]);

    const version = await driver.all<{ user_version: number }>('PRAGMA user_version');
    expect(version[0]?.user_version).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('kvStore memakai key sebagai primary key (upsert, bukan duplikat)', async () => {
    const database = new DatabaseSync(':memory:');
    const driver = driverFor(database);
    await initializeStorageSchema(driver);

    await driver.run('INSERT OR REPLACE INTO kvStore (key, value) VALUES (?, ?)', ['k', '"a"']);
    await driver.run('INSERT OR REPLACE INTO kvStore (key, value) VALUES (?, ?)', ['k', '"b"']);

    const rows = await driver.all<{ key: string; value: string }>('SELECT key, value FROM kvStore');
    expect(rows).toEqual([{ key: 'k', value: '"b"' }]);
  });
});
