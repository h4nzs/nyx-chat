/**
 * [docs/43 §43.11.6 B3] Penyimpanan pesan SQLite OPFS.
 *
 * Tidak ada hidrasi dari Dexie maupun fallback. Kegagalan membuka worker/kunci
 * dilempar ke pemanggil — aplikasi lebih baik gagal terlihat daripada diam-diam
 * menulis ke backend lain (atau ke `:memory:`). `shadowVaultDb` masih menulis
 * salinan Dexie untuk pembaca legacy; itu sisa B3, bukan jalur cadangan modul ini.
 */
import type { DecryptedMessageRecord } from '../db';
import { isExpiredMessageRow } from '../localAtRest';
import { orderBucketOf } from '../localOrderBucket';
import { pickOlderPage, resolveOrderInstants } from '../localOrderKey';
import type { MessageRow, MessageStore, KvStore, KeyStore } from './types';
import { getSqliteMessagesKey, persistSqliteMessagesKey } from './dbKey';
import { createKeyStore } from './keyStore';
import { initializeStorageSchema } from './schema';
import { SqliteWorkerClient } from './sqliteClient';
import { createSqliteKvStore, createSqliteMessageStore } from './sqliteStores';
import { broadcastMessagesChanged } from '../dbBroadcast';

const DB_NAME = '/nyx-messages.sqlite3';
const READ_AHEAD = 32;

let client: SqliteWorkerClient | null = null;
let store: MessageStore | null = null;
let kv: KvStore | null = null;
let opening: Promise<MessageStore> | null = null;

/**
 * [docs/43 §43.11.6 B3] Keychain bertipe memakai klien & database yang SAMA
 * dengan pesan (satu worker, satu WAL). `KeyStore` hanya menyimpan byte; segel
 * `ENC1:` tetap tanggung jawab pemanggil.
 */
export async function openSqliteKeyStore(): Promise<KeyStore> {
  return createKeyStore(await openSqliteKvStore());
}

/** Permukaan nilai untuk tabel non-pesan (contacts, KT) di database yang sama. */
export async function openSqliteKvStore(): Promise<KvStore> {
  await openStore();
  if (!kv) throw new Error('Tabel kvStore SQLite tidak tersedia');
  return kv;
}

/** [docs/43 §43.11.6 B3] Isi SQLite yang ikut `.nyxbak`. */
export interface SqliteBackupDump {
  /** Kunci DB saat dump; disimpan di frame `sqliteMeta` yang terenkripsi arsip. */
  key: Uint8Array;
  kv: Array<{ key: string; value: unknown }>;
  messages: MessageRow[];
}

/**
 * Baca seluruh database SQLite untuk backup. Error dilempar — backup yang
 * diam-diam kehilangan tabel bukan pilihan.
 */
export async function readSqliteBackup(): Promise<SqliteBackupDump> {
  const active = await openStore();
  if (!kv) throw new Error('Tabel kvStore SQLite tidak tersedia');

  const key = await getSqliteMessagesKey();
  const kvRows: Array<{ key: string; value: unknown }> = [];
  for (const name of await kv.keys()) {
    kvRows.push({ key: name, value: await kv.get(name) });
  }
  return { key, kv: kvRows, messages: await active.listAll() };
}

async function deleteSqliteOpfsDatabase(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('OPFS tidak tersedia untuk restore SQLite');
  }
  const root = await navigator.storage.getDirectory();
  const name = DB_NAME.replace(/^\//, '');
  for (const entry of [name, `${name}-journal`, `${name}-wal`, `${name}-shm`]) {
    try {
      await root.removeEntry(entry);
    } catch (error) {
      if ((error as { name?: string }).name !== 'NotFoundError') throw error;
    }
  }
}

