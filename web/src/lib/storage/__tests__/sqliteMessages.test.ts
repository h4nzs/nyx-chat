/**
 * [docs/43 §43.11.6 B3] Orkestrasi pembaca SQLite: mirror tulis/hapus, baca
 * per percakapan/id, dan close worker. Tidak ada hidrasi dari Dexie.
 *
 * Driver worker diganti `node:sqlite` supaya tes ini tidak membutuhkan OPFS,
 * COOP/COEP, atau browser. VFS SQLite3MC sudah diuji terpisah di harness B1.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

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

const hoisted = vi.hoisted(() => ({
  driver: null as unknown,
  open: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../sqliteClient', () => ({
  SqliteWorkerClient: { open: hoisted.open },
}));

vi.mock('../dbKey', () => ({
  getSqliteMessagesKey: async () => new Uint8Array(32),
}));

vi.mock('../../localOrderKey', () => ({
  orderBucketOf: (value: string | Date | null | undefined) => {
    if (value === null || value === undefined) return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / (15 * 60 * 1000)) * 15 * 60 * 1000 : null;
  },
  resolveOrderInstants: async (rows: unknown[]) => rows.map(() => 0),
  pickOlderPage: (rows: unknown[], _instants: unknown[], limit: number) =>
    ({ page: limit ? rows.slice(-limit) : rows }),
}));

function nodeDriver(database: NodeDatabase) {
  const runNow = (sql: string, params: unknown[] = []) => {
    database.prepare(sql).run(...params);
  };

  return {
    async exec(sql: string) {
      database.exec(sql);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      runNow(sql, params);
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of statements) runNow(statement.sql, statement.params);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      hoisted.close();
      database.close();
    },
  };
}

vi.stubGlobal('Worker', class {});
vi.resetModules();

const sqlite = new DatabaseSync(':memory:');
hoisted.driver = nodeDriver(sqlite);
hoisted.open.mockImplementation(async () => hoisted.driver);

const messages = await import('../sqliteMessages');

afterAll(async () => {
  await messages.closeSqliteMessages();
  vi.unstubAllEnvs();
});

describe('sqliteMessages', () => {
  it('mirrors writes/deletes and reads through the contract', async () => {
    expect(await messages.readSqliteMessages('c1', 10)).toEqual([]);

    await messages.mirrorMessageRows([
      { id: 'm1', conversationId: 'c1', orderBucketMs: 100, content: 'satu' } as never,
      { id: 'm2', conversationId: 'c1', orderBucketMs: 200, content: 'dua' } as never,
    ]);

    expect((await messages.readSqliteMessages('c1', 10))?.map((row) => row.id))
      .toEqual(['m1', 'm2']);
    expect(await messages.readSqliteMessage('m2')).toMatchObject({
      available: true,
      row: { id: 'm2' },
    });
    expect((await messages.readAllSqliteMessages())?.map((row) => row.id))
      .toEqual(['m1', 'm2']);

    await messages.mirrorDeleteMessage('m1');
    expect((await messages.readSqliteMessages('c1', 10))?.map((row) => row.id))
      .toEqual(['m2']);

    await messages.mirrorDeleteConversation('c1');
    expect(await messages.readSqliteMessages('c1', 10)).toEqual([]);
  });

  it('closes the worker exactly once', async () => {
    await messages.closeSqliteMessages();
    expect(hoisted.close).toHaveBeenCalledTimes(1);
  });
});
