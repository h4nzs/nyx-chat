// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 1 / docs/31] Format backup NYX — ber-frame, terenkripsi,
 * tervalidasi.
 *
 * Mengapa bukan "satu JSON besar" (implementasi lama di `keychainDb.ts`):
 *
 *  1. **Bentuknya membocorkan struktur.** Satu blob JSON membocorkan berapa
 *     banyak pesan/kontak/grup yang dimiliki user lewat ukuran total, dan JSON
 *     plaintext-struktur (nama tabel, jumlah elemen) terlihat tanpa membuka
 *     apa pun. Di sini setiap frame di-pad ke kelipatan blok tetap, jadi dua
 *     payload 10 byte dan 1000 byte menghasilkan frame **sama panjang**.
 *  2. **Tidak ada validasi.** JSON yang terpotong/teracak masih "valid" sebagian.
 *     Di sini setiap frame di-AEAD dengan AAD yang mengikat `(type, index,
 *     jumlah frame)`, jadi **tamper, reorder, dan truncate semuanya gagal keras**.
 *  3. **Tidak bisa streaming.** `JSON.parse` atas seluruh vault = puncak memori
 *     besar. Parser di sini berjalan per frame.
 *
 * Kunci backup diturunkan dari **recovery phrase** (BIP39) + salt di header
 * lewat Argon2id (params sama dengan vault, 128 MB), sehingga:
 *   - backup bisa dibuka ulang di perangkat pengganti tanpa server,
 *   - tidak ada kunci yang disimpan di server (server hanya melihat blob).
 *
 * Pemanggil menyuntikkan backend kripto (`BackupCryptoBackend`) supaya modul ini
 * berjalan di worker (instance sodium milik worker) **dan** di test (libsodium
 * langsung) tanpa mock — uji di `__tests__/backupFormat.test.ts` memakai AEAD
 * sungguhan, bukan stub.
 */

import { argon2id } from 'hash-wasm';

/** Penanda berkas: 4 byte pertama setiap arsip backup. */
export const BACKUP_MAGIC = 'NYXB';

/** Versi format. Naikkan hanya bila tata letak berubah (parser lama harus tolak). */
export const BACKUP_FORMAT_VERSION = 1;

/** Panjang header arsip (byte): magic(4) + versi(1) + flags(1) + count(2) + salt(16) + reserved(8). */
export const BACKUP_HEADER_BYTES = 32;

/** Panjang salt KDF di header. */
export const BACKUP_SALT_BYTES = 16;

/** Nonce XChaCha20-Poly1305. */
export const BACKUP_NONCE_BYTES = 24;

/** Tag Poly1305. */
export const BACKUP_TAG_BYTES = 16;

/** Panjang field `payloadLength` per frame. */
export const BACKUP_FRAME_LENGTH_BYTES = 4;

/**
 * Blok padding payload (byte). Semua payload dibulatkan ke kelipatan ini
 * **sebelum** dienkripsi, sehingga panjang frame tidak mengungkap panjang data.
 */
export const BACKUP_PADDING_BLOCK_BYTES = 1024;

/** Batas jumlah frame (field count = u16). */
export const BACKUP_MAX_FRAMES = 65535;

