// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 1 / docs/31] Format backup ber-frame — properti yang
 * dikunci, semuanya dengan kripto SUNGGUHAN (libsodium XChaCha20-Poly1305 +
 * hash-wasm Argon2id), bukan stub:
 *
 *   1. Roundtrip: build → parse mengembalikan frame identik.
 *   2. Tamper (satu byte di ciphertext) → gagal keras.
 *   3. Reorder (tukar dua frame) → gagal keras (AAD mengikat index).
 *   4. Truncate (buang frame terakhir ATAU potong byte) → gagal keras.
 *   5. Kunci salah / salt berbeda → gagal keras.
 *   6. Padding: payload 10 byte dan 1000 byte menghasilkan frame SAMA panjang
 *      (bentuk backup tidak membocorkan ukuran data).
 *   7. KDF: parameter produksi dipin (128 MB/t=4/p=1) dan benar-benar dipakai.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';

import {
  BACKUP_FORMAT_VERSION,
  BACKUP_FRAME_LENGTH_BYTES,
  BACKUP_HEADER_BYTES,
  BACKUP_KDF_PARAMS,
  BACKUP_PADDING_BLOCK_BYTES,
  BACKUP_SALT_BYTES,
  BackupFormatError,
  BackupFrameType,
  buildBackupArchive,
  deriveBackupKey,
  libsodiumBackupCrypto,
  padBackupPayload,
  parseBackupArchive,
  readBackupHeader,
  unpadBackupPayload,
} from '../backupFormat';

/** Param KDF kecil supaya test cepat; produksi tetap 128 MB (diuji terpisah). */
const TEST_KDF = { ...BACKUP_KDF_PARAMS, memorySize: 64, iterations: 2 } as const;

let cryptoBackend: ReturnType<typeof libsodiumBackupCrypto>;

beforeAll(async () => {
  await sodium.ready;
  cryptoBackend = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
});

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

async function keyFor(salt: Uint8Array, phrase = PHRASE): Promise<Uint8Array> {
  return deriveBackupKey(phrase, salt, TEST_KDF);
}

const sampleFrames = () => [
  { type: BackupFrameType.Account, payload: bytes('{"username":"han"}') },
  { type: BackupFrameType.Contacts, payload: bytes('[{"userId":"u1"}]') },
  { type: BackupFrameType.Message, payload: new Uint8Array(2000).fill(7) },
];

describe('backupFormat: roundtrip & validasi keras', () => {
  it('build → parse mengembalikan frame identik (tipe, urutan, isi byte-per-byte)', async () => {
    const frames = sampleFrames();
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const archive = buildBackupArchive({ frames, key, crypto: cryptoBackend, salt });

    expect(readBackupHeader(archive.bytes).frameCount).toBe(frames.length);
    expect(readBackupHeader(archive.bytes).formatVersion).toBe(BACKUP_FORMAT_VERSION);

    const parsed = parseBackupArchive(archive.bytes, key, cryptoBackend);
    expect(parsed.frames.map((f) => f.type)).toEqual(frames.map((f) => f.type));
    parsed.frames.forEach((frame, i) => {
      expect(Array.from(frame.payload)).toEqual(Array.from(frames[i]!.payload));
    });
    expect(Array.from(parsed.salt)).toEqual(Array.from(salt));
  });

  it('tamper satu byte ciphertext → BackupFormatError', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const archive = buildBackupArchive({ frames: sampleFrames(), key, crypto: cryptoBackend, salt });

    const tampered = archive.bytes.slice();
    tampered[BACKUP_HEADER_BYTES + 40] = tampered[BACKUP_HEADER_BYTES + 40]! ^ 0x01;
    expect(() => parseBackupArchive(tampered, key, cryptoBackend)).toThrow(BackupFormatError);
  });

  it('kunci salah (salt berbeda) → gagal, bukan data sampah', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const archive = buildBackupArchive({ frames: sampleFrames(), key, crypto: cryptoBackend, salt });

    const wrongKey = await keyFor(sodium.randombytes_buf(BACKUP_SALT_BYTES));
    expect(() => parseBackupArchive(archive.bytes, wrongKey, cryptoBackend)).toThrow(/Autentikasi frame gagal/);
  });

  it('truncate: potong byte terakhir → gagal; buang seluruh frame terakhir → gagal', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const frames = sampleFrames();
    const archive = buildBackupArchive({ frames, key, crypto: cryptoBackend, salt });

    expect(() => parseBackupArchive(archive.bytes.slice(0, archive.bytes.length - 1), key, cryptoBackend)).toThrow(
      BackupFormatError
    );

    // Buang frame terakhir, tapi header masih menyatakan 3 frame → terpotong.
    const twoFrames = buildBackupArchive({ frames: frames.slice(0, 2), key, crypto: cryptoBackend, salt });
    const frankenstein = new Uint8Array(archive.bytes.length);
    frankenstein.set(twoFrames.bytes, 0);
    frankenstein[6] = 0;
    frankenstein[7] = 3; // paksa count = 3
    expect(() => parseBackupArchive(frankenstein, key, cryptoBackend)).toThrow(BackupFormatError);
  });

  it('reorder: tukar dua frame berukuran sama → gagal (AAD mengikat index)', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const a = { type: BackupFrameType.Conversation, payload: bytes('conv-a') };
    const b = { type: BackupFrameType.Conversation, payload: bytes('conv-b') };
    const archive = buildBackupArchive({ frames: [a, b], key, crypto: cryptoBackend, salt });

    const frameSize = archive.bytes.length - BACKUP_HEADER_BYTES;
    expect(frameSize % 2).toBe(0);

    const swapped = archive.bytes.slice();
    swapped.set(archive.bytes.subarray(BACKUP_HEADER_BYTES + frameSize / 2), BACKUP_HEADER_BYTES);
    swapped.set(archive.bytes.subarray(BACKUP_HEADER_BYTES, BACKUP_HEADER_BYTES + frameSize / 2), BACKUP_HEADER_BYTES + frameSize / 2);
    expect(() => parseBackupArchive(swapped, key, cryptoBackend)).toThrow(BackupFormatError);
  });

  it('header: magic/versi salah ditolak tanpa perlu kunci', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const archive = buildBackupArchive({ frames: sampleFrames(), key, crypto: cryptoBackend, salt });

    const wrongMagic = archive.bytes.slice();
    wrongMagic[0] = 0x58; // 'X'
    expect(() => readBackupHeader(wrongMagic)).toThrow(/Bukan berkas backup NYX/);

    const wrongVersion = archive.bytes.slice();
    wrongVersion[4] = 99;
    expect(() => readBackupHeader(wrongVersion)).toThrow(/Versi format backup tidak didukung/);

    expect(() => readBackupHeader(archive.bytes.slice(0, 10))).toThrow(/terlalu pendek/);
  });

  it('data berlebih setelah frame terakhir ditolak (anti-penyelundupan)', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const archive = buildBackupArchive({ frames: sampleFrames(), key, crypto: cryptoBackend, salt });
    const padded = new Uint8Array(archive.bytes.length + 8);
    padded.set(archive.bytes, 0);
    expect(() => parseBackupArchive(padded, key, cryptoBackend)).toThrow(/data berlebih/);
  });
});

