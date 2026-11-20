/**
 * [docs/43 §43.11.6 B2] Pembaca pesan SQLite.
 *
 * SQLite hanya menjadi sumber baca bila `VITE_SQLITE_MESSAGES=1`. Saat pertama
 * dibuka, baris Dexie disalin sekali (hidrasi); setiap tulis shadow vault
 * di-mirror ke SQLite. Bila OPFS/kunci tidak tersedia, fungsi baca mengembalikan
 * `null` dan shadow vault memakai Dexie — tidak ada fallback ke `:memory:`.
 */
import { db, type DecryptedMessageRecord } from '../db';
import { isExpiredMessageRow } from '../localAtRest';
import { orderBucketOf } from '../localOrderBucket';
import { pickOlderPage, resolveOrderInstants } from '../localOrderKey';
import type { MessageRow, MessageStore, KvStore, KeyStore } from './types';
import { getSqliteMessagesKey } from './dbKey';
import { createKeyStore } from './keyStore';
import { initializeStorageSchema } from './schema';
import { SqliteWorkerClient } from './sqliteClient';
import { createSqliteKvStore, createSqliteMessageStore } from './sqliteStores';
import { broadcastMessagesChanged } from '../dbBroadcast';

const ENABLED = import.meta.env.VITE_SQLITE_MESSAGES === '1';
const DB_NAME = '/nyx-messages.sqlite3';
const HYDRATED_KEY = 'sqlite:messages:hydrated:v1';
const READ_AHEAD = 32;

let client: SqliteWorkerClient | null = null;
let store: MessageStore | null = null;
let kv: KvStore | null = null;
let opening: Promise<MessageStore | null> | null = null;
let warned = false;
let degraded = false;

export function isSqliteMessagesEnabled(): boolean {
  return ENABLED;
}

/**
 * [docs/43 §43.11.6 B2] Keychain bertipe memakai klien & database yang SAMA
 * dengan pesan (satu worker, satu WAL). `KeyStore` hanya menyimpan byte; segel
 * `ENC1:` tetap tanggung jawab pemanggil. `null` = build tanpa
 * `VITE_SQLITE_MESSAGES=1`, OPFS/kunci tidak tersedia, atau store sudah
 * terdegradasi — pemanggil harus jatuh ke Dexie.
 */
export async function openSqliteKeyStore(): Promise<KeyStore | null> {
  const next = await openSqliteKvStore();
  return next ? createKeyStore(next) : null;
}

/**
 * [docs/43 §43.11.6 B2] Permukaan nilai untuk tabel non-pesan (contacts, KT)
 * pada database SQLite yang sama. `null` = flag mati, OPFS/kunci tidak
 * tersedia, atau store terdegradasi → pemanggil memakai Dexie.
 */
export async function openSqliteKvStore(): Promise<KvStore | null> {
  if (!ENABLED || degraded) return null;
  const next = await openStore();
  return next && kv ? kv : null;
}

function warn(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn('[SQLiteMessages] Tidak aktif; memakai Dexie:', error);
}

