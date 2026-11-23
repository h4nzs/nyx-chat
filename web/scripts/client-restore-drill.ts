/**
 * [docs/39 §39.6 / docs/43 §43.11.6 P8] Drill pemulihan klien `.nyxbak`
 * terhadap dump Postgres yang sudah direstore.
 *
 * Sejak B3 klien hanya punya satu backend (SQLite), jadi drill ini memakai
 * jalur produksi yang sebenarnya: `initializeStorageSchema`,
 * `createSqliteKvStore`, `createSqliteMessageStore`, `createFramedBackup`, dan
 * `openFramedBackupWithPhrase` dengan validasi arsip yang sama
 * (`assertRestorableBackupTables`). Bedanya hanya driver: `node:sqlite`
 * menggantikan worker OPFS, karena Node tidak punya OPFS/Worker. Tidak ada
 * tabel Dexie yang dipalsukan lagi — kalau format arsip berubah, drill ikut
 * gagal.
 *
 * Yang dibuktikan: arsip dibuat + dibaca lewat kodek produksi (argon2id,
 * XChaCha20-Poly1305), isi hasil restore identik byte-per-byte (termasuk semua
 * nilai `ENC1:` yang tidak boleh didekripsi/disegel ulang), ekspor ulang
 * menghasilkan frame yang sama, dan kontrol negatif (phrase salah, 1 byte
 * rusak) ditolak tanpa menulis apa pun.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sodium from 'libsodium-wrappers';

import {
  BACKUP_HEADER_BYTES,
  BACKUP_KDF_PARAMS,
  deriveBackupKey,
  libsodiumBackupCrypto,
  parseBackupArchive,
  readBackupHeader,
} from '../src/lib/backupFormat';
import { BACKUP_TABLE_ORDER, libsodiumBackupValueCodec } from '../src/lib/backupPayload';
import {
  assertRestorableBackupTables,
  createFramedBackup,
  normalizeBackupPhrase,
  openFramedBackupWithPhrase,
  type BackupStore,
} from '../src/lib/backupRestore';
import { initializeStorageSchema } from '../src/lib/storage/schema';
import { createSqliteKvStore, createSqliteMessageStore } from '../src/lib/storage/sqliteStores';
import type { KvStore, MessageRow, MessageStore, SqlDriver } from '../src/lib/storage/types';
import { createNodeSqliteDriver } from './lib/nodeSqliteDriver';

interface FixtureDevice {
  id: string;
  userId: string;
  publicKeyB64: string;
  pqPublicKeyB64: string | null;
  signingKeyB64: string;
  signingKeyV2B64: string;
  encryptedPrivateKeyB64: string;
  cryptoVersion: number;
}

interface FixtureConversation {
  id: string;
  isGroup: boolean;
  encryptedMetadata: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

interface FixtureMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  content: string | null;
  seq: number;
  type: string | null;
  createdAt: string;
}

interface Fixture {
  devices: FixtureDevice[];
  conversations: FixtureConversation[];
  messages: FixtureMessage[];
}

const BUCKET_MS = 15 * 60 * 1000;

/** Tabel yang benar-benar berisi di arsip era SQLite. */
const SQLITE_TABLES = ['sqliteMeta', 'sqliteKv', 'sqliteMessages'] as const;

// ── Pelaporan ───────────────────────────────────────────────────────────────
let failures = 0;
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const bad = (msg: string) => {
  failures += 1;
  console.log(`  GAGAL ${msg}`);
};
const hdr = (msg: string) => console.log(`\n== ${msg} ==`);

function check(condition: boolean, pass: string, fail: string): boolean {
  if (condition) ok(pass);
  else bad(fail);
  return condition;
}