describe('backupFormat: padding menyembunyikan ukuran', () => {
  it('payload 10 byte dan 1000 byte menghasilkan frame SAMA panjang', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    const small = buildBackupArchive({
      frames: [{ type: BackupFrameType.Message, payload: bytes('1234567890') }],
      key, crypto: cryptoBackend, salt,
    });
    const large = buildBackupArchive({
      frames: [{ type: BackupFrameType.Message, payload: new Uint8Array(1000).fill(3) }],
      key, crypto: cryptoBackend, salt,
    });
    expect(small.bytes.length).toBe(large.bytes.length);
    expect(small.bytes.length).toBe(BACKUP_HEADER_BYTES + 1 + 4 + 24 + 4 + BACKUP_PADDING_BLOCK_BYTES + 16);
  });

  it('padding: roundtrip payload tepat & payload lewat satu blok; padding tidak-nol ditolak', () => {
    const exact = new Uint8Array(BACKUP_PADDING_BLOCK_BYTES - BACKUP_FRAME_LENGTH_BYTES).fill(9);
    expect(Array.from(unpadBackupPayload(padBackupPayload(exact)))).toEqual(Array.from(exact));

    const bigger = new Uint8Array(BACKUP_PADDING_BLOCK_BYTES + 5).fill(1);
    expect(padBackupPayload(bigger).length).toBe(BACKUP_PADDING_BLOCK_BYTES * 2);
    expect(Array.from(unpadBackupPayload(padBackupPayload(bigger)))).toEqual(Array.from(bigger));

    const broken = padBackupPayload(bytes('halo'));
    broken[broken.length - 1] = 1; // padding harus nol
    expect(() => unpadBackupPayload(broken)).toThrow(/Padding frame tidak nol/);
  });
});

describe('backupFormat: KDF dipin', () => {
  it('parameter produksi = 128 MB / t=4 / p=1 / 32 byte (sama dengan vault)', () => {
    expect(BACKUP_KDF_PARAMS).toEqual({ memorySize: 131072, iterations: 4, parallelism: 1, hashLength: 32 });
  });

  it('KDF deterministik untuk (phrase, salt) sama, dan sensitif ke salt & phrase', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const k1 = await deriveBackupKey(PHRASE, salt, TEST_KDF);
    const k2 = await deriveBackupKey(PHRASE, salt, TEST_KDF);
    expect(k1.length).toBe(32);
    expect(Array.from(k1)).toEqual(Array.from(k2));

    const otherSalt = await deriveBackupKey(PHRASE, sodium.randombytes_buf(BACKUP_SALT_BYTES), TEST_KDF);
    expect(Array.from(otherSalt)).not.toEqual(Array.from(k1));

    const otherPhrase = await deriveBackupKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', salt, TEST_KDF);
    expect(Array.from(otherPhrase)).not.toEqual(Array.from(k1));
  });

  it('salt terlalu pendek ditolak (Argon2 butuh minimal 8 byte)', async () => {
    await expect(deriveBackupKey(PHRASE, new Uint8Array(4), TEST_KDF)).rejects.toThrow(BackupFormatError);
  });

  it('arsip tanpa frame / kunci salah panjang ditolak', async () => {
    const salt = sodium.randombytes_buf(BACKUP_SALT_BYTES);
    const key = await keyFor(salt);
    expect(() => buildBackupArchive({ frames: [], key, crypto: cryptoBackend, salt })).toThrow(/tanpa frame/);
    expect(() =>
      buildBackupArchive({
        frames: [{ type: BackupFrameType.Account, payload: bytes('x') }],
        key: new Uint8Array(16),
        crypto: cryptoBackend,
        salt,
      })
    ).toThrow(/Panjang kunci backup salah/);
  });
});
