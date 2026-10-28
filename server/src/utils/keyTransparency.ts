// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/32] Penulis log **Key Transparency**.
 *
 * Server KT yang dipakai adalah binary Go `key-transparency-server` (pin §30.2)
 * apa adanya: **tidak ada perubahan protokol**. Yang NYX sediakan di sini:
 *
 *   1. **Search key** = `0x75 ('u') || usernameHash(32 byte)` — tipe
 *      `UsernameHashPrefix` sudah ada di server KT (terverifikasi di kode:
 *      `cmd/shared/constants.go` + `cmd/kt-server/util.go`), dan karena
 *      usernameHash NYX adalah keluaran Argon2id 64MB (bukan nomor telepon),
 *      log tidak menjadi kamus baru.
 *   2. **Nilai log (format NYX v1)** — kanonik, tetap (frozen), didokumentasikan
 *      di `docs/32`: versi, keyVersion, identityKey, pqIdentityKey, signingKey,
 *      dan bucket waktu harian. Tidak ada userId, IP, atau nama.
 *   3. **Transport gRPC tanpa dependensi**: satu unary call
 *      `kt_test.KeyTransparencyTestService/Update` lewat HTTP/2 (`node:http2`),
 *      dengan framing gRPC 5 byte dan pemeriksaan `grpc-status`. Ditulis tangan
 *      (protobuf yang dipakai hanya beberapa field) supaya tidak menambah
 *      dependensi gRPC/protobuf ke server.
 *
 * Sifat yang dijaga:
 *   - **Idempoten** — penulisan hanya bergantung pada `(searchKey, keyVersion)`;
 *     server KT sendiri menganggap update duplikat sebagai sukses (`nil, nil`).
 *   - **Fail-visible, tidak memblokir** — kegagalan KT tidak menggagalkan
 *     registrasi (ketersediaan), tetapi dihitung di metrik
 *     `nyx_kt_writes_total{result="error"}` dan di-log dengan search key
 *     ter-hash (tidak ada identitas).
 *   - **Nonaktif secara default** — tanpa `KT_V2_SERVER_URL`, modul ini no-op.
 *   - **Satu log saja (2026-10-28)** — log v1 (Ed25519/VRF) dipensiunkan:
 *     `KT_SERVER_URL`, format nilai v1, dan jalur dual-write dihapus. Entri
 *     ditulis hanya sebagai nilai **v2** (ML-DSA-65) ke `KT_V2_SERVER_URL`.
 *     `KT_SERVER_URL` yang masih ada di `.env` diabaikan dengan satu peringatan
 *     saat boot (`index.ts`), bukan ditafsirkan diam-diam.
 *
 * Sisa yang jujur (docs/34 §34.6): interop `cmd/kt-client` upstream dan auditor
 * pihak ketiga kedua belum ada. Verifier klien v2 (`docs/34` §34.6a) sudah
 * memeriksa bukti search/monitor, jadi log ini bukan sekadar jejak audit.
 */

import http2 from 'node:http2';
import { createHash } from 'node:crypto';
import { encodeKtValueV2, ML_DSA_65_PUBLIC_KEY_BYTES } from '@nyx/shared';

import { incCounter, setGauge, KT_WRITES, KT_LAST_SUCCESS } from './metrics.js';

/**
 * [2026-10-28] Peringatan boot untuk env jalur v1 yang sudah pensiun.
 *
 * `KT_SERVER_URL` tidak lagi ditafsirkan: tidak ada penulisan ke pohon v1 dan
 * nilainya tidak dipakai untuk apa pun. Tetapi env yatim cenderung disalin ke
 * deployment berikutnya, jadi operator diberi tahu sekali saat boot alih-alih
 * dibiarkan mengira log v1 masih diisi (`docs/38`).
 */
export function ktRetiredEnvWarnings(env: { KT_SERVER_URL?: string }): string[] {
  const legacy = env.KT_SERVER_URL?.trim();
  if (!legacy) return [];
  return [
    `KT_SERVER_URL=${legacy} diabaikan — log Key Transparency v1 sudah dipensiunkan (docs/38). ` +
      'Penulisan log hanya ke KT_V2_SERVER_URL; hapus variabel ini dari .env.',
  ];
}

/** Prefix tipe search key di server KT (`shared.UsernameHashPrefix`). */
export const KT_USERNAME_HASH_PREFIX = 0x75;

/** Panjang usernameHash NYX (Argon2id 64MB → 32 byte). */
export const KT_USERNAME_HASH_BYTES = 32;