/** Batas panjang satu payload sebelum padding (anti-blowup memori). */
export const BACKUP_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Parameter Argon2id untuk kunci backup (angka dipin oleh test). */
export interface BackupKdfParams {
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

/**
 * Parameter KDF backup. **Sama dengan `ARGON_VAULT_CONFIG`** di
 * `workers/crypto.worker.ts` (m=128 MB, t=4, p=1) — sengaja dipin agar
 * penggunaannya tidak divergen; `backupFormat.test.ts` mengunci angkanya.
 */
export const BACKUP_KDF_PARAMS: BackupKdfParams = {
  memorySize: 131072,
  iterations: 4,
  parallelism: 1,
  hashLength: 32,
};

/** Jenis isi frame. Angka eksplisit: bagian dari format, jangan diacak ulang. */
export enum BackupFrameType {
  Account = 1,
  Contacts = 2,
  Conversation = 3,
  Message = 4,
  Story = 5,
  Settings = 6,
  Tombstone = 7,
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** Backend kripto minimal (libsodium di produksi, libsodium juga di test). */
export interface BackupCryptoBackend {
  randomBytes(length: number): Uint8Array;
  /** XChaCha20-Poly1305: kembalikan ciphertext||tag. */
  aeadSeal(opts: { key: Uint8Array; nonce: Uint8Array; plaintext: Uint8Array; aad: Uint8Array }): Uint8Array;
  /** Buka envelope; `null` bila autentikasi gagal (jangan lempar dari sini). */
  aeadOpen(opts: { key: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array; aad: Uint8Array }): Uint8Array | null;
}

/** Bentuk sodium yang dibutuhkan adapter — struktural supaya tidak mengikat tipe paket. */
export interface SodiumLike {
  randombytes_buf(length: number): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array
  ): Uint8Array;
}

/**
 * Adapter libsodium → `BackupCryptoBackend`. Dipakai worker (instance sodium
 * miliknya) dan test (libsodium-wrappers langsung) — satu implementasi, jadi
 * perilaku produksi dan perilaku yang diuji tidak bisa menyimpang.
 */
export function libsodiumBackupCrypto(sodium: SodiumLike): BackupCryptoBackend {
  return {
    randomBytes: (length) => sodium.randombytes_buf(length),
    aeadSeal: ({ key, nonce, plaintext, aad }) =>
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key),
    aeadOpen: ({ key, nonce, ciphertext, aad }) => {
      try {
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key);
      } catch {
        return null;
      }
    },
  };
}

/** Kunci backup dari recovery phrase. `params` hanya untuk test (produksi: default). */
export async function deriveBackupKey(
  recoveryPhrase: string,
  salt: Uint8Array,
  params: BackupKdfParams = BACKUP_KDF_PARAMS
): Promise<Uint8Array> {
  if (salt.length < 8) throw new BackupFormatError('Salt KDF minimal 8 byte');
  const key = await argon2id({
    password: recoveryPhrase.normalize('NFKD'),
    salt,
    ...params,
    outputType: 'binary',
  });
  return key;
}

/**
 * Pad payload ke blok tetap: `[panjang asli u32 BE][data][nol]`.
 *
 * Panjang asli DISIMPAN di dalam plaintext (bukan di header frame) supaya
 * panjang nyata tidak bisa dibaca tanpa kunci.
 */
export function padBackupPayload(payload: Uint8Array): Uint8Array {
  if (payload.length > BACKUP_MAX_PAYLOAD_BYTES) {
    throw new BackupFormatError('Payload terlalu besar untuk satu frame');
  }
  const block = BACKUP_PADDING_BLOCK_BYTES;
  const total = Math.max(block, Math.ceil((BACKUP_FRAME_LENGTH_BYTES + payload.length) / block) * block);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(payload, BACKUP_FRAME_LENGTH_BYTES);
  return out;
}

/** Kebalikan `padBackupPayload`, sekaligus menolak padding yang tidak nol. */
export function unpadBackupPayload(padded: Uint8Array): Uint8Array {
  if (padded.length < BACKUP_FRAME_LENGTH_BYTES || padded.length % BACKUP_PADDING_BLOCK_BYTES !== 0) {
    throw new BackupFormatError('Payload ter-pad tidak berukuran blok');
  }
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (length > padded.length - BACKUP_FRAME_LENGTH_BYTES) {
    throw new BackupFormatError('Panjang payload melebihi frame');
  }
  const payload = padded.slice(BACKUP_FRAME_LENGTH_BYTES, BACKUP_FRAME_LENGTH_BYTES + length);
  for (let i = BACKUP_FRAME_LENGTH_BYTES + length; i < padded.length; i++) {
    if (padded[i] !== 0) throw new BackupFormatError('Padding frame tidak nol');
  }
  return payload;
}

