import {
  normalizeMessageRow,
  type KvStore,
  type MessageRow,
  type MessageStore,
  type SqlDriver,
  type SqlStatement,
} from './types';

function encode(value: unknown, what: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`${what} harus JSON-serializable`);
  }
  return encoded;
}

function decode<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function messageStatement(input: MessageRow): SqlStatement {
  const row = normalizeMessageRow(input);
  return {
    sql: `INSERT INTO messages (id, conversationId, orderBucketMs, payload)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            conversationId = excluded.conversationId,
            orderBucketMs = excluded.orderBucketMs,
            payload = excluded.payload`,
    params: [
      row.id,
      row.conversationId,
      row.orderBucketMs ?? null,
      encode(row, 'message'),
    ],
  };
}

export function createSqliteKvStore(driver: SqlDriver): KvStore {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const rows = await driver.all<{ value: string }>(
        'SELECT value FROM kvStore WHERE key = ?',
        [key],
      );
      return rows[0] ? decode<T>(rows[0].value) : undefined;
    },

    async put(item): Promise<void> {
      await driver.run(
        `INSERT INTO kvStore (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [item.key, encode(item.value, 'kvStore value')],
      );
    },

    async delete(key: string): Promise<void> {
      await driver.run('DELETE FROM kvStore WHERE key = ?', [key]);
    },

    async clear(): Promise<void> {
      await driver.run('DELETE FROM kvStore');
    },

    async keys(): Promise<string[]> {
      const rows = await driver.all<{ key: string }>(
        'SELECT key FROM kvStore ORDER BY key ASC',
      );
      return rows.map((row) => row.key);
    },
  };
}

export function createSqliteMessageStore(driver: SqlDriver): MessageStore {
  return {
    async get(id: string): Promise<MessageRow | undefined> {
      const rows = await driver.all<{ payload: string }>(
        'SELECT payload FROM messages WHERE id = ?',
        [id],
      );
      return rows[0] ? decode<MessageRow>(rows[0].payload) : undefined;
    },

    async put(row: MessageRow): Promise<void> {
      const statement = messageStatement(row);
      await driver.run(statement.sql, statement.params);
    },

    async bulkPut(rows: MessageRow[]): Promise<void> {
      if (rows.length === 0) return;
      await driver.batch(rows.map(messageStatement));
    },

    async delete(id: string): Promise<void> {
      await driver.run('DELETE FROM messages WHERE id = ?', [id]);
    },

    async clear(): Promise<void> {
      await driver.run('DELETE FROM messages');
    },

    async listByConversation(
      conversationId: string,
      options?: { limit?: number; beforeOrderBucketMs?: number },
    ): Promise<MessageRow[]> {
      const limit = options?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        return [];
      }

      const before = options?.beforeOrderBucketMs;
      const params: (string | number)[] = [conversationId];
      let sql = `SELECT payload FROM messages
                 WHERE conversationId = ? AND orderBucketMs IS NOT NULL`;
      if (before !== undefined) {
        sql += ' AND orderBucketMs <= ?';
        params.push(before);
      }
      sql += ' ORDER BY orderBucketMs DESC, id DESC';
      if (limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(limit);
      }

      const rows = await driver.all<{ payload: string }>(sql, params);

      // Query mengambil yang terbaru dulu; kontrak mengembalikan lama → baru.
      return rows.reverse().map((row) => decode<MessageRow>(row.payload));
    },

    async listAll(): Promise<MessageRow[]> {
      const rows = await driver.all<{ payload: string }>(
        `SELECT payload FROM messages
         ORDER BY conversationId ASC, orderBucketMs ASC, id ASC`,
      );
      return rows.map((row) => decode<MessageRow>(row.payload));
    },

    async getMany(ids: string[]): Promise<MessageRow[]> {
      if (ids.length === 0) return [];
      const rows: MessageRow[] = [];
      // SQLite membatasi jumlah parameter per statement; chunk konservatif.
      for (let offset = 0; offset < ids.length; offset += 400) {
        const chunk = ids.slice(offset, offset + 400);
        const placeholders = chunk.map(() => '?').join(', ');
        const found = await driver.all<{ payload: string }>(
          `SELECT payload FROM messages WHERE id IN (${placeholders})`,
          chunk,
        );
        rows.push(...found.map((row) => decode<MessageRow>(row.payload)));
      }
      return rows;
    },

    async deleteByConversation(conversationId: string): Promise<void> {
      await driver.run('DELETE FROM messages WHERE conversationId = ?', [conversationId]);
    },
  };
}
