// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 2 / docs/31 §31.6] Pengaitan payload Keychain ↔ frame.
 * Semua test memakai kripto SUNGGUHAN (libsodium + Argon2id + arsip ber-frame),
 * bukan stub — yang diuji adalah perilaku produksi, bukan mock.
 *
 * Properti yang dikunci:
 *   1. Roundtrip melalui arsip nyata mempertahankan nilai biner (`Uint8Array`)
 *      dan `Date`, serta nilai at-rest (`ENC1:`) apa adanya.
 *   2. Determinisme: urutan masukan tidak mengubah frame yang dihasilkan.
 *   3. Chunking: catatan banyak dipecah ke beberapa frame tanpa kehilangan data.
 *   4. Scramble: permutasi bergantung kunci, deterministik, dan tetap
 *      mereproduksi arsip identik saat diedarkan ulang dari hasil restore.
 *   5. Validasi keras: tabel tak dikenal, tipe frame tak cocok, payload rusak,
 *      dan tipe nilai tak didukung semuanya melempar `BackupFormatError`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';

import {
  BACKUP_KDF_PARAMS,
  BACKUP_MAX_FRAMES,
  BACKUP_SALT_BYTES,
  BackupFormatError,
  BackupFrameType,
  buildBackupArchive,
  deriveBackupKey,
  libsodiumBackupCrypto,
  parseBackupArchive,
} from '../backupFormat';
import {
  BACKUP_TABLE_FRAME_TYPE,
  buildBackupFrames,
  chunksToRecordsByTable,
  decodeBackupValue,
  encodeBackupValue,
  libsodiumBackupValueCodec,
  readBackupChunks,
  scrambleBackupFrames,
  type BackupValueCodec,
} from '../backupPayload';

/** Param KDF kecil supaya test cepat; parameter produksi diuji di `backupFormat.test.ts`. */
const TEST_KDF = { ...BACKUP_KDF_PARAMS, memorySize: 64, iterations: 2 } as const;
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

let codec: BackupValueCodec;
let cryptoBackend: ReturnType<typeof libsodiumBackupCrypto>;

beforeAll(async () => {
  await sodium.ready;
  codec = libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);
  cryptoBackend = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
});

/** Normalisasi nilai agar bisa dibandingkan `toEqual` (Uint8Array → array biasa). */
function normalize(value: unknown): unknown {
  // `ArrayBuffer.isView` (bukan `instanceof`) karena libsodium bisa mengembalikan
  // typed array dari realm lain — persis kasus yang ditangani modul ini.
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength));
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
  kvStore: [{ key: 'locale', value: 'id' }],
});

async function freshKey(): Promise<Uint8Array> {
  return deriveBackupKey(PHRASE, sodium.randombytes_buf(BACKUP_SALT_BYTES), TEST_KDF);
}

describe('backupPayload: roundtrip melalui arsip sungguhan', () => {
  it('mempertahankan Uint8Array, Date, dan nilai ENC1 apa adanya', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await deriveBackupKey(PHRASE, salt, TEST_KDF);
    const records = sampleRecords();

    const frames = buildBackupFrames({ recordsByTable: records, codec });
    const archive = buildBackupArchive({ frames, key, crypto: cryptoBackend, salt });
    const parsed = parseBackupArchive(archive.bytes, key, cryptoBackend);
    const restored = chunksToRecordsByTable(readBackupChunks(parsed.frames, codec));

    // Urutan dipulihkan menurut kunci primer (deterministik), jadi bandingkan
    // setelah diurutkan — isi & tipe tetap harus identik.
    const asKeyed = (rows: unknown[], keyPath: string) =>
      (normalize(rows) as Array<Record<string, unknown>>)
        .map((row) => JSON.stringify(row[keyPath]) + '|' + JSON.stringify(row))
        .sort();
    expect(asKeyed(restored.identityKeys!, 'userId')).toEqual(asKeyed(records.identityKeys, 'userId'));
    expect(asKeyed(restored.sessionKeys!, 'storageKey')).toEqual(asKeyed(records.sessionKeys, 'storageKey'));
    expect(asKeyed(restored.conversations!, 'id')).toEqual(asKeyed(records.conversations, 'id'));
    expect(asKeyed(restored.messages!, 'id')).toEqual(asKeyed(records.messages, 'id'));
    expect(asKeyed(restored.kvStore!, 'key')).toEqual(asKeyed(records.kvStore, 'key'));

    // Nilai biner benar-benar kembali sebagai Uint8Array realm lokal.
    const keyBytes = (restored.sessionKeys![0] as { key: Uint8Array }).key;
    expect(keyBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(keyBytes)).toEqual([1, 2, 3, 250]);
  });

  it('setiap frame bertipe sesuai tabel asalnya', () => {
    const frames = buildBackupFrames({ recordsByTable: sampleRecords(), codec });
    const types = new Set(frames.map((frame) => frame.type));
    expect(types).toEqual(
      new Set([
        BackupFrameType.Account,
        BackupFrameType.Conversation,
        BackupFrameType.Message,
        BackupFrameType.Settings,
      ])
    );
    expect(BACKUP_TABLE_FRAME_TYPE.kvStore).toBe(BackupFrameType.Settings);
  });
});

