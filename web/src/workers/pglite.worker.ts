// [Bypass] Mencegah PGlite mendeteksi environment Node.js palsu dari Polyfill Vite
if (typeof process !== 'undefined' && process.versions) {
    try {
        Object.defineProperty(process.versions, 'node', { value: undefined, writable: true });
    } catch (e) {}
}

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../lib/db/schema';
import { sql, eq, and, desc, inArray } from 'drizzle-orm';

let pg: any;
let db: any;
let initError: Error | null = null;

async function init() {
  try {
    if (typeof indexedDB !== 'undefined') {
      try {
        console.warn('[pglite-worker] Purging legacy Dexie database...');
        indexedDB.deleteDatabase('NyxUnifiedDB');
      } catch (e) {
        console.warn('[pglite-worker] Failed to delete legacy Dexie database:', e);
      }
    }

    // STRICT OPFS - Tidak ada fallback!
    pg = await PGlite.create('opfs://nyx-chat-pg');
    db = drizzle(pg, { schema });

    await pg.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content BYTEA,
        replied_to_id TEXT,
        replied_to BYTEA,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL,
        status TEXT DEFAULT 'sent',
        sender_name BYTEA,
        sender_username BYTEA,
        sender_avatar_url BYTEA,
        is_view_once BOOLEAN DEFAULT FALSE,
        is_deleted_local BOOLEAN DEFAULT FALSE,
        file_meta BYTEA,
        expires_at TIMESTAMP WITH TIME ZONE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at);
      
      CREATE TABLE IF NOT EXISTS story_keys (
        story_id TEXT PRIMARY KEY,
        key BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS offline_queue (
        temp_id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        data BYTEA NOT NULL,
        timestamp INTEGER NOT NULL,
        attempt INTEGER DEFAULT 0 NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_offline_queue_timestamp ON offline_queue (timestamp);

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_keys (
        storage_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        key BYTEA NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_keys_conversation ON session_keys (conversation_id);

      CREATE TABLE IF NOT EXISTS group_keys (
        conversation_id TEXT PRIMARY KEY,
        key BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pre_keys (
        key_id INTEGER PRIMARY KEY,
        pq_public_key TEXT,
        encrypted_private_key BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_keys (
        user_id TEXT PRIMARY KEY,
        key BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ratchet_sessions (
        conversation_id TEXT PRIMARY KEY,
        state BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_sender_states (
        conversation_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_receiver_states (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skipped_keys (
        header_key TEXT PRIMARY KEY,
        key BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_keys (
        message_id TEXT PRIMARY KEY,
        key BYTEA NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_headers (
        conversation_id TEXT PRIMARY KEY,
        header TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_skipped_keys (
        key TEXT PRIMARY KEY,
        mk TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pq_dr_sessions (
        conversation_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        peer_classical_pk TEXT,
        peer_device_id TEXT,
        version INTEGER DEFAULT 1,
        negotiation_status TEXT,
        last_activity INTEGER
      );
    `);

    console.log('[pglite-worker] PGlite initialized successfully with OPFS.');
    self.postMessage({ type: 'READY' });
  } catch (err: any) {
    console.error('[pglite-worker] Initialization failed:', err);
    initError = err instanceof Error ? err : new Error(String(err));
    self.postMessage({ type: 'ERROR', error: initError.message });
  }
}

const initPromise = init();

function getTablePrimaryKey(targetTable: any) {
  for (const key in targetTable) {
    const col = targetTable[key];
    if (col && typeof col === 'object' && col.primary) {
      return col;
    }
  }
  return targetTable.id || targetTable.key || targetTable.keyId || targetTable.tempId || 
         targetTable.conversationId || targetTable.messageId || targetTable.storyId || 
         targetTable.userId || targetTable.storageKey || targetTable.headerKey;
}

self.onmessage = async (e) => {
  const { id, type, table, payload } = e.data;
  
  await initPromise;
  
  if (initError) {
    self.postMessage({ id, error: initError.message });
    return;
  }

  const targetTable = (schema as any)[table];

  if (!targetTable && type !== 'query_messages') {
    self.postMessage({ id, error: `Table ${table} not found in schema` });
    return;
  }

  try {
    let result;
    switch (type) {
      case 'insert':
        const pk = getTablePrimaryKey(targetTable);
        result = await db.insert(targetTable).values(payload).onConflictDoUpdate({
            target: pk,
            set: payload
        }).returning();
        break;
      
      case 'get':
        const getPk = getTablePrimaryKey(targetTable);
        result = await db.select().from(targetTable).where(eq(getPk, payload)).limit(1);
        result = result[0] || null;
        break;

      case 'delete':
        const delPk = getTablePrimaryKey(targetTable);
        await db.delete(targetTable).where(eq(delPk, payload));
        break;

      case 'delete_by_conversation':
        await db.delete(targetTable).where(eq(targetTable.conversationId, payload));
        break;

      case 'delete_by_prefix':
        const prefixPk = getTablePrimaryKey(targetTable);
        await db.delete(targetTable).where(sql`${prefixPk} LIKE ${payload + '%'}`);
        break;

      case 'list':
        result = await db.select().from(targetTable);
        break;

      case 'query_messages':
        const { conversationId, limit, beforeDate } = payload;
        let query = db.select().from(schema.messages)
            .where(
                and(
                    eq(schema.messages.conversationId, conversationId),
                    beforeDate ? sql`${schema.messages.createdAt} < ${beforeDate}` : sql`TRUE`
                )
            )
            .orderBy(desc(schema.messages.createdAt))
            .limit(limit);
        result = await query;
        break;

      case 'bulk_insert':
        if (!payload || payload.length === 0) {
            result = [];
            break;
        }
        await db.insert(targetTable).values(payload).onConflictDoUpdate({
            target: getTablePrimaryKey(targetTable),
            set: Object.keys(payload[0]).reduce((acc: any, key) => {
                acc[key] = sql.raw(`EXCLUDED.${targetTable[key]?.name || key}`);
                return acc;
            }, {})
        });
        break;

      case 'bulk_delete':
        const bulkDelPk = getTablePrimaryKey(targetTable);
        if (!payload || payload.length === 0) {
            break;
        }
        await db.delete(targetTable).where(inArray(bulkDelPk, payload));
        break;

      case 'clear_table':
        await db.delete(targetTable);
        break;
        
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    self.postMessage({ id, result });
  } catch (err: any) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