/**
 * **Label alur** `keyVersion` di dalam nilai log (byte ke-2), bukan penghitung
 * rotasi (`docs/32` §32.7 poin 2). Tiga nilai yang dipakai NYX:
 *
 *   - `KT_KEY_VERSION_REGISTRATION` — pendaftaran akun (`POST /auth/register`).
 *   - `KT_KEY_VERSION_RECOVERY` — pemulihan akun (`POST /auth/recover`).
 *   - `KT_KEY_VERSION_ROTATION` — kunci identitas berubah di luar kedua alur itu:
 *     upload bundle (`POST /keys/prekey-bundle`), `PUT /users/me/keys`, dan
 *     re-sync kunci saat login (`POST /auth/login`) — lihat `utils/ktIdentityLog.ts`.
 *
 * Perubahan kunci tetap TERtulis walau labelnya sama: idempotensi dedupe
 * memakai `(searchKey, keyVersion, digest nilai)`, jadi dua rotasi berturut-turut
 * (nilai berbeda) selalu menghasilkan dua entri.
 */
export const KT_KEY_VERSION_REGISTRATION = 1;
export const KT_KEY_VERSION_RECOVERY = 2;
export const KT_KEY_VERSION_ROTATION = 3;

/** Path gRPC layanan update (test service dari repo KT — lihat docs/32). */
export const KT_UPDATE_GRPC_PATH = '/kt_test.KeyTransparencyTestService/Update';

/** Umur dedupe penulisan (ms) — optimisasi, bukan pengaman. */
export const KT_DEDUPE_TTL_MS = 10 * 60 * 1000;

// ============================================================================
// Protobuf minimal (hanya yang dipakai kontrak update)
// ============================================================================

function varint(value: number | bigint): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  const out: number[] = [];
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const bytesField = (field: number, value: Uint8Array): Uint8Array =>
  concatBytes(varint((field << 3) | 2), varint(value.length), value);
const messageField = (field: number, encoded: Uint8Array): Uint8Array => bytesField(field, encoded);
const boolField = (field: number, value: boolean): Uint8Array =>
  value ? concatBytes(varint(field << 3), varint(1)) : new Uint8Array(0);
const uintField = (field: number, value: number | bigint): Uint8Array =>
  concatBytes(varint(field << 3), varint(value));

export interface KtConsistency {
  last?: number | bigint;
  distinguished?: number | bigint;
}

export interface KtUpdateRequest {
  searchKey: Uint8Array;
  value: Uint8Array;
  consistency?: KtConsistency;
  returnUpdateResponse?: boolean;
}

/** `transparency.UpdateRequest` → byte protobuf. */
export function encodeKtUpdateRequest(request: KtUpdateRequest): Uint8Array {
  const parts: Uint8Array[] = [bytesField(1, request.searchKey), bytesField(2, request.value)];

  // Field `consistency` WAJIB hadir (boleh kosong): server KT menolak update
  // dengan "consistency cannot be nil" bila field ini tidak ada — terverifikasi
  // terhadap binary Go yang sesungguhnya (lihat test live di tests/keyTransparency).
  const consistency: Uint8Array[] = [];
  if (request.consistency?.last !== undefined) consistency.push(uintField(1, request.consistency.last));
  if (request.consistency?.distinguished !== undefined) {
    consistency.push(uintField(2, request.consistency.distinguished));
  }
  parts.push(messageField(3, concatBytes(...consistency)));

  parts.push(boolField(5, request.returnUpdateResponse === true));
  return concatBytes(...parts);
}

/** Pembaca varint (untuk decode respon). */
function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    value |= BigInt(byte & 0x7f) << shift;
    index++;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