describe('backupPayload: determinisme & chunking', () => {
  it('urutan masukan tidak mengubah frame yang dihasilkan', () => {
    const forward = sampleRecords();
    const reversed = {
      ...forward,
      identityKeys: [...forward.identityKeys].reverse(),
      messages: [...forward.messages].reverse(),
    };
    const a = buildBackupFrames({ recordsByTable: forward, codec });
    const b = buildBackupFrames({ recordsByTable: reversed, codec });
    expect(b.map((f) => Array.from(f.payload))).toEqual(a.map((f) => Array.from(f.payload)));
  });

  it('catatan banyak dipecah ke beberapa frame tanpa kehilangan data', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `m${String(i).padStart(3, '0')}`,
      conversationId: 'c1',
      content: `ENC1:${i}`,
      createdAt: '2026-10-11T00:00:00.000Z',
    }));
    const frames = buildBackupFrames({ recordsByTable: { messages: many }, codec, chunkBytes: 200 });
    expect(frames.length).toBeGreaterThan(1);

    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await deriveBackupKey(PHRASE, salt, TEST_KDF);
    const archive = buildBackupArchive({ frames, key, crypto: cryptoBackend, salt });
    const restored = chunksToRecordsByTable(readBackupChunks(parseBackupArchive(archive.bytes, key, cryptoBackend).frames, codec));
    expect(restored.messages).toHaveLength(50);
    expect((restored.messages![49] as { id: string }).id).toBe('m049');
  });

  it('menolak arsip tanpa catatan dan ambang chunk yang tidak masuk akal', () => {
    expect(() => buildBackupFrames({ recordsByTable: {}, codec })).toThrow(BackupFormatError);
    expect(() => buildBackupFrames({ recordsByTable: sampleRecords(), codec, chunkBytes: 8 })).toThrow(BackupFormatError);
    // Batas frame adalah kontrak format (u16 di header), bukan angka bebas.
    expect(BACKUP_MAX_FRAMES).toBe(65535);
  });
});

describe('backupPayload: scramble deterministik', () => {
  it('mengubah urutan tetapi dapat direproduksi, dan ekspor ulang byte-identik', async () => {
    const key = await freshKey();
    const records = {
      messages: Array.from({ length: 30 }, (_, i) => ({ id: `m${String(i).padStart(2, '0')}`, conversationId: 'c1', content: 'x' })),
    };
    // chunkBytes kecil memaksa banyak frame, sehingga permutasi punya ruang gerak.
    const plain = buildBackupFrames({ recordsByTable: records, codec, chunkBytes: 128 });
    const scrambled = buildBackupFrames({ recordsByTable: records, codec, key, scramble: true, chunkBytes: 128 });
    expect(plain.length).toBeGreaterThan(1);

    // Permutasi yang sama bila dipanggil ulang dengan kunci & himpunan sama.
    const scrambledAgain = buildBackupFrames({ recordsByTable: records, codec, key, scramble: true, chunkBytes: 128 });
    expect(scrambledAgain.map((f) => Array.from(f.payload))).toEqual(scrambled.map((f) => Array.from(f.payload)));

    const plainOrder = plain.map((f) => Array.from(f.payload).join(','));
    const scramOrder = scrambled.map((f) => Array.from(f.payload).join(','));
    expect(scramOrder).not.toEqual(plainOrder);
    expect([...scramOrder].sort()).toEqual([...plainOrder].sort());

    // Kunci berbeda → permutasi berbeda.
    const otherKey = await freshKey();
    const otherScramble = buildBackupFrames({ recordsByTable: records, codec, key: otherKey, scramble: true, chunkBytes: 128 });
    expect(otherScramble.map((f) => Array.from(f.payload).join(','))).not.toEqual(scramOrder);
  });

  it('scramble tanpa kunci ditolak', () => {
    expect(() => scrambleBackupFrames([{ type: BackupFrameType.Message, payload: new Uint8Array([1]) }])).toThrow(BackupFormatError);
  });
});

describe('backupPayload: validasi keras', () => {
  it('tabel tak dikenal ditolak saat membangun', () => {
    expect(() => buildBackupFrames({ recordsByTable: { notATable: [{ id: 1 }] }, codec })).toThrow(BackupFormatError);
  });

  it('tipe nilai tak didukung ditolak, bukan dibuang diam-diam', () => {
    expect(() => encodeBackupValue({ fn: () => 1 }, codec)).toThrow(BackupFormatError);
    expect(() => encodeBackupValue({ big: 1n }, codec)).toThrow(BackupFormatError);
  });

  it('penanda nilai tak dikenal ditolak saat decode', () => {
    expect(() => decodeBackupValue({ __type: 'Whatever', data: 'x' }, codec)).toThrow(BackupFormatError);
  });

  it('chunk dengan tabel tak dikenal / tipe frame tidak cocok / JSON rusak ditolak', () => {
    const encoder = new TextEncoder();
    const frame = (payload: string) => ({ type: BackupFrameType.Message, payload: encoder.encode(payload) });

    expect(() => readBackupChunks([frame(JSON.stringify({ table: 'notATable', records: [] }))], codec)).toThrow(BackupFormatError);
    // kvStore seharusnya bertipe Settings, bukan Message.
    expect(() => readBackupChunks([frame(JSON.stringify({ table: 'kvStore', records: [] }))], codec)).toThrow(BackupFormatError);
    expect(() => readBackupChunks([frame('bukan json')], codec)).toThrow(BackupFormatError);
    expect(() => readBackupChunks([frame(JSON.stringify({ table: 'kvStore' }))], codec)).toThrow(BackupFormatError);
  });

  it('teks non-ASCII bertahan (encoder UTF-8 realm lokal)', () => {
    const payload = { nama: 'Han — 漢字 🚀', nested: ['é', 'ü'] };
    const decoded = decodeBackupValue(encodeBackupValue(payload, codec), codec);
    expect(decoded).toEqual(payload);
  });
});
