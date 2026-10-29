// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/39 §39.6] Drill "restore klien dari `.nyxbak`" terhadap dump nyata.
 *
 * Yang dibuktikan, dan kenapa perlu drill terpisah dari unit test:
 *   - Arsip dibuat dengan **jalur produksi** (`createFramedBackup` + KDF argon2id
 *     dari recovery phrase + XChaCha20-Poly1305 sungguhan + libsodium codec),
 *     bukan dengan backend palsu seperti di `backupRestore.test.ts`.
 *   - Baris yang dibackup **berasal dari dump Postgres yang benar-benar
 *     direstore** (`scripts/client-restore-drill.sh` menyiapkan klaster
 *     sementara + `pg_restore`), sehingga id percakapan/pesan, ciphertext, dan
 *     kunci publik perangkat adalah data nyata — bukan angka karangan.
 *   - Restore terjadi ke Dexie + IndexedDB nyata (`fake-indexeddb`, pola yang
 *     sama dengan `dexieMigration.test.ts`), lewat jalur yang dipakai
 *     `BackupRestoreModal` (`openFramedBackupWithPhrase`).
 *   - Kontrol negatif: phrase salah dan arsip yang dirusak 1 byte **ditolak**
 *     dan tidak menulis satu baris pun. Tanpa ini, "lulus" bisa berarti harness
 *     buta (kesalahan yang pernah terjadi di drill KT v2, docs/39 §39.6).
 *
 * Yang TIDAK dibuktikan (jujur): arsip ini **tidak** diekspor dari profil
 * browser sungguhan — tidak ada profil pengguna di mesin drill. Baris lokal
 * dibentuk dari dump dengan bentuk yang sama seperti yang ditulis klien
 * (kolom ter-seal `ENC1:`, `Uint8Array`, `Date`), jadi yang terbukti adalah
 * kesetiaan round-trip + keterkaitan dengan dump, bukan "klik Ekspor di UI".
 *
 * Jalankan lewat `scripts/client-restore-drill.sh` (menyiapkan dump + klaster),
 * atau langsung dengan fixture JSON yang sudah ada:
 *
 *   web/node_modules/.bin/tsx web/scripts/client-restore-drill.ts <fixture.json>
 */

import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Dexie from 'dexie';
import sodium from 'libsodium-wrappers';

import {
  BACKUP_HEADER_BYTES,
  BACKUP_KDF_PARAMS,
  deriveBackupKey,
  libsodiumBackupCrypto,
  parseBackupArchive,
  readBackupHeader,
} from '../src/lib/backupFormat';
import { libsodiumBackupValueCodec } from '../src/lib/backupPayload';
import {
  createFramedBackup,
  normalizeBackupPhrase,
  openFramedBackupWithPhrase,
  readTablesFromDexie,
  writeTablesToDexie,
} from '../src/lib/backupRestore';

// ── Fixture: potongan DB hasil restore ──────────────────────────────────────
interface FixtureDevice {
  id: string;
  userId: string;
  publicKeyB64: string;
  pqPublicKeyB64: string | null;
  signingKeyB64: string;
  signingKeyV2B64: string | null;
  encryptedPrivateKeyB64: string | null;
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
  type: string;
  createdAt: string;
}
interface Fixture {
  devices: FixtureDevice[];
  conversations: FixtureConversation[];
  messages: FixtureMessage[];
}

// ── Skema Dexie: hanya tabel yang ikut drill ────────────────────────────────
// Nama + keyPath **harus sama** dengan `web/src/lib/db.ts`, kalau tidak backup
// akan menulis ke tabel yang tidak ada atau mengurutkan dengan kunci salah.
const SCHEMA = {
  identityKeys: 'userId',
  preKeys: 'keyId',
  sessionKeys: 'storageKey, conversationId',
  contacts: 'userId',
  conversations: 'id',
  messages: 'id, conversationId, [conversationId+orderBucketMs]',
  messageKeys: 'messageId',
  kvStore: 'key',
} as const;

const TABLES = Object.keys(SCHEMA) as string[];

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

function makeDb(name: string): Dexie {
  const database = new Dexie(name);
  database.version(1).stores(SCHEMA);
  return database;
}

const b64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
/** Penanda nilai at-rest — drill tidak mendekripsi, hanya membuktikan byte utuh. */
const sealed = (plain: string): string => `ENC1:${Buffer.from(plain, 'utf8').toString('base64')}`;

