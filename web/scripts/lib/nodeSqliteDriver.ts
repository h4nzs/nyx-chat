// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.11.6 P8] Driver `SqlDriver` di atas `node:sqlite` untuk drill
 * klien. Produksi memakai worker OPFS (`sqlite.worker.ts`); drill berjalan di
 * Node tanpa Worker/OPFS, jadi ia menyuntikkan driver sungguhan — bukan tabel
 * palsu — supaya store produksi (`createSqliteKvStore`, `createSqliteMessageStore`,
 * `initializeStorageSchema`) tetap yang diuji.
 *
 * Database memakai `:memory:`: setiap panggilan menghasilkan database baru dan
 * hilang saat `close()`, persis seperti perangkat pengganti yang kosong.
 */
import { DatabaseSync } from 'node:sqlite';

import type { SqlDriver, SqlStatement, SqlValue } from '../../src/lib/storage/types';

type Bind = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

const bind = (params?: SqlValue[]): Bind => (params ?? []) as Bind;

export function createNodeSqliteDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:');

  return {
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },

    async all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as T[];
    },

    async run(sql: string, params?: SqlValue[]): Promise<void> {
      db.prepare(sql).run(...bind(params));
    },

    async batch(statements: SqlStatement[]): Promise<void> {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of statements) {
          db.prepare(statement.sql).run(...bind(statement.params));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