/**
 * Tulis dump backup ke database SQLite **baru** memakai kunci dari arsip.
 * Database lama dihapus setelah seluruh baris divalidasi; kegagalan sebelum
 * titik itu tidak menyentuh apa pun.
 *
 * Restore berjalan sebelum vault terbuka, jadi kunci tidak bisa diturunkan dari
 * masterSeed. Kunci dari `sqliteMeta` hanya bisa dibaca setelah arsip lolos AEAD
 * phrase — tidak ada jalur plaintext tambahan.
 */
export async function restoreSqliteBackup(
  key: Uint8Array,
  kvRows: Array<{ key: string; value: unknown }>,
  messageRows: MessageRow[],
): Promise<void> {
  if (typeof Worker === 'undefined') {
    throw new Error('Worker SQLite tidak tersedia; restore SQLite tidak bisa dijalankan');
  }
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error('Kunci database SQLite di backup tidak sah');
  }
  for (const item of kvRows) {
    if (!item || typeof item.key !== 'string') {
      throw new Error('Baris sqliteKv di backup tidak sah');
    }
  }
  for (const row of messageRows) {
    if (!row || typeof row.id !== 'string' || typeof row.conversationId !== 'string') {
      throw new Error('Baris sqliteMessages di backup tidak sah');
    }
  }

  await closeSqliteMessages();
  await deleteSqliteOpfsDatabase();

  let active: SqliteWorkerClient | null = null;
  try {
    active = await SqliteWorkerClient.open({ key: key.slice(), dbName: DB_NAME });
    await initializeStorageSchema(active);
    const nextKv = createSqliteKvStore(active);
    const nextStore = createSqliteMessageStore(active);
    await nextKv.clear();
    for (const item of kvRows) await nextKv.put(item);
    await nextStore.clear();
    await nextStore.bulkPut(messageRows);
    // Database baru memakai kunci dari arsip; tanpa ini reload berikutnya
    // membuka DB dengan kunci perangkat yang salah (SQLITE_NOTADB).
    await persistSqliteMessagesKey(key);
    client = active;
    kv = nextKv;
    store = nextStore;
  } catch (error) {
    try {
      await active?.close();
    } catch {
      // Error asli tetap dilaporkan.
    }
    client = null;
    store = null;
    kv = null;
    throw error;
  }
}

function toMessageRow(row: DecryptedMessageRecord): MessageRow {
  const bucket = typeof row.orderBucketMs === 'number' && Number.isFinite(row.orderBucketMs)
    ? row.orderBucketMs
    : orderBucketOf(row.createdAt ?? null);
  return { ...row, orderBucketMs: bucket };
}

function asRecord(row: MessageRow): DecryptedMessageRecord {
  return row as unknown as DecryptedMessageRecord;
}

async function openStore(): Promise<MessageStore> {
  if (store) return store;
  if (opening) return opening;

  opening = (async () => {
    try {
      const key = await getSqliteMessagesKey();
      client = await SqliteWorkerClient.open({ key, dbName: DB_NAME });
      await initializeStorageSchema(client);
      kv = createSqliteKvStore(client);
      store = createSqliteMessageStore(client);
      return store;
    } catch (error) {
      try {
        await client?.close();
      } catch {
        // Worker mungkin sudah mati; error asli tetap dilaporkan.
      }
      client = null;
      store = null;
      kv = null;
      throw error;
    } finally {
      opening = null;
    }
  })();

  return opening;
}

async function withStore(operation: (next: MessageStore) => Promise<void>): Promise<void> {
  await operation(await openStore());
}

export async function mirrorMessageRows(rows: DecryptedMessageRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await withStore((next) => next.bulkPut(rows.map(toMessageRow)));
  // [docs/43 §43.11.3] Tab lain membaca database OPFS yang sama; beri tahu
  // setelah tulisan benar-benar mendarat, bukan saat ia gagal.
  for (const conversationId of new Set(rows.map((row) => row.conversationId))) {
    broadcastMessagesChanged(conversationId);
  }
}