/**
 * Encoder ASCII tanpa `TextEncoder`.
 *
 * Bukan preferensi gaya: `TextEncoder().encode()` mengembalikan `Uint8Array`
 * dari realm lain di beberapa lingkungan (jsdom/vitest), dan libsodium menolak
 * nilainya (`unsupported input type for additional_data` — pengecekannya pakai
 * `instanceof Uint8Array`). Byte ditulis manual agar array pasti berasal dari
 * realm yang sama dengan backend kripto.
 */
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

/**
 * AAD mengikat `(type, index, jumlah frame)` ke ciphertext. Efeknya: memindahkan
 * frame, menghapus frame terakhir, atau menyisipkan frame membuat tag GAGAL —
 * tanpa perlu checksum terpisah.
 */
function frameAad(type: BackupFrameType, index: number, totalFrames: number): Uint8Array {
  return asciiBytes(`nyxb:v${BACKUP_FORMAT_VERSION}:${type}:${index}:${totalFrames}`);
}

export interface BackupFrameInput {
  type: BackupFrameType;
  payload: Uint8Array;
}

export interface BackupFrameOutput {
  type: BackupFrameType;
  payload: Uint8Array;
}

export interface BackupArchive {
  bytes: Uint8Array;
  /** Salt KDF — dibutuhkan untuk menurunkan ulang kunci saat restore. */
  salt: Uint8Array;
}

/**
 * Bangun arsip backup. Frame WAJIB diberikan dalam urutan final (parser
 * menegakkan urutan); `crypto.randomBytes` untuk salt + nonce per frame
 * (nonce tidak boleh dipakai ulang dengan kunci sama).
 */
export function buildBackupArchive(opts: {
  frames: BackupFrameInput[];
  key: Uint8Array;
  crypto: BackupCryptoBackend;
  salt?: Uint8Array;
}): BackupArchive {
  const { frames, key, crypto } = opts;
  if (frames.length === 0) throw new BackupFormatError('Arsip backup tanpa frame tidak sah');
  if (frames.length > BACKUP_MAX_FRAMES) throw new BackupFormatError('Terlalu banyak frame');
  if (key.length !== BACKUP_KDF_PARAMS.hashLength) throw new BackupFormatError('Panjang kunci backup salah');

  const salt = opts.salt ?? crypto.randomBytes(BACKUP_SALT_BYTES);
  if (salt.length !== BACKUP_SALT_BYTES) throw new BackupFormatError('Panjang salt salah');

  const encodedFrames = frames.map((frame, index) => {
    const padded = padBackupPayload(frame.payload);
    const nonce = crypto.randomBytes(BACKUP_NONCE_BYTES);
    const aad = frameAad(frame.type, index, frames.length);
    const ciphertext = crypto.aeadSeal({ key, nonce, plaintext: padded, aad });
    return { type: frame.type, nonce, ciphertext };
  });

  const totalBytes =
    BACKUP_HEADER_BYTES +
    encodedFrames.reduce((sum, frame) => sum + 1 + 4 + BACKUP_NONCE_BYTES + 4 + frame.ciphertext.length, 0);

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  out.set(asciiBytes(BACKUP_MAGIC), 0);
  out[4] = BACKUP_FORMAT_VERSION;
  out[5] = 0; // flags (reserved)
  view.setUint16(6, frames.length, false);
  out.set(salt, 8);
  // byte 24..31 reserved = 0

  let offset = BACKUP_HEADER_BYTES;
  for (const frame of encodedFrames) {
    out[offset] = frame.type;
    view.setUint32(offset + 1, 0, false); // index placeholder → ditulis di bawah
    // index = posisi frame (parser menegakkannya), jadi simpan apa adanya.
    offset += 1;
    offset += 4;
    out.set(frame.nonce, offset);
    offset += BACKUP_NONCE_BYTES;
    view.setUint32(offset, frame.ciphertext.length, false);
    offset += 4;
    out.set(frame.ciphertext, offset);
    offset += frame.ciphertext.length;
  }

  // Tulis index frame (0..n-1) setelah loop supaya panjang tiap frame diketahui
  // saat menulis (tata letak fixed-size di depan, isi variabel di belakang).
  let indexOffset = BACKUP_HEADER_BYTES;
  for (let i = 0; i < encodedFrames.length; i++) {
    const frame = encodedFrames[i]!;
    view.setUint32(indexOffset + 1, i, false);
    indexOffset += 1 + 4 + BACKUP_NONCE_BYTES + 4 + frame.ciphertext.length;
  }

  return { bytes: out, salt };
}