/** Bentuk kanonik untuk perbandingan: byte → base64, Date → ISO, kunci urut. */
function canon(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $b: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return { $d: value.toISOString() };
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canon((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const stable = (value: unknown): string => JSON.stringify(canon(value));
const sortedRows = (rows: unknown[]): string[] => rows.map(stable).sort();

// ── Perangkat SQLite (driver node:sqlite, store produksi) ──────────────────
interface DrillDevice {
  driver: SqlDriver;
  kv: KvStore;
  messages: MessageStore;
}

async function openDevice(): Promise<DrillDevice> {
  const driver = createNodeSqliteDriver();
  await initializeStorageSchema(driver);
  return { driver, kv: createSqliteKvStore(driver), messages: createSqliteMessageStore(driver) };
}

const sealed = (plain: string) => `ENC1:${Buffer.from(plain, 'utf8').toString('base64')}`;
const b64 = (text: string) => Uint8Array.from(Buffer.from(text, 'base64'));

/**
 * Isi perangkat dari dump nyata. Baris mengikuti bentuk yang ditulis produksi:
 * pesan = record utuh di `payload`, tabel lain = record JSON di `kvStore`
 * dengan prefix `contacts:`/`conversation:`/`id:`/`pk:`, plus dua baris mentah
 * milik `appKv`/`keyStorage`.
 */
async function seedDevice(device: DrillDevice, fixture: Fixture): Promise<void> {
  const bucket = (iso: string) => Math.floor(Date.parse(iso) / BUCKET_MS) * BUCKET_MS;

  const messages: MessageRow[] = fixture.messages.map((message) => ({
    id: message.id,
    conversationId: message.conversationId,
    orderBucketMs: bucket(message.createdAt),
    seq: message.seq,
    type: message.type,
    status: 'sent',
    // Kolom dump bisa NULL (tombstone / pesan kosong) — jangan dipaksa jadi string.
    content: message.content ?? null,
    senderId: message.senderId === null ? null : sealed(message.senderId),
    createdAt: null,
    createdAtSealed: sealed(message.createdAt),
    reactions: sealed('[]'),
    statuses: sealed('{}'),
    autoDeleteSecs: sealed('0'),
  }));
  await device.messages.bulkPut(messages);

  for (const conversation of fixture.conversations) {
    await device.kv.put({
      key: `conversation:${conversation.id}`,
      value: {
        id: conversation.id,
        isGroup: sealed(String(conversation.isGroup)),
        participants: sealed('[]'),
        encryptedMetadata: conversation.encryptedMetadata,
        lastMessageAt: conversation.lastMessageAt ? sealed(conversation.lastMessageAt) : null,
        createdAt: sealed(conversation.createdAt),
      },
    });
  }

  for (const [index, drv] of fixture.devices.entries()) {
    await device.kv.put({
      key: `id:${drv.userId}`,
      value: { userId: drv.userId, key: drv.publicKeyB64 },
    });
    await device.kv.put({
      key: `pk:${1000 + index}`,
      value: {
        keyId: 1000 + index,
        pqPublicKey: drv.pqPublicKeyB64 == null ? null : b64(drv.pqPublicKeyB64),
        encryptedPrivateKey: sealed(drv.encryptedPrivateKeyB64),
      },
    });
    await device.kv.put({
      key: `contacts:${drv.userId}`,
      value: {
        userId: drv.userId,
        data: sealed(JSON.stringify({ userId: drv.userId, lastSeenAt: Date.now() })),
        updatedAt: sealed(new Date().toISOString()),
      },
    });
  }

  await device.kv.put({ key: 'nyx_theme', value: 'dark' });
  await device.kv.put({ key: 'nyx_encrypted_keys', value: sealed('drill-keychain-blob') });
}

/** Padanan `liveBackupStore().readTables` tanpa OPFS/Worker. */
async function readDeviceTables(
  device: DrillDevice,
  dbKey: Uint8Array,
  tables: string[],
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const kvRows: Array<{ key: string; value: unknown }> = [];
  const messageRows: MessageRow[] = await device.messages.listAll();
  for (const key of await device.kv.keys()) {
    kvRows.push({ key, value: await device.kv.get(key) });
  }
  for (const table of tables) {
    if (table === 'sqliteMeta') out[table] = [{ key: 'dbKey', value: dbKey }];
    else if (table === 'sqliteKv') out[table] = kvRows;
    else if (table === 'sqliteMessages') out[table] = messageRows;
    else out[table] = [];
  }
  return out;
}

/**
 * Padanan `liveBackupStore().writeTables` tanpa OPFS/Worker: memvalidasi arsip
 * dengan fungsi produksi, lalu menulis lewat store produksi ke database kosong.
 */
async function writeDeviceTables(
  device: DrillDevice,
  tables: Record<string, unknown[]>,
): Promise<Uint8Array> {
  assertRestorableBackupTables(tables);
  const meta = (tables.sqliteMeta ?? []).find(
    (row): row is { key: string; value: Uint8Array } =>
      !!row && typeof row === 'object' && (row as { key?: unknown }).key === 'dbKey',
  );
  const hasRows = (tables.sqliteKv?.length ?? 0) > 0 || (tables.sqliteMessages?.length ?? 0) > 0;
  if (hasRows && !meta) throw new Error('Backup berisi data SQLite tanpa kunci database');
  if (!meta) throw new Error('Backup tidak memuat kunci database SQLite');
  if (!(meta.value instanceof Uint8Array) || meta.value.length !== 32) {
    throw new Error('Kunci database SQLite di backup tidak sah');
  }

  await device.kv.clear();
  for (const row of (tables.sqliteKv ?? []) as Array<{ key: string; value: unknown }>) {
    await device.kv.put(row);
  }
  await device.messages.clear();
  await device.messages.bulkPut((tables.sqliteMessages ?? []) as MessageRow[]);
  return meta.value;
}

async function countDevice(device: DrillDevice): Promise<{ kv: number; messages: number }> {
  return {
    kv: (await device.kv.keys()).length,
    messages: (await device.messages.listAll()).length,
  };
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('Pakai: tsx client-restore-drill.ts <fixture.json>');
    process.exit(1);
  }
  const dump = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

  // ── 0. Fixture + cakupan tabel ────────────────────────────────────────────
  hdr('0. Fixture dump dan cakupan tabel arsip');
  const fixtureOk = check(
    dump.messages.length > 0 && dump.conversations.length > 0,
    `fixture: ${dump.messages.length} pesan, ${dump.conversations.length} percakapan, ${dump.devices.length} perangkat`,
    'fixture kosong (butuh pesan + percakapan)',
  );
  if (!fixtureOk) {
    console.log('\nADA 1 PEMERIKSAAN GAGAL — lihat baris GAGAL di atas.');
    process.exit(1);
  }
  const missing = SQLITE_TABLES.filter((table) => !BACKUP_TABLE_ORDER.includes(table));
  check(
    missing.length === 0,
    `arsip memuat tabel SQLite (${SQLITE_TABLES.join(', ')}) dari ${BACKUP_TABLE_ORDER.length} tabel`,
    `tabel arsip tidak lengkap: kurang ${missing.join(',')}`,
  );

  await sodium.ready;
  const crypto = libsodiumBackupCrypto(sodium);
  const codec = libsodiumBackupValueCodec(sodium);

  // ── 1. Bangun perangkat sumber dari dump ──────────────────────────────────
  hdr('1. Perangkat sumber (SQLite + store produksi)');
  const dbKey = crypto.randomBytes(32);
  const source = await openDevice();
  await seedDevice(source, dump);
  const sourceCounts = await countDevice(source);
  check(
    sourceCounts.messages === dump.messages.length,
    `${sourceCounts.messages} pesan tersimpan di SQLite`,
    `${sourceCounts.messages} pesan tersimpan, harusnya ${dump.messages.length}`,
  );
  check(sourceCounts.kv > 0, `${sourceCounts.kv} baris kvStore tersimpan`, 'kvStore kosong');
  const rows = await readDeviceTables(source, dbKey, BACKUP_TABLE_ORDER);
  const expectedCounts: Record<string, number> = Object.fromEntries(
    BACKUP_TABLE_ORDER.filter((table) => (rows[table]?.length ?? 0) > 0).map((table) => [
      table,
      rows[table]!.length,
    ]),
  );
  const expectedTotal = Object.values(expectedCounts).reduce((sum, n) => sum + n, 0);
  check(
    expectedTotal > 0,
    `sumber: ${expectedTotal} baris di ${Object.keys(expectedCounts).length} tabel (sisanya memang kosong)`,
    'sumber tidak punya baris untuk diarsipkan',
  );

  // ── 2. Ekspor .nyxbak lewat jalur produksi ────────────────────────────────
  hdr('2. Ekspor .nyxbak (createFramedBackup)');
  const phrase = Array.from({ length: 12 }, () =>
    Buffer.from(crypto.randomBytes(24)).toString('base64url'),
  ).join('-');
  const salt = crypto.randomBytes(16);
  const exportKey = await deriveBackupKey(normalizeBackupPhrase(phrase), salt, BACKUP_KDF_PARAMS);
  const archive = await createFramedBackup({
    tables: BACKUP_TABLE_ORDER,
    store: {
      readTables: (tables, onProgress) => readDeviceTables(source, dbKey, tables ?? BACKUP_TABLE_ORDER).then((out) => {
        onProgress?.(BACKUP_TABLE_ORDER.length, BACKUP_TABLE_ORDER.length);
        return out;
      }),
      writeTables: async () => {
        throw new Error('store baca-saja');
      },
    },
    key: exportKey,
    salt,
    crypto,
    codec,
  });
  check(
    readBackupHeader(archive.bytes).formatVersion === 1,
    `header format v1 (${archive.size} byte, ${archive.frameCount} frame)`,
    'header arsip bukan v1',
  );
  check(
    archive.records === expectedTotal,
    `${archive.records} catatan terarsip = ${expectedTotal} baris sumber`,
    `${archive.records} catatan terarsip ≠ ${expectedTotal}`,
  );

  // ── 3. Restore ke perangkat pengganti ─────────────────────────────────────
  hdr('3. Restore arsip (openFramedBackupWithPhrase)');
  const target = await openDevice();
  const store: BackupStore = {
    readTables: (tables, onProgress) =>
      readDeviceTables(target, dbKey, tables ?? BACKUP_TABLE_ORDER).then((out) => {
        onProgress?.(BACKUP_TABLE_ORDER.length, BACKUP_TABLE_ORDER.length);
        return out;
      }),
    writeTables: async (tables, onProgress) => {
      await writeDeviceTables(target, tables);
      onProgress?.(Object.keys(tables).length, Object.keys(tables).length);
    },
  };
  const framesSeen: number[] = [];
  const report = await openFramedBackupWithPhrase({
    store,
    bytes: archive.bytes,
    phrase,
    crypto,
    codec,
    onProgress: (done) => framesSeen.push(done),
  });
  check(
    report.frameCount === archive.frameCount && framesSeen.at(-1) === archive.frameCount,
    `progres per frame mencapai ${archive.frameCount}/${archive.frameCount}`,
    `progres ${framesSeen.at(-1) ?? 0}/${archive.frameCount} tidak mencapai akhir`,
  );
  check(
    report.records === expectedTotal,
    `laporan restore: ${report.records} catatan di ${Object.keys(report.tables).length} tabel`,
    `laporan restore ${report.records} ≠ ${expectedTotal}`,
  );
  const countsMatch = Object.keys({ ...report.tables, ...expectedCounts }).every(
    (table) => (report.tables[table] ?? 0) === (expectedCounts[table] ?? 0),
  );
  check(
    countsMatch,
    `jumlah per tabel sama dengan sumber (${JSON.stringify(expectedCounts)})`,
    `jumlah per tabel berbeda: ${JSON.stringify(report.tables)}`,
  );

  // ── 4. Isi hasil restore identik dengan sumber ────────────────────────────
  hdr('4. Isi hasil restore identik dengan sumber');
  const restored = await readDeviceTables(target, dbKey, BACKUP_TABLE_ORDER);
  for (const table of BACKUP_TABLE_ORDER) {
    const before = sortedRows(rows[table] ?? []);
    const after = sortedRows(restored[table] ?? []);
    check(
      stable(before) === stable(after),
      `${table}: ${after.length} baris identik (byte, Date, ENC1 utuh)`,
      `${table}: isi berbeda setelah restore`,
    );
  }
  const sealedValues = (tables: Record<string, unknown[]>): string[] =>
    Object.values(tables).flatMap((list) =>
      list.flatMap((row) => JSON.stringify(canon(row)).match(/ENC1:[A-Za-z0-9+/=_-]+/g) ?? []),
    );
  const sealedBefore = sealedValues(rows);
  const sealedAfter = new Set(sealedValues(restored));
  check(
    sealedBefore.length > 0 && sealedBefore.every((value) => sealedAfter.has(value)),
    `${sealedBefore.length} nilai \`ENC1:\` utuh di seluruh tabel (tidak didekripsi/disegel ulang)`,
    `ada nilai \`ENC1:\` yang berubah atau hilang (${sealedBefore.filter((value) => !sealedAfter.has(value)).length})`,
  );

  // ── 5. Keterkaitan dengan dump: id dan ciphertext ─────────────────────────
  hdr('5. Silang-cek dengan dump yang sudah direstore');
  const restoredMessages = (restored.sqliteMessages ?? []) as MessageRow[];
  const restoredKv = (restored.sqliteKv ?? []) as Array<{ key: string; value: unknown }>;
  const restoredMessageIds = new Set(restoredMessages.map((row) => row.id));
  const restoredConversationKeys = new Set(restoredKv.map((row) => row.key));
  check(
    dump.messages.every((message) => restoredMessageIds.has(message.id)),
    `semua ${dump.messages.length} id pesan dump ada di klien`,
    'ada id pesan dump yang hilang di klien',
  );
  check(
    dump.conversations.every((conversation) => restoredConversationKeys.has(`conversation:${conversation.id}`)),
    `semua ${dump.conversations.length} id percakapan dump ada di klien`,
    'ada id percakapan dump yang hilang di klien',
  );
  const contentMatch = dump.messages.every((message) =>
    restoredMessages.some((row) => row.id === message.id && row.content === message.content),
  );
  check(
    contentMatch,
    'ciphertext pesan di klien sama persis dengan kolom dump',
    'ciphertext pesan berbeda dari dump',
  );

  // ── 6. Ekspor ulang dari state hasil restore ──────────────────────────────
  hdr('6. Ekspor ulang dari perangkat pengganti');
  const reexport = await createFramedBackup({
    tables: BACKUP_TABLE_ORDER,
    store: {
      readTables: async (tables, onProgress) => {
        const out = await readDeviceTables(target, dbKey, tables ?? BACKUP_TABLE_ORDER);
        onProgress?.(BACKUP_TABLE_ORDER.length, BACKUP_TABLE_ORDER.length);
        return out;
      },
      writeTables: async () => {
        throw new Error('store baca-saja');
      },
    },
    key: exportKey,
    salt,
    crypto,
    codec,
  });
  const frameSequence = (bytes: Uint8Array): string[] =>
    parseBackupArchive(bytes, exportKey, crypto).frames.map(
      (frame) => `${frame.type}:${createHash('sha256').update(Buffer.from(frame.payload)).digest('base64')}`,
    );
  const firstSequence = frameSequence(archive.bytes);
  const secondSequence = frameSequence(reexport.bytes);
  check(
    reexport.size === archive.size && stable(firstSequence) === stable(secondSequence),
    `ekspor ulang: ${secondSequence.length} frame, urutan + payload identik (${reexport.size} byte)`,
    `ekspor ulang berbeda: ${secondSequence.length} frame vs ${firstSequence.length}, ukuran ${reexport.size} vs ${archive.size}`,
  );

  // ── 7. Kontrol negatif ────────────────────────────────────────────────────
  hdr('7. Kontrol negatif (harus ditolak, tanpa menulis apa pun)');
  const negWrongPhrase = await openDevice();
  let wrongPhraseRejected = false;
  try {
    await openFramedBackupWithPhrase({
      store: {
        readTables: async () => ({}),
        writeTables: async (tables) => {
          await writeDeviceTables(negWrongPhrase, tables);
        },
      },
      bytes: archive.bytes,
      phrase: `${phrase}-salah`,
      crypto,
      codec,
    });
  } catch {
    wrongPhraseRejected = true;
  }
  const negAfterPhrase = await countDevice(negWrongPhrase);
  check(wrongPhraseRejected, 'phrase salah → restore ditolak', 'phrase salah DITERIMA (bug autentikasi)');
  check(
    negAfterPhrase.kv === 0 && negAfterPhrase.messages === 0,
    'phrase salah → 0 baris tertulis',
    `phrase salah menulis ${negAfterPhrase.kv} baris kv + ${negAfterPhrase.messages} pesan`,
  );

  const negTampered = await openDevice();
  const tampered = archive.bytes.slice();
  // Rusak satu byte di dalam ciphertext frame pertama (setelah header).
  tampered[BACKUP_HEADER_BYTES + 24 + 4] = ((tampered[BACKUP_HEADER_BYTES + 24 + 4] ?? 0) ^ 0xff) & 0xff;
  let tamperRejected = false;
  try {
    await openFramedBackupWithPhrase({
      store: {
        readTables: async () => ({}),
        writeTables: async (tables) => {
          await writeDeviceTables(negTampered, tables);
        },
      },
      bytes: tampered,
      phrase,
      crypto,
      codec,
    });
  } catch {
    tamperRejected = true;
  }
  const negAfterTamper = await countDevice(negTampered);
  check(tamperRejected, 'arsip dirusak 1 byte → restore ditolak', 'arsip rusak DITERIMA');
  check(
    negAfterTamper.kv === 0 && negAfterTamper.messages === 0,
    'arsip rusak → 0 baris tertulis',
    `arsip rusak menulis ${negAfterTamper.kv} baris kv + ${negAfterTamper.messages} pesan`,
  );

  await Promise.all([source.driver.close(), target.driver.close(), negWrongPhrase.driver.close(), negTampered.driver.close()]);

  console.log('\n------------------------------------------------------------------');
  if (failures === 0) {
    console.log('SEMUA LULUS — klien pulih utuh dari .nyxbak terhadap dump yang direstore.');
    process.exit(0);
  }
  console.log(`ADA ${failures} PEMERIKSAAN GAGAL — lihat baris GAGAL di atas.`);
  process.exit(1);
}

main().catch((error) => {
  console.error('GAGAL drill berhenti:', error);
  process.exit(1);
});