/** Bidang length-delimited/varint dari sebuah pesan protobuf. */
export function decodeProtoFields(bytes: Uint8Array): Map<number, Array<Uint8Array | bigint>> {
  const fields = new Map<number, Array<Uint8Array | bigint>>();
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) break;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 0x7n);
    offset = key.next;
    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) break;
      offset = value.next;
      fields.set(field, [...(fields.get(field) ?? []), value.value]);
    } else if (wire === 2) {
      const len = readVarint(bytes, offset);
      if (!len) break;
      const start = len.next;
      const end = start + Number(len.value);
      if (end > bytes.length) break;
      fields.set(field, [...(fields.get(field) ?? []), bytes.subarray(start, end)]);
      offset = end;
    } else if (wire === 5) {
      offset += 4;
    } else if (wire === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

export interface KtUpdateResponseSummary {
  /** Ukuran pohon setelah update, bila server mengembalikan tree head. */
  treeSize: bigint | null;
  /** Panjang proof VRF (byte), null bila tidak ada. */
  vrfProofLength: number | null;
  /** True bila server mengembalikan respons penuh (bukan duplikat/kosong). */
  hasUpdateProof: boolean;
}

/** Ambil ringkasan `transparency.UpdateResponse` tanpa perlu memverifikasi proof. */
export function summarizeKtUpdateResponse(bytes: Uint8Array): KtUpdateResponseSummary {
  if (bytes.length === 0) return { treeSize: null, vrfProofLength: null, hasUpdateProof: false };

  const response = decodeProtoFields(bytes);
  const treeHead = response.get(1)?.[0];
  let treeSize: bigint | null = null;
  if (treeHead instanceof Uint8Array) {
    const fullTreeHead = decodeProtoFields(treeHead);
    const head = fullTreeHead.get(1)?.[0];
    if (head instanceof Uint8Array) {
      const value = decodeProtoFields(head).get(1)?.[0];
      if (typeof value === 'bigint') treeSize = value;
    }
  }
  const vrfProof = response.get(2)?.[0];
  return {
    treeSize,
    vrfProofLength: vrfProof instanceof Uint8Array ? vrfProof.length : null,
    hasUpdateProof: response.has(3) || response.has(4),
  };
}

// ============================================================================
// Framing gRPC + transport HTTP/2
// ============================================================================

/** Bungkus pesan protobuf dalam frame gRPC (compress flag + panjang 4 byte BE). */
export function frameGrpcMessage(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + message.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, message.length, false);
  frame.set(message, 5);
  return frame;
}

/** Ambil pesan-pesan dari buffer frame gRPC (bisa >1, bisa belum lengkap). */
export function parseGrpcFrames(buffer: Uint8Array): { messages: Uint8Array[]; rest: Uint8Array } {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 5);
    const compressed = buffer[offset]!;
    const length = view.getUint32(1, false);
    if (buffer.length - offset - 5 < length) break;
    if (compressed !== 0) throw new Error('GRPC_COMPRESSED_MESSAGE_UNSUPPORTED');
    messages.push(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

export interface KtTransport {
  /** Kirim satu unary Update; mengembalikan byte `UpdateResponse`. */
  update(requestBytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * Transport gRPC HTTP/2 (h2c) tanpa dependensi. `endpoint` mis.
 * `http://127.0.0.1:8088` (test-update log v2).
 */
export function createGrpcKtTransport(input: { endpoint: string; timeoutMs?: number }): KtTransport {
  const timeoutMs = input.timeoutMs ?? 5000;

  return {
    update(requestBytes: Uint8Array): Promise<Uint8Array> {
      return new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const client = http2.connect(input.endpoint);
        const finish = (error: Error | null, value?: Uint8Array) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.close();
          if (error) reject(error);
          else resolve(value ?? new Uint8Array(0));
        };

        const timer = setTimeout(() => finish(new Error('KT_UPDATE_TIMEOUT')), timeoutMs);

        client.on('error', (err) => finish(err));

        const request = client.request({
          ':method': 'POST',
          ':path': KT_UPDATE_GRPC_PATH,
          'content-type': 'application/grpc+proto',
          te: 'trailers',
        });

        const chunks: Buffer[] = [];
        let grpcStatus: string | null = null;
        let grpcMessage = '';

        // Status bisa datang di header (trailers-only) atau di trailer; gRPC
        // meng-encode pesannya sebagai persen, jadi dibuka dulu sebelum dipakai.
        const readStatus = (headers: http2.IncomingHttpHeaders) => {
          const status = headers['grpc-status'];
          if (typeof status === 'string' || typeof status === 'number') grpcStatus = String(status);
          const message = headers['grpc-message'];
          if (typeof message === 'string' && message.length > 0) {
            try {
              grpcMessage = decodeURIComponent(message);
            } catch {
              grpcMessage = message;
            }
          }
        };

        request.on('response', readStatus);
        request.on('trailers', readStatus);
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('error', (err) => finish(err));
        request.on('end', () => {
          if (grpcStatus !== null && grpcStatus !== '0') {
            finish(new Error(`KT_UPDATE_GRPC_STATUS_${grpcStatus}${grpcMessage ? `:${grpcMessage}` : ''}`));
            return;
          }
          try {
            const { messages } = parseGrpcFrames(new Uint8Array(Buffer.concat(chunks)));
            finish(null, messages[0] ?? new Uint8Array(0));
          } catch (e) {
            finish(e as Error);
          }
        });

        request.end(Buffer.from(frameGrpcMessage(requestBytes)));
      });
    },
  };
}

