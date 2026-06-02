import { PGlite } from '@electric-sql/pglite';
import { drizzle, PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from '../lib/db/schema';
import { sql, eq, and, desc } from 'drizzle-orm';

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

async function init() {
  try {
    // Destructive Dexie cleanup (Reset IndexedDB)
    if (typeof indexedDB !== 'undefined') {
      console.warn('[pglite-worker] Purging legacy Dexie database...');
      indexedDB.deleteDatabase('NyxUnifiedDB');
    }

    pg = new PGlite('opfs://nyx-chat-pg');
    db = drizzle(pg, { schema });

    // Initial schema creation (Since we are in destructive migration mode)
    // In production, we'd use migrations.
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
    self.postMessage({ type: 'ERROR', error: err.message });
  }
}

const initPromise = init();

function getTablePrimaryKey(targetTable: any) {
  // Try to find the primary key column from the table metadata
  // In Drizzle, we can look at the table object
  const columns = (targetTable as any)[Symbol.for('drizzle:Columns')];
  if (columns) {
    for (const [name, col] of Object.entries(columns)) {
      if ((col as any).primary) return col;
    }
  }
  // Fallback to common names if metadata is tricky
  return targetTable.id || targetTable.key || targetTable.keyId || targetTable.tempId || 
         targetTable.conversationId || targetTable.messageId || targetTable.storyId || 
         targetTable.userId || targetTable.storageKey || targetTable.headerKey || 
         targetTable.temp_id || targetTable.conversation_id || targetTable.message_id || 
         targetTable.story_id || targetTable.user_id || targetTable.storage_key || 
         targetTable.header_key;
}

self.onmessage = async (e) => {
  await initPromise;
  const { id, type, table, payload } = e.data;
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
        await db.delete(targetTable).where(eq(targetTable.conversation_id || targetTable.conversationId, payload));
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
        await db.insert(targetTable).values(payload).onConflictDoUpdate({
            target: targetTable.id ?? targetTable.key ?? targetTable.keyId ?? targetTable.tempId ?? targetTable.conversationId ?? targetTable.messageId ?? targetTable.storyId ?? targetTable.userId ?? targetTable.storageKey ?? targetTable.headerKey,
            set: Object.keys(payload[0]).reduce((acc: any, key) => ({ ...acc, [key]: sql`EXCLUDED.${sql.identifier(key)}` }), {})
        });
        break;

      case 'bulk_delete':
        const bulkDelPk = getTablePrimaryKey(targetTable);
        await db.delete(targetTable).where(sql`${bulkDelPk} IN ${payload}`);
        break;

      case 'clear_table':
        await db.delete(targetTable);
        break;
        
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    self.postMessage({ id, result });
  } catch (err: any) {
    self.postMessage({ id, error: err.message });
  }
};
