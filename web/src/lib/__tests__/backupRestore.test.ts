// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 4 / docs/31 §31.6c] Orkestrasi restore `.nyxbak`.
 *
 * Kripto yang dipakai SUNGGUHAN (libsodium + arsip ber-frame); hanya
 * *penyimpanan* yang dipalsukan — unit test tidak boleh butuh IndexedDB/Worker.
 *
 * Properti yang dikunci:
 *   1. Roundtrip build → restore mempertahankan nilai biner/Date/at-rest.
 *   2. Progres dilaporkan per frame (jumlah panggilan = frameCount).
 *   3. Kunci salah / phrase salah ditolak sebelum database disentuh.
 *   4. Tabel kosong → arsip kosong ditolak (bukan restore "sukses" senyap).
 *   5. Arsip klien pra-SQLite ditolak, bukan restore "sukses" tanpa data.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';

import {
  BACKUP_KDF_PARAMS,
  BackupFormatError,
  libsodiumBackupCrypto,
} from '../backupFormat';
import {
  BACKUP_TABLE_ORDER,
  libsodiumBackupValueCodec,
  type BackupValueCodec,
} from '../backupPayload';
import {
  assertRestorableBackupTables,
  averageFrameBytes,
  createFramedBackup,
  formatBackupSize,
  normalizeBackupPhrase,
  openFramedBackupWithPhrase,
  restoreFramedBackup,
  type BackupStore,
} from '../backupRestore';

/** Param KDF kecil supaya test cepat; parameter produksi dipin di `backupFormat.test.ts`. */
const TEST_KDF = { ...BACKUP_KDF_PARAMS, memorySize: 64, iterations: 2 } as const;
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

let codec: BackupValueCodec;
let cryptoBackend: ReturnType<typeof libsodiumBackupCrypto>;

beforeAll(async () => {
  await sodium.ready;
  codec = libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);
  cryptoBackend = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
});

function normalize(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength));
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

const sampleRecords = () => ({
  identityKeys: [{ userId: 'u2', key: 'b' }, { userId: 'u1', key: 'a' }],
  sessionKeys: [{ storageKey: 'c1_s1', conversationId: 'c1', sessionId: 's1', key: new Uint8Array([1, 2, 3, 250]) }],
  conversations: [{ id: 'c1', isGroup: false, lastMessageAt: new Date('2026-10-11T00:00:00.000Z'), participants: 'ENC1:xxx' }],
  messages: [{ id: 'm1', conversationId: 'c1', content: 'ENC1:abc', createdAt: '2026-10-11T00:00:00.000Z', seq: 7 }],
  contacts: [{ userId: 'u1', data: 'ENC1:contact', updatedAt: 1 }],
  kvStore: [{ key: 'locale', value: 'id' }],
});

/** Store in-memory: hanya penyimpanan yang dipalsukan, kripto tetap nyata. */
function memoryStore(seed: Record<string, unknown[]> = {}): BackupStore & { data: Record<string, unknown[]> } {
  const data: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(seed)) data[table] = rows.slice();
  return {
    data,
    readTables: async (tables = BACKUP_TABLE_ORDER) => {
      const out: Record<string, unknown[]> = {};
      for (const table of tables) out[table] = (data[table] ?? []).slice();
      return out;
    },
    writeTables: async (recordsByTable) => {
      for (const [table, rows] of Object.entries(recordsByTable)) data[table] = rows.slice();
    },
  };
}

/** Bandingkan isi backup tanpa peduli urutan (build mengurutkan menurut kunci primer). */
function sortedBy(rows: unknown[], keyPath: string): string[] {
  return (normalize(rows) as Array<Record<string, unknown>>)
    .map((row) => JSON.stringify(row[keyPath]) + '|' + JSON.stringify(row))
    .sort();
}

