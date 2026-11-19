/// <reference lib="webworker" />
/**
 * [docs/43 §43.11.6 B1] Worker SQLite3MC di atas VFS `opfs`.
 *
 * Temuan 2026-11-18: `PRAGMA key` DITOLAK oleh VFS `opfs`/`opfs-sahpool`
 * ("Encryption is not supported by the VFS"). Database terenkripsi harus dibuka
 * lewat wrapper yang didaftarkan `sqlite3mc_vfs_create('opfs', 0)`, yaitu
 * `multipleciphers-opfs`. Dengan wrapper itu file benar-benar terenkripsi dan
 * kunci salah ditolak `SQLITE_NOTADB`.
 *
 * Kunci 32 byte dikirim dari main thread dan di-zero-kan setelah PRAGMA. Belum
 * ada penyimpanan kunci terbungkus masterSeed — itu bagian B2.
 */
import sqlite3InitModule, { type Sqlite3Static } from '@aztec-labs/sqlite3mc-wasm';
import { STORAGE_SCHEMA_SQL } from './schema';
import type { SqlStatement, SqlValue } from './types';

const OPFS_VFS = 'opfs';
const MC_VFS = `multipleciphers-${OPFS_VFS}`;
const DEFAULT_DB_NAME = '/nyx.sqlite3';

interface SqliteStatement {
  bind(params?: SqlValue[]): void;
  step(): boolean;
  finalize(): void;
}

interface SqliteConnection {
  exec(sql: string): void;
  selectObjects(sql: string, params?: SqlValue[]): Record<string, unknown>[];
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type WorkerRequest =
  | { id: number; type: 'open'; key: Uint8Array; dbName?: string }
  | { id: number; type: 'exec'; sql: string }
  | { id: number; type: 'all'; sql: string; params?: SqlValue[] }
  | { id: number; type: 'run'; sql: string; params?: SqlValue[] }
  | { id: number; type: 'batch'; statements: SqlStatement[] }
  | { id: number; type: 'close' };

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

let sqlite3: Sqlite3Static | undefined;
let database: SqliteConnection | undefined;
let vfsReady = false;

async function getSqlite(): Promise<Sqlite3Static> {
  if (!sqlite3) {
    sqlite3 = await sqlite3InitModule();
  }

  if (!vfsReady) {
    const capi = sqlite3.capi as unknown as {
      sqlite3mc_vfs_create?: (name: string, makeDefault: number) => number;
    };
    if (typeof capi.sqlite3mc_vfs_create !== 'function') {
      throw new Error('sqlite3mc_vfs_create tidak tersedia di build ini');
    }
    const rc = capi.sqlite3mc_vfs_create(OPFS_VFS, 0);
    if (rc !== 0) {
      throw new Error(`sqlite3mc_vfs_create('${OPFS_VFS}') gagal: rc ${rc}`);
    }
    vfsReady = true;
  }

  return sqlite3;
}

function requireDatabase(): SqliteConnection {
  if (!database) throw new Error('database SQLite belum dibuka');
  return database;
}

function runStatement(
  connection: SqliteConnection,
  sql: string,
  params: SqlValue[] = [],
): void {
  const statement = connection.prepare(sql);
  try {
    statement.bind(params);
    statement.step();
  } finally {
    statement.finalize();
  }
}

async function openDatabase(key: Uint8Array, dbName?: string): Promise<void> {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error('kunci database harus 32 byte');
  }
  const hex = Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join('');
  key.fill(0);

  const api = await getSqlite();
  database?.close();
  database = undefined;

  const open = api.oo1.DB as unknown as new (options: {
    filename: string;
    flags: string;
    vfs: string;
  }) => SqliteConnection;
  const connection = new open({
    filename: dbName ?? DEFAULT_DB_NAME,
    flags: 'c',
    vfs: MC_VFS,
  });

  try {
    connection.exec("PRAGMA cipher = 'chacha20';");
    connection.exec(`PRAGMA key = "x'${hex}'";`);
    connection.exec('PRAGMA busy_timeout = 5000;');
    connection.exec('PRAGMA foreign_keys = ON;');
    connection.exec('PRAGMA synchronous = FULL;');
    connection.exec(STORAGE_SCHEMA_SQL);
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Koneksi gagal dibuka; error asli tetap yang dilaporkan.
    }
    throw error;
  }

  database = connection;
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'open':
      await openDatabase(request.key, request.dbName);
      return undefined;
    case 'exec':
      requireDatabase().exec(request.sql);
      return undefined;
    case 'all':
      return requireDatabase().selectObjects(request.sql, request.params);
    case 'run':
      runStatement(requireDatabase(), request.sql, request.params);
      return undefined;
    case 'batch': {
      const connection = requireDatabase();
      connection.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of request.statements) {
          runStatement(connection, statement.sql, statement.params);
        }
        connection.exec('COMMIT');
      } catch (error) {
        try {
          connection.exec('ROLLBACK');
        } catch {
          // Rollback gagal berarti transaksi sudah tidak aktif; error asli
          // tetap yang dilaporkan.
        }
        throw error;
      }
      return undefined;
    }
    case 'close':
      database?.close();
      database = undefined;
      return undefined;
  }
}

async function handle(request: WorkerRequest): Promise<void> {
  const response: WorkerResponse = { id: request.id, ok: true };
  try {
    response.result = await dispatch(request);
  } catch (error) {
    response.ok = false;
    response.error = error instanceof Error ? error.message : String(error);
  }
  scope.postMessage(response);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
};