export interface ParsedBackup {
  frames: BackupFrameOutput[];
  salt: Uint8Array;
  formatVersion: number;
}

/** Baca header tanpa kunci (untuk memvalidasi tipe berkas & menghitung salt). */
export function readBackupHeader(bytes: Uint8Array): { frameCount: number; salt: Uint8Array; formatVersion: number } {
  if (bytes.length < BACKUP_HEADER_BYTES) throw new BackupFormatError('Berkas terlalu pendek');
  const magic = asciiBytes(BACKUP_MAGIC);
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) throw new BackupFormatError('Bukan berkas backup NYX');
  }
  const formatVersion = bytes[4]!;
  if (formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(`Versi format backup tidak didukung: ${formatVersion}`);
  }
  const frameCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, false);
  if (frameCount === 0) throw new BackupFormatError('Arsip backup tanpa frame');
  return { frameCount, salt: bytes.slice(8, 8 + BACKUP_SALT_BYTES), formatVersion };
}

/**
 * Parse + verifikasi arsip. Melempar `BackupFormatError` untuk: magic/versi
 * salah, frame terpotong, index tidak berurutan (reorder/insert), rangkaian
 * berlebih/kurang (truncate), tag AEAD gagal (tamper atau kunci salah), dan
 * padding yang tidak nol.
 */
export function parseBackupArchive(bytes: Uint8Array, key: Uint8Array, crypto: BackupCryptoBackend): ParsedBackup {
  const { frameCount, salt, formatVersion } = readBackupHeader(bytes);
  if (key.length !== BACKUP_KDF_PARAMS.hashLength) throw new BackupFormatError('Panjang kunci backup salah');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: BackupFrameOutput[] = [];
  let offset = BACKUP_HEADER_BYTES;

  for (let expectedIndex = 0; expectedIndex < frameCount; expectedIndex++) {
    if (offset + 1 + 4 + BACKUP_NONCE_BYTES + 4 > bytes.length) {
      throw new BackupFormatError('Frame terpotong');
    }
    const type = bytes[offset]! as BackupFrameType;
    const index = view.getUint32(offset + 1, false);
    if (index !== expectedIndex) throw new BackupFormatError('Urutan frame tidak sah (reorder/insert)');
    if (!(type in BackupFrameType)) throw new BackupFormatError(`Jenis frame tidak dikenal: ${type}`);
    offset += 5;

    const nonce = bytes.slice(offset, offset + BACKUP_NONCE_BYTES);
    offset += BACKUP_NONCE_BYTES;

    const ciphertextLength = view.getUint32(offset, false);
    offset += 4;
    if (ciphertextLength < BACKUP_TAG_BYTES || offset + ciphertextLength > bytes.length) {
      throw new BackupFormatError('Panjang ciphertext frame tidak sah');
    }
    const ciphertext = bytes.slice(offset, offset + ciphertextLength);
    offset += ciphertextLength;

    const aad = frameAad(type, index, frameCount);
    const padded = crypto.aeadOpen({ key, nonce, ciphertext, aad });
    if (!padded) throw new BackupFormatError('Autentikasi frame gagal (tamper atau kunci salah)');

    frames.push({ type, payload: unpadBackupPayload(padded) });
  }

  if (offset !== bytes.length) throw new BackupFormatError('Ada data berlebih setelah frame terakhir');

  return { frames, salt, formatVersion };
}