// ============================================================================
// Entri log (format nilai NYX v2)
// ============================================================================

export interface KtLogEntryInput {
  /** usernameHash dari klien: base64url dari 32 byte. */
  usernameHash: string;
  identityKey: Uint8Array;
  pqIdentityKey: Uint8Array;
  signingKey: Uint8Array;
  /**
   * Verification key ML-DSA-65 (`nyx-pq-v2`). **Wajib**: nilai log hanya
   * ditulis dalam format v2 sehingga verifier mengikat kunci tanda tangan PQ,
   * bukan hanya X25519. Tanpa kunci ini entri dilewati
   * (`KT_V2_SIGNING_KEY_INVALID`, dihitung `result="invalid"`).
   */
  signingKeyV2?: Uint8Array | null;
  keyVersion: number;
  /** Bucket harian (`dayBucket()`) — presisi detik tidak pernah masuk log. */
  updatedAtDay: number;
}

export interface KtLogEntry {
  searchKey: Uint8Array;
  value: Uint8Array;
  keyVersion: number;
  /** Identitas log untuk dedupe/log (bukan identitas pengguna). */
  entryTag: string;
}

export function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/** Search key KT untuk usernameHash NYX: `0x75 || usernameHash`. */
export function ktSearchKey(usernameHash: Uint8Array): Uint8Array {
  if (usernameHash.length !== KT_USERNAME_HASH_BYTES) {
    throw new Error('KT_USERNAME_HASH_LENGTH_INVALID');
  }
  return concatBytes(new Uint8Array([KT_USERNAME_HASH_PREFIX]), usernameHash);
}

/** Tag entri untuk dedupe/log: sha256(searchKey) — tanpa identitas. */
export const ktEntryTag = (searchKey: Uint8Array): string =>
  createHash('sha256').update(searchKey).digest('hex').slice(0, 16);

/**
 * Digest nilai log. Dipakai sebagai bagian kunci dedupe: **perubahan kunci harus
 * tetap ditulis** (itu inti auditabilitas), jadi dedupe tidak boleh hanya
 * melihat (searchKey, keyVersion) — dua pemulihan akun berturut-turut punya
 * keyVersion yang sama tetapi nilai yang berbeda.
 */
export const ktValueDigest = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 8);

/** Bangun entri dari input mentah klien. Melempar bila bentuknya tidak sah. */
export function buildKtLogEntry(input: KtLogEntryInput): KtLogEntry {
  const usernameHash = decodeBase64Url(input.usernameHash);
  if (!usernameHash) throw new Error('KT_USERNAME_HASH_INVALID');

  const searchKey = ktSearchKey(usernameHash);
  // Tanpa ML-DSA-65 tidak ada nilai log yang sah: format v1 (Ed25519 saja)
  // sengaja TIDAK lagi ditulis sebagai fallback — pohon v1 sudah mati, jadi
  // entri tanpa kunci v2 lebih baik dilewati terlihat daripada menulis ke
  // format yang tidak bisa diverifikasi siapa pun.
  if (!input.signingKeyV2 || input.signingKeyV2.length !== ML_DSA_65_PUBLIC_KEY_BYTES) {
    throw new Error('KT_V2_SIGNING_KEY_INVALID');
  }
  const value = encodeKtValueV2({ ...input, signingKeyV2: input.signingKeyV2 });
  return { searchKey, value, keyVersion: input.keyVersion, entryTag: ktEntryTag(searchKey) };
}

// ============================================================================
// Penulis idempoten
// ============================================================================

const recentWrites = new Map<string, number>();

/** Hook test: buang dedupe. */
export function clearKtDedupeForTests(): void {
  recentWrites.clear();
}

export interface KtTargetResult {
  ok: boolean;
  skipped?: 'DISABLED' | 'DUPLICATE';
  reason?: string;
  treeSize?: bigint | null;
}

/**
 * Nama historis untuk hasil satu penulisan. Sejak log v1 dipensiunkan hanya ada
 * satu log, jadi bentuk bertingkat (`v2`) yang dulu ada sudah dihapus.
 */
export type KtCommitResult = KtTargetResult;

export interface KtWriteOptions {
  /** Hook test: transport injeksi (jangan sentuh jaringan/env nyata). */
  transport?: KtTransport;
  now?: number;
}

/** Transport nyata hanya dari `KT_V2_SERVER_URL`; transport injeksi = mode uji. */
function resolveTransport(options: KtWriteOptions): KtTransport | null {
  if (options.transport) return options.transport;
  const endpoint = process.env.KT_V2_SERVER_URL;
  if (!endpoint) return null;
  const timeoutMs = Number(process.env.KT_TIMEOUT_MS) || 5000;
  return createGrpcKtTransport({ endpoint, timeoutMs });
}