/** Baris lokal seperti yang ditulis klien setelah sinkronisasi dari server. */
function localRowsFromDump(dump: Fixture) {
  const primaryDevice = dump.devices[0];
  const bucket = (iso: string) => Math.floor(new Date(iso).getTime() / (15 * 60_000)) * 15 * 60_000;

  return {
    identityKeys: dump.devices.map((device) => ({
      userId: device.userId,
      publicKey: b64(device.publicKeyB64),
      pqPublicKey: device.pqPublicKeyB64 ? b64(device.pqPublicKeyB64) : null,
      signingKey: b64(device.signingKeyB64),
      signingKeyV2: device.signingKeyV2B64 ? b64(device.signingKeyV2B64) : null,
      encryptedPrivateKey: device.encryptedPrivateKeyB64
        ? b64(device.encryptedPrivateKeyB64)
        : new Uint8Array(0),
      cryptoVersion: device.cryptoVersion,
      deviceId: device.id,
    })),
    preKeys: dump.devices.map((device, index) => ({
      keyId: `drill-${index}-${device.id}`,
      publicKey: b64(device.publicKeyB64),
      encryptedPrivateKey: b64(device.signingKeyB64),
    })),
    sessionKeys: dump.conversations.flatMap((conversation) =>
      dump.devices.map((device) => ({
        storageKey: `${conversation.id}:${device.id}`,
        conversationId: conversation.id,
        key: sealed(`session:${conversation.id}:${device.id}`),
      }))
    ),
    contacts: dump.devices.map((device) => ({
      userId: device.userId,
      data: sealed(JSON.stringify({ userId: device.userId, deviceId: device.id })),
    })),
    conversations: dump.conversations.map((conversation) => ({
      id: conversation.id,
      isGroup: sealed(String(conversation.isGroup)),
      encryptedMetadata: conversation.encryptedMetadata,
      decryptedMetadata: null,
      lastMessageAt: conversation.lastMessageAt ? new Date(conversation.lastMessageAt) : null,
      participants: sealed(JSON.stringify(dump.devices.map((device) => device.userId))),
      createdAt: new Date(conversation.createdAt),
    })),
    messages: dump.messages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      content: message.content,
      // Pesan 1:1 memakai sealed sender: kolom server NULL, kolom lokal ter-seal.
      senderId: sealed(message.senderId ?? 'sealed-sender'),
      createdAt: null,
      createdAtSealed: sealed(message.createdAt),
      orderBucketMs: bucket(message.createdAt),
      seq: message.seq,
      type: message.type,
      status: 'sent' as const,
      reactions: sealed('{}'),
      statuses: sealed('[]'),
      autoDelete: sealed('false'),
    })),
    messageKeys: dump.messages.map((message) => ({
      messageId: message.id,
      key: sealed(`mk:${message.id}`),
    })),
    kvStore: [
      {
        key: 'nyx_encrypted_keys',
        value: primaryDevice
          ? sealed(`identity-bundle:${primaryDevice.id}`)
          : sealed('identity-bundle'),
      },
    ],
  } as Record<string, Record<string, unknown>[]>;
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('usage: tsx web/scripts/client-restore-drill.ts <fixture.json>');
    process.exit(2);
  }
  const dump = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

  hdr('0. Fixture dari dump hasil restore');
  const messageIds = dump.messages.map((message) => message.id);
  const conversationIds = dump.conversations.map((conversation) => conversation.id);
  console.log(
    `  fixture: ${dump.conversations.length} percakapan, ${dump.messages.length} pesan, ` +
      `${dump.devices.length} perangkat`
  );
  if (!check(dump.conversations.length > 0 && dump.messages.length > 0, 'fixture berisi pesan', 'fixture kosong — tidak ada yang bisa dibuktikan')) {
    process.exit(1);
  }

  await sodium.ready;
  const crypto = libsodiumBackupCrypto(sodium);
  const codec = libsodiumBackupValueCodec(sodium);

  // ── 1. Perangkat lama: isi "IndexedDB" dengan baris dari dump ─────────────
  hdr('1. Perangkat lama menyimpan baris hasil sinkronisasi dari dump');
  const source = makeDb('drill_source');
  const rows = localRowsFromDump(dump);
  const expectedCounts: Record<string, number> = {};
  for (const table of TABLES) {
    const tableRows = rows[table] ?? [];
    if (tableRows.length > 0) expectedCounts[table] = tableRows.length;
    await source.table(table).bulkPut(tableRows);
  }
  const written = await readTablesFromDexie(source, TABLES);
  const writtenTotal = Object.values(written).reduce((sum, list) => sum + list.length, 0);
  const expectedTotal = Object.values(expectedCounts).reduce((sum, count) => sum + count, 0);
  check(writtenTotal === expectedTotal, `${writtenTotal} baris tertulis di ${TABLES.length} tabel`, `baris tertulis ${writtenTotal} ≠ ${expectedTotal}`);

  // ── 2. Ekspor .nyxbak: kunci dari recovery phrase (jalur BackupExportModal) ─
  hdr('2. Ekspor .nyxbak dengan kunci dari recovery phrase');
  // Phrase acak per jalannya drill — tidak dipakai ulang, tidak dicetak.
  const phrase = Array.from({ length: 12 }, () =>
    sodium.to_base64(sodium.randombytes_buf(24), sodium.base64_variants.URLSAFE_NO_PADDING)
  ).join('-');
  const salt = new Uint8Array(sodium.randombytes_buf(16));
  const exportKey = await deriveBackupKey(normalizeBackupPhrase(phrase), salt, BACKUP_KDF_PARAMS);
  const archive = await createFramedBackup({
    // `tables` WAJIB diberikan: default-nya seluruh `BACKUP_TABLE_ORDER` (20
    // tabel) dan Dexie drill hanya punya 8 — tanpa ini, ekspor mati dengan
    // `InvalidTableError: Table ratchetSessions does not exist`.
    tables: TABLES,
    store: { readTables: (tables, onProgress) => readTablesFromDexie(source, tables, onProgress) },
    key: exportKey,
    salt,
    crypto,
    codec,
  });
  const header = readBackupHeader(archive.bytes);
  check(header.formatVersion === 1, `header NYXB v${header.formatVersion}, ${archive.frameCount} frame, ${archive.size} byte`, `header tak terduga: ${JSON.stringify(header)}`);
  check(archive.records === expectedTotal, `${archive.records} catatan masuk arsip`, `arsip memuat ${archive.records} catatan ≠ ${expectedTotal}`);

  // ── 3. Perangkat pengganti: kosong, lalu restore dari berkas ──────────────
  hdr('3. Restore di perangkat pengganti (Dexie + IndexedDB nyata)');
  const target = makeDb('drill_target');
  let framesSeen = 0;
  const report = await openFramedBackupWithPhrase({
    store: {
      writeTables: (recordsByTable, onProgress) => writeTablesToDexie(target, recordsByTable, onProgress),
    },
    bytes: archive.bytes,
    phrase,
    crypto,
    codec,
    onProgress: (done) => {
      framesSeen = done;
    },
  });
  check(report.frameCount === archive.frameCount && framesSeen === archive.frameCount, `progres per frame mencapai ${framesSeen}/${archive.frameCount}`, `progres ${framesSeen}/${archive.frameCount} tidak mencapai akhir`);
  check(report.records === expectedTotal, `laporan restore: ${report.records} catatan di ${Object.keys(report.tables).length} tabel`, `laporan restore ${report.records} ≠ ${expectedTotal}`);
  const countsMatch = Object.keys({ ...report.tables, ...expectedCounts }).every(
    (table) => (report.tables[table] ?? 0) === (expectedCounts[table] ?? 0)
  );
  check(countsMatch, `jumlah per tabel sama dengan sumber (${JSON.stringify(expectedCounts)})`, `jumlah per tabel berbeda: ${JSON.stringify(report.tables)}`);

  // ── 4. Isi: baris per baris, byte per byte ────────────────────────────────
  hdr('4. Isi hasil restore identik dengan sumber');
  const restored = await readTablesFromDexie(target, TABLES);
  for (const table of TABLES) {
    const before = sortedRows(rows[table] ?? []);
    const after = sortedRows(restored[table] ?? []);
    const identical = stable(before) === stable(after);
    check(identical, `${table}: ${after.length} baris identik (byte, Date, ENC1 utuh)`, `${table}: isi berbeda setelah restore`);
  }
  const sealedIntact =
    (restored.messages ?? []).every((row) => String((row as Record<string, unknown>).senderId).startsWith('ENC1:')) &&
    (restored.kvStore ?? []).every((row) => String((row as Record<string, unknown>).value).startsWith('ENC1:'));
  check(sealedIntact, 'kolom at-rest tetap `ENC1:` (tidak didekripsi ulang oleh backup)', 'kolom at-rest berubah bentuk');

  const restoredBytes = (restored.identityKeys ?? []).map((row) =>
    Buffer.from((row as Record<string, unknown>).publicKey as Uint8Array).toString('base64')
  );
  const dumpBytes = dump.devices.map((device) => device.publicKeyB64);
  check(
    dumpBytes.every((key) => restoredBytes.includes(key)),
    `kunci publik perangkat dari dump byte-identik (${dumpBytes.length})`,
    'kunci publik perangkat tidak identik dengan dump'
  );

  // ── 5. Keterkaitan dengan dump: id dan ciphertext ─────────────────────────
  hdr('5. Silang-cek dengan dump yang sudah direstore');
  const restoredMessageIds = new Set((restored.messages ?? []).map((row) => (row as Record<string, unknown>).id as string));
  const restoredConversationIds = new Set((restored.conversations ?? []).map((row) => (row as Record<string, unknown>).id as string));
  check(messageIds.length > 0 && messageIds.every((id) => restoredMessageIds.has(id)), `semua ${messageIds.length} id pesan dump ada di klien`, 'ada id pesan dump yang hilang di klien');
  check(conversationIds.every((id) => restoredConversationIds.has(id)), `semua ${conversationIds.length} id percakapan dump ada di klien`, 'ada id percakapan dump yang hilang di klien');
  const contentMatch = dump.messages.every((message) =>
    (restored.messages ?? []).some(
      (row) =>
        (row as Record<string, unknown>).id === message.id &&
        (row as Record<string, unknown>).content === message.content
    )
  );
  check(contentMatch, 'ciphertext pesan di klien sama persis dengan kolom dump', 'ciphertext pesan berbeda dari dump');

  // ── 6. Ekspor ulang dari state hasil restore ──────────────────────────────
  // Yang dibandingkan adalah **urutan frame + isi payload**, bukan byte arsip:
  // tiap frame punya nonce acak (`buildBackupArchive`), jadi dua ekspor dari
  // data yang sama memang tidak pernah byte-identik. Determinisme yang diuji:
  // `export(restore(backup))` menghasilkan frame bertipe sama, dengan payload
  // sama, pada urutan (scramble) yang sama.
  hdr('6. Ekspor ulang dari perangkat pengganti');
  const reexport = await createFramedBackup({
    tables: TABLES,
    store: { readTables: (tables, onProgress) => readTablesFromDexie(target, tables, onProgress) },
    key: exportKey,
    salt,
    crypto,
    codec,
  });
  const frameSequence = (bytes: Uint8Array): string[] =>
    parseBackupArchive(bytes, exportKey, crypto).frames.map(
      (frame) => `${frame.type}:${createHash('sha256').update(Buffer.from(frame.payload)).digest('base64')}`
    );
  const firstSequence = frameSequence(archive.bytes);
  const secondSequence = frameSequence(reexport.bytes);
  check(
    reexport.size === archive.size && stable(firstSequence) === stable(secondSequence),
    `ekspor ulang: ${secondSequence.length} frame, urutan + payload identik (${reexport.size} byte)`,
    `ekspor ulang berbeda: ${secondSequence.length} frame vs ${firstSequence.length}, ukuran ${reexport.size} vs ${archive.size}`
  );

  // ── 7. Kontrol negatif ────────────────────────────────────────────────────
  hdr('7. Kontrol negatif (harus ditolak, tanpa menulis apa pun)');
  const negWrongPhrase = makeDb('drill_wrong_phrase');
  let wrongPhraseRejected = false;
  try {
    await openFramedBackupWithPhrase({
      store: { writeTables: (tables, onProgress) => writeTablesToDexie(negWrongPhrase, tables, onProgress) },
      bytes: archive.bytes,
      phrase: `${phrase}-salah`,
      crypto,
      codec,
    });
  } catch {
    wrongPhraseRejected = true;
  }
  const negRowsAfterPhrase = await negWrongPhrase.table('messages').count();
  check(wrongPhraseRejected, 'phrase salah → restore ditolak', 'phrase salah DITERIMA (bug autentikasi)');
  check(negRowsAfterPhrase === 0, 'phrase salah → 0 baris tertulis', `phrase salah menulis ${negRowsAfterPhrase} baris`);

  const negTampered = makeDb('drill_tampered');
  const tampered = archive.bytes.slice();
  // Rusak satu byte di dalam ciphertext frame pertama (setelah header).
  tampered[BACKUP_HEADER_BYTES + 24 + 4] = ((tampered[BACKUP_HEADER_BYTES + 24 + 4] ?? 0) ^ 0xff) & 0xff;
  let tamperRejected = false;
  try {
    await openFramedBackupWithPhrase({
      store: { writeTables: (tables, onProgress) => writeTablesToDexie(negTampered, tables, onProgress) },
      bytes: tampered,
      phrase,
      crypto,
      codec,
    });
  } catch {
    tamperRejected = true;
  }
  const negRowsAfterTamper = await negTampered.table('messages').count();
  check(tamperRejected, 'arsip dirusak 1 byte → restore ditolak', 'arsip rusak DITERIMA');
  check(negRowsAfterTamper === 0, 'arsip rusak → 0 baris tertulis', `arsip rusak menulis ${negRowsAfterTamper} baris`);

  await Promise.all([source.delete(), target.delete(), negWrongPhrase.delete(), negTampered.delete()]);

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