export async function mirrorDeleteMessage(id: string): Promise<void> {
  // Hapus per id tidak membawa conversationId; `null` = cakupan tidak diketahui
  // sehingga penerima menyegarkan percakapan yang sedang terbuka.
  await withStore((next) => next.delete(id));
  broadcastMessagesChanged(null);
}

export async function mirrorDeleteMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withStore(async (next) => {
    for (const id of ids) await next.delete(id);
  });
  broadcastMessagesChanged(null);
}

export async function mirrorDeleteConversation(conversationId: string): Promise<void> {
  await withStore((next) => next.deleteByConversation(conversationId));
  broadcastMessagesChanged(conversationId);
}

export async function mirrorClearMessages(): Promise<void> {
  await withStore((next) => next.clear());
  broadcastMessagesChanged(null);
}

export async function readSqliteMessages(
  conversationId: string,
  limit: number,
  beforeDate?: string,
): Promise<DecryptedMessageRecord[]> {
  const next = await openStore();
  {
    const parsedBefore = beforeDate ? Date.parse(beforeDate) : Number.NaN;
    const beforeMs = Number.isFinite(parsedBefore) ? parsedBefore : null;
    const beforeBucket = beforeMs !== null ? orderBucketOf(beforeMs) : null;
    // Halaman pertama cukup `limit + READ_AHEAD`. Untuk kursor, ambil SELURUH
    // baris ≤ bucket kursor: `LIMIT` di dalam bucket batas bisa membuang baris
    // tertua dan membuat "muat pesan lama" berhenti sebelum riwayat habis.
    const rows = beforeMs === null
      ? await next.listByConversation(conversationId, { limit: limit + READ_AHEAD })
      : await next.listByConversation(conversationId, {
        beforeOrderBucketMs: beforeBucket ?? undefined,
      });

    const now = Date.now();
    const alive: MessageRow[] = [];
    for (const row of rows) {
      const expiry = row as {
        expiresAt?: string | number | null;
        autoDelete?: boolean | string | null;
      };
      if (!(await isExpiredMessageRow(expiry, now))) alive.push(row);
    }

    const records = alive.map(asRecord);
    const instants = await resolveOrderInstants(records);
    return pickOlderPage(records, instants, limit, beforeMs).page;
  }
}

export async function readSqliteMessage(
  id: string,
): Promise<{ available: boolean; row?: DecryptedMessageRecord }> {
  const row = await (await openStore()).get(id);
  return row ? { available: true, row: asRecord(row) } : { available: true };
}

export async function readAllSqliteMessages(): Promise<DecryptedMessageRecord[]> {
  return (await (await openStore()).listAll()).map(asRecord);
}

async function aliveRecords(rows: MessageRow[]): Promise<DecryptedMessageRecord[]> {
  const now = Date.now();
  const alive: MessageRow[] = [];
  for (const row of rows) {
    const expiry = row as {
      expiresAt?: string | number | null;
      autoDelete?: boolean | string | null;
    };
    if (!(await isExpiredMessageRow(expiry, now))) alive.push(row);
  }
  return alive.map(asRecord);
}

export async function readSqliteConversationRows(
  conversationId: string,
): Promise<DecryptedMessageRecord[]> {
  return aliveRecords(await (await openStore()).listByConversation(conversationId));
}

export async function readSqliteMessagesByIds(
  ids: string[],
): Promise<DecryptedMessageRecord[]> {
  return aliveRecords(await (await openStore()).getMany(ids));
}

export async function resetSqliteMessages(): Promise<void> {
  await (await openStore()).clear();
}

export async function closeSqliteMessages(): Promise<void> {
  const pending = opening;
  if (pending) {
    try {
      await pending;
    } catch {
      // Error open sudah dicatat di openStore.
    }
  }

  const active = client;
  client = null;
  store = null;
  kv = null;
  opening = null;
  if (!active) return;
  try {
    await active.close();
  } catch {
    // Worker sudah berhenti; tidak ada state yang perlu diselamatkan.
  }
}