describe('backupRestore: roundtrip arsip ber-frame', () => {
  it('build → restore mempertahankan biner, Date, dan nilai ENC1 apa adanya', async () => {
    const key = sodium.randombytes_buf(BACKUP_KDF_PARAMS.hashLength);
    const source = memoryStore(sampleRecords());
    const built = await createFramedBackup({ store: source, key, crypto: cryptoBackend, codec });

    const target = memoryStore();
    const report = await restoreFramedBackup({ store: target, bytes: built.bytes, key, crypto: cryptoBackend, codec });

    expect(report.records).toBe(7);
    expect(report.tables).toEqual({ identityKeys: 2, sessionKeys: 1, conversations: 1, messages: 1, contacts: 1, kvStore: 1 });
    expect(report.frameCount).toBeGreaterThan(0);
    expect(report.size).toBe(built.bytes.length);

    const original = sampleRecords();
    for (const table of Object.keys(original) as Array<keyof ReturnType<typeof sampleRecords>>) {
      const keyPath = table === 'identityKeys' ? 'userId'
        : table === 'sessionKeys' ? 'storageKey'
          : table === 'conversations' ? 'id'
            : table === 'messages' ? 'id'
              : table === 'contacts' ? 'userId'
                : 'key';
      expect(sortedBy(target.data[table]!, keyPath)).toEqual(sortedBy(original[table]!, keyPath));
    }
  });

  it('melaporkan progres per frame dengan total = frameCount', async () => {
    const key = sodium.randombytes_buf(BACKUP_KDF_PARAMS.hashLength);
    const source = memoryStore(sampleRecords());
    const built = await createFramedBackup({ store: source, key, crypto: cryptoBackend, codec });

    const calls: Array<[number, number]> = [];
    await restoreFramedBackup({
      store: memoryStore(),
      bytes: built.bytes,
      key,
      crypto: cryptoBackend,
      codec,
      onProgress: (done, total) => calls.push([done, total]),
    });

    expect(calls).toHaveLength(built.frameCount);
    expect(calls[0]).toEqual([1, built.frameCount]);
    expect(calls[calls.length - 1]).toEqual([built.frameCount, built.frameCount]);
    // Progres monotonik.
    for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBeGreaterThan(calls[i - 1]![0]);
  });

  it('menolak kunci salah sebelum menyentuh database', async () => {
    const key = sodium.randombytes_buf(BACKUP_KDF_PARAMS.hashLength);
    const built = await createFramedBackup({ store: memoryStore(sampleRecords()), key, crypto: cryptoBackend, codec });

    const target = memoryStore();
    let wrote = false;
    const guarded: BackupStore = {
      readTables: target.readTables,
      writeTables: async (records) => { wrote = true; await target.writeTables(records); },
    };

    await expect(
      restoreFramedBackup({ store: guarded, bytes: built.bytes, key: sodium.randombytes_buf(32), crypto: cryptoBackend, codec })
    ).rejects.toThrow(/Autentikasi frame gagal/);
    expect(wrote).toBe(false);
  });

  it('menolak arsip kosong (tidak ada restore "sukses" senyap)', async () => {
    const key = sodium.randombytes_buf(BACKUP_KDF_PARAMS.hashLength);
    await expect(
      createFramedBackup({ store: memoryStore(), key, crypto: cryptoBackend, codec })
    ).rejects.toThrow(BackupFormatError);
  });
});