async function writeEntry(
  transport: KtTransport,
  entry: KtLogEntry,
  now: number
): Promise<KtTargetResult> {
  // Dedupe = (search key, versi kunci, nilai). Nilai yang sama tidak ditulis
  // dua kali; nilai yang BERUBAH selalu ditulis meski versinya sama.
  const dedupeKey = `${entry.entryTag}:${entry.keyVersion}:${ktValueDigest(entry.value)}`;
  const last = recentWrites.get(dedupeKey);
  if (last !== undefined && now - last < KT_DEDUPE_TTL_MS) {
    return { ok: true, skipped: 'DUPLICATE' };
  }

  try {
    const responseBytes = await transport.update(
      encodeKtUpdateRequest({
        searchKey: entry.searchKey,
        value: entry.value,
        returnUpdateResponse: true,
      })
    );
    const summary = summarizeKtUpdateResponse(responseBytes);

    recentWrites.set(dedupeKey, now);
    if (recentWrites.size > 10_000) {
      for (const [key, timestamp] of recentWrites) {
        if (now - timestamp >= KT_DEDUPE_TTL_MS) recentWrites.delete(key);
      }
    }

    incCounter(KT_WRITES, { result: 'ok' });
    setGauge(KT_LAST_SUCCESS, Math.floor(now / 1000));
    return { ok: true, treeSize: summary.treeSize };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN';
    incCounter(KT_WRITES, { result: 'error' });
    console.error(
      `[KT] Penulisan log gagal (entry ${entry.entryTag}, keyVersion ${entry.keyVersion}): ${reason}`
    );
    return { ok: false, reason };
  }
}

/**
 * Tulis satu entri ke log KT v2. **Tidak pernah melempar**: kegagalan dicatat
 * sebagai metrik + log (search key ter-hash) supaya registrasi tetap jalan, dan
 * operator melihatnya di dashboard/alert.
 */
export async function commitKeyTransparencyEntry(
  entry: KtLogEntry,
  options: KtWriteOptions = {}
): Promise<KtTargetResult> {
  const transport = resolveTransport(options);
  if (!transport) return { ok: false, skipped: 'DISABLED' };
  return writeEntry(transport, entry, options.now ?? Date.now());
}

/**
 * Jalur pakai di route: bangun entri lalu tulis. Bila bentuk input tidak sah
 * (mis. usernameHash bukan 32 byte), entri dilewati dengan peringatan — bukan
 * menulis nilai yang salah ke log publik.
 */
export async function publishKeyTransparencyEntry(
  input: KtLogEntryInput,
  options: KtWriteOptions = {}
): Promise<KtTargetResult> {
  if (!process.env.KT_V2_SERVER_URL && !options.transport) {
    return { ok: false, skipped: 'DISABLED' };
  }

  let entry: KtLogEntry;
  try {
    entry = buildKtLogEntry(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN';
    // [2026-10-15] Dua kegagalan ini punya sebab yang BERBEDA dan operator perlu
    // membedakannya di dashboard:
    //   - `KT_USERNAME_HASH_LENGTH_INVALID`: klien mengirim identifier dalam
    //     bentuk ter-pepper (64 hex) atau bentuk lain yang bukan Argon2id 32 byte.
    //     Search key log TIDAK bisa diturunkan darinya (server tak punya pepper
    //     di sisi ini), jadi entri dilewati — dan itu membuat pemulihan akun
    //     tidak terlihat di log, tepat peristiwa yang harus terlihat. Dihitung
    //     terpisah supaya kejadiannya kelihatan, bukan tercampur sebagai "invalid".
    //     Klien sudah diperbaiki (`resolveRecoveryIdentifierInput`); angka ini
    //     adalah jaring pengaman untuk klien/bundel lama.
    //   - sisanya: input cacat (panjang kunci salah, base64 rusak, atau bundle
    //     tanpa kunci ML-DSA-65 — `KT_V2_SIGNING_KEY_INVALID`).
    const result = reason === 'KT_USERNAME_HASH_LENGTH_INVALID'
      ? 'unsupported_identifier'
      : 'invalid';
    incCounter(KT_WRITES, { result });
    console.warn(`[KT] Entri log dilewati (keyVersion ${input.keyVersion}, ${result}): ${reason}`);
    return { ok: false, reason };
  }

  return commitKeyTransparencyEntry(entry, options);
}