/** Kegagalan setelah store terbuka (mirror/baca) → jangan pakai SQLite lagi. */
function degrade(error: unknown): void {
  warn(error);
  degraded = true;
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

async function hydrate(nextStore: MessageStore, nextKv: KvStore): Promise<void> {
  if (await nextKv.get(HYDRATED_KEY) === true) return;
  const rows = await db.messages.toArray();
  await nextStore.bulkPut(rows.map(toMessageRow));
  await nextKv.put({ key: HYDRATED_KEY, value: true });
}

async function openStore(): Promise<MessageStore | null> {
  if (!ENABLED || degraded) return null;
  if (store) return store;
  if (opening) return opening;

  opening = (async () => {
    try {
      if (typeof Worker === 'undefined') return null;
      const key = await getSqliteMessagesKey();
      client = await SqliteWorkerClient.open({ key, dbName: DB_NAME });
      await initializeStorageSchema(client);
      const nextKv = createSqliteKvStore(client);
      const nextStore = createSqliteMessageStore(client);
      await hydrate(nextStore, nextKv);
      kv = nextKv;
      store = nextStore;
      return nextStore;
    } catch (error) {
      warn(error);
      try {
        await client?.close();
      } catch {
        // Worker mungkin sudah mati; error asli sudah dicatat.
      }
      client = null;
      store = null;
      kv = null;
      return null;
    } finally {
      opening = null;
    }
  })();

  return opening;
}

async function withStore(operation: (next: MessageStore) => Promise<void>): Promise<boolean> {
  if (!ENABLED) return false;
  try {
    const next = await openStore();
    if (!next) return false;
    await operation(next);
    return true;
  } catch (error) {
    degrade(error);
    return false;
  }
}

export async function mirrorMessageRows(rows: DecryptedMessageRecord[]): Promise<void> {
  if (!ENABLED || rows.length === 0) return;
  const written = await withStore((next) => next.bulkPut(rows.map(toMessageRow)));
  // [docs/43 §43.11.3] Tab lain membaca database OPFS yang sama; beri tahu
  // setelah tulisan benar-benar mendarat, bukan saat ia gagal.
  if (!written) return;
  for (const conversationId of new Set(rows.map((row) => row.conversationId))) {
    broadcastMessagesChanged(conversationId);
  }
}

export async function mirrorDeleteMessage(id: string): Promise<void> {
  // Hapus per id tidak membawa conversationId; `null` = cakupan tidak diketahui
  // sehingga penerima menyegarkan percakapan yang sedang terbuka.
  if (await withStore((next) => next.delete(id))) broadcastMessagesChanged(null);
}

export async function mirrorDeleteMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const written = await withStore(async (next) => {
    for (const id of ids) await next.delete(id);
  });
  if (written) broadcastMessagesChanged(null);
}

export async function mirrorDeleteConversation(conversationId: string): Promise<void> {
  if (await withStore((next) => next.deleteByConversation(conversationId))) {
    broadcastMessagesChanged(conversationId);
  }
}

export async function mirrorClearMessages(): Promise<void> {
  if (await withStore((next) => next.clear())) broadcastMessagesChanged(null);
}

export async function readSqliteMessages(
  conversationId: string,
  limit: number,
  beforeDate?: string,
): Promise<DecryptedMessageRecord[] | null> {
  const next = await openStore();
  if (!next) return null;

  try {
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
  } catch (error) {
    degrade(error);
    return null;
  }
}

export async function readSqliteMessage(
  id: string,
): Promise<{ available: boolean; row?: DecryptedMessageRecord }> {
  const next = await openStore();
  if (!next) return { available: false };

  try {
    const row = await next.get(id);
    return row ? { available: true, row: asRecord(row) } : { available: true };
  } catch (error) {
    degrade(error);
    return { available: false };
  }
}

export async function readAllSqliteMessages(): Promise<DecryptedMessageRecord[] | null> {
  const next = await openStore();
  if (!next) return null;

  try {
    return (await next.listAll()).map(asRecord);
  } catch (error) {
    degrade(error);
    return null;
  }
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
): Promise<DecryptedMessageRecord[] | null> {
  const next = await openStore();
  if (!next) return null;

  try {
    return await aliveRecords(await next.listByConversation(conversationId));
  } catch (error) {
    degrade(error);
    return null;
  }
}

export async function readSqliteMessagesByIds(
  ids: string[],
): Promise<DecryptedMessageRecord[] | null> {
  const next = await openStore();
  if (!next) return null;

  try {
    return await aliveRecords(await next.getMany(ids));
  } catch (error) {
    degrade(error);
    return null;
  }
}

export async function resetSqliteMessages(): Promise<void> {
  if (!ENABLED) return;
  // Wipe harus tetap mencoba walau sesi ini sudah terdegradasi.
  degraded = false;
  try {
    const next = await openStore();
    if (next) await next.clear();
  } catch (error) {
    degrade(error);
  }
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
  degraded = false;
  if (!active) return;
  try {
    await active.close();
  } catch {
    // Worker sudah berhenti; tidak ada state yang perlu diselamatkan.
  }
}