describe('backupRestore: jalur berkas manual (recovery phrase)', () => {
  it('restore dengan phrase yang benar, tolak phrase yang salah', async () => {
    const key = sodium.randombytes_buf(BACKUP_KDF_PARAMS.hashLength);
    const salt = sodium.randombytes_buf(16);
    const built = await createFramedBackup({
      store: memoryStore(sampleRecords()),
      key,
      crypto: cryptoBackend,
      codec,
      salt,
    });

    // Jalur berkas memakai kunci dari phrase, bukan `key` acak: emulasikan dengan
    // membangun arsip ber-kunci phrase.
    const phraseKey = await (await import('../backupFormat')).deriveBackupKey(PHRASE, salt, TEST_KDF);
    const builtFromPhrase = await createFramedBackup({
      store: memoryStore(sampleRecords()),
      key: phraseKey,
      crypto: cryptoBackend,
      codec,
      salt,
    });

    const target = memoryStore();
    const report = await openFramedBackupWithPhrase({
      store: target,
      bytes: builtFromPhrase.bytes,
      phrase: PHRASE,
      crypto: cryptoBackend,
      codec,
      params: TEST_KDF,
    });
    expect(report.records).toBe(7);
    expect(target.data.messages).toHaveLength(1);

    await expect(
      openFramedBackupWithPhrase({
        store: memoryStore(),
        bytes: builtFromPhrase.bytes,
        phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        crypto: cryptoBackend,
        codec,
        params: TEST_KDF,
      })
    ).rejects.toThrow(/Autentikasi frame gagal/);

    // `built` (kunci acak) tetap valid sebagai arsip — hanya jalur kuncinya beda.
    expect(built.size).toBeGreaterThan(0);
  });

  /**
   * [docs/31 §31.6b] Kontrak yang membuat tombol "Buat Backup" dan modal restore
   * saling cocok: jalur export menurunkan kunci dari `normalizeBackupPhrase(phrase)`
   * dan menulis salt-nya ke header; jalur restore menormalkan phrase dengan aturan
   * yang SAMA. Test ini memakai phrase yang belum rapi (huruf besar + spasi) di
   * kedua sisi — kalau salah satu sisi berhenti menormalkan, arsip yang sah akan
   * ditolak "Autentikasi frame gagal".
   */
  it('export (phrase dinormalkan) → restore dengan phrase yang belum rapi tetap terbuka', async () => {
    const messyPhrase = `  ${PHRASE.toUpperCase()}  `;
    const salt = sodium.randombytes_buf(16);
    const exportKey = await (await import('../backupFormat')).deriveBackupKey(
      normalizeBackupPhrase(messyPhrase),
      salt,
      TEST_KDF
    );

    const builtFromExport = await createFramedBackup({
      store: memoryStore(sampleRecords()),
      key: exportKey,
      crypto: cryptoBackend,
      codec,
      salt,
    });

    const target = memoryStore();
    const report = await openFramedBackupWithPhrase({
      store: target,
      bytes: builtFromExport.bytes,
      phrase: messyPhrase, // sengaja TIDAK rapi — normalisasi harus terjadi di dalam
      crypto: cryptoBackend,
      codec,
      params: TEST_KDF,
    });

    expect(report.records).toBe(7);
    expect(target.data.messages).toHaveLength(1);
  });
});

describe('backupRestore: arsip pra-SQLite', () => {
  it('menolak arsip tanpa tabel SQLite alih-alih restore kosong yang "berhasil"', () => {
    expect(() => assertRestorableBackupTables({})).toThrow(BackupFormatError);
    expect(() => assertRestorableBackupTables({ kvStore: [{ key: 'locale', value: 'id' }] }))
      .toThrow(/klien lama/);
  });

  it('menerima arsip dengan kunci atau baris SQLite', () => {
    expect(() => assertRestorableBackupTables({ sqliteMeta: [{ key: 'dbKey', value: new Uint8Array(32) }] })).not.toThrow();
    expect(() => assertRestorableBackupTables({ sqliteKv: [{ key: 'locale', value: 'id' }] })).not.toThrow();
    expect(() => assertRestorableBackupTables({ sqliteMessages: [{ id: 'm1' }] })).not.toThrow();
  });
});

describe('backupRestore: laporan ukuran', () => {
  it('formatBackupSize membulatkan sesuai satuan', () => {
    expect(formatBackupSize(512)).toBe('512 B');
    expect(formatBackupSize(2048)).toBe('2.00 KB');
    expect(formatBackupSize(1024 * 1024 * 1.234)).toBe('1.23 MB');
    expect(formatBackupSize(1024 * 1024 * 250)).toBe('250 MB');
    expect(() => formatBackupSize(-1)).toThrow(BackupFormatError);
  });

  it('averageFrameBytes membagi ukuran arsip dengan jumlah frame', () => {
    expect(averageFrameBytes({ size: 4096, frameCount: 4 })).toBe(1024);
    expect(averageFrameBytes({ size: 4096, frameCount: 0 })).toBe(0);
  });
});
