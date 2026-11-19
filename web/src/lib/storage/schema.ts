import type { SqlDriver } from './types';

/**
 * [docs/43 §43.11.4] Satu skema idempoten, bukan rantai versi Dexie.
 *
 * `PRAGMA key` (SQLite3MC) HARUS dijalankan sebelum `initializeStorageSchema`
 * pada database file. Skema ini sengaja tidak membuka file sendiri supaya
 * driver OPFS/worker yang memegang kunci.
 *
 * `journal_mode=WAL` dipertahankan untuk database file biasa. VFS OPFS tidak
 * mendukung WAL: `PRAGMA` itu jatuh ke `delete` (diukur 2026-11-18), jadi WAL
 * bukan jaminan di browser. `synchronous=FULL` tetap berlaku.
 */
export const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS kvStore (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY NOT NULL,
  conversationId  TEXT NOT NULL,
  orderBucketMs   INTEGER,
  payload         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_bucket
  ON messages (conversationId, orderBucketMs);

PRAGMA user_version = ${STORAGE_SCHEMA_VERSION};
`;

export async function initializeStorageSchema(driver: SqlDriver): Promise<void> {
  await driver.exec(STORAGE_SCHEMA_SQL);
}
