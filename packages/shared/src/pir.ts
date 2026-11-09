// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP1] Kontrak wire PIR dua server (`xor-pir-v1`).
 *
 * Tiga hal yang dibekukan di sini dan dipakai bersama oleh server (builder
 * snapshot, sidecar) dan klien (pencarian):
 *
 *  1. Record v2 — `version | ix | len | body | padding | ck`. `ix` mengikat
 *     record ke `oprfIndex` sehingga satu server tidak bisa mengembalikan
 *     record pengguna lain.
 *  2. Kandidat slot — 3 slot per kunci (cuckoo). Klien menanyakan ketiganya
 *     lewat XOR-PIR dan memilih record yang `ix`-nya cocok; tidak ada filter
 *     yang perlu diunduh.
 *  3. Manifest shard — ditandatangani ML-DSA-65. Dua server harus menyajikan
 *     manifest yang sama (kecuali `operator`), atau klien menolak (`PIR_DESYNC`).
 *
 * Validasi di sini sengaja manual, bukan zod: modul ini dipakai di bundel prod
 * dengan CSP tanpa `unsafe-eval`, dan aturan "zod jitless" hanya berlaku pada
 * skema yang dibuat lewat `schemas.ts`. Parser manual tidak bisa lupa.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const PIR_SUITE = 'xor-pir-v1' as const;
export const PIR_RECORD_VERSION = 2;

export const PIR_INDEX_BYTES = 32;
export const PIR_RECORD_HEADER_BYTES = 1 + PIR_INDEX_BYTES + 2;
export const PIR_RECORD_TAG_BYTES = 16;
export const PIR_MIN_RECORD_BYTES = 256;
export const PIR_MAX_RECORD_BYTES = 16 * 1024;

/** Jumlah slot kandidat per kunci (cuckoo 3-pilihan). */
export const PIR_SLOT_CANDIDATES = 3;

/** Context ML-DSA untuk tanda tangan manifest; dipakai server dan klien. */
export const PIR_MANIFEST_DOMAIN = 'nyx-pir-manifest-v1';

const RECORD_INDEX_DOMAIN = new TextEncoder().encode('nyx:pir:record-index:v1\0');
const SLOT_DOMAIN = new TextEncoder().encode('nyx:pir:slot:v1\0');
const MANIFEST_DOMAIN = 'nyx:pir:manifest:v1\0';

export type PirVerdict =
  | 'PIR_RECORD_MISS'
  | 'PIR_RECORD_INVALID'
  | 'PIR_TAMPERED'
  | 'PIR_DESYNC'
  | 'PIR_UNAVAILABLE'
  | 'PIR_ROLLBACK';

export class PirRecordError extends Error {
  constructor(
    readonly code: Extract<PirVerdict, 'PIR_RECORD_INVALID'>,
    message: string = code,
  ) {
    super(message);
    this.name = 'PirRecordError';
  }
}

/** `ix` record: SHA-256 berdomain atas index OPRF 32 byte. */
export function pirRecordIndexTag(oprfIndex: Uint8Array): Uint8Array {
  if (oprfIndex.length !== PIR_INDEX_BYTES) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'oprfIndex harus 32 byte');
  }
  const input = new Uint8Array(RECORD_INDEX_DOMAIN.length + oprfIndex.length);
  input.set(RECORD_INDEX_DOMAIN, 0);
  input.set(oprfIndex, RECORD_INDEX_DOMAIN.length);
  return sha256(input);
}

/** Tiga slot kandidat (terurut, unik) untuk sebuah index, dalam satu shard. */
export function pirRecordCandidates(oprfIndex: Uint8Array, slotCount: number): number[] {
  if (oprfIndex.length !== PIR_INDEX_BYTES) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'oprfIndex harus 32 byte');
  }
  if (!Number.isSafeInteger(slotCount) || slotCount < 1) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'slotCount tidak valid');
  }
  const slots: number[] = [];
  const seen = new Set<number>();
  for (let counter = 0; slots.length < PIR_SLOT_CANDIDATES && counter < 64; counter += 1) {
    const input = new Uint8Array(SLOT_DOMAIN.length + oprfIndex.length + 1);
    input.set(SLOT_DOMAIN, 0);
    input.set(oprfIndex, SLOT_DOMAIN.length);
    input[input.length - 1] = counter;
    const digest = sha256(input);
    const value =
      ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
    const slot = value % slotCount;
    if (seen.has(slot)) continue;
    seen.add(slot);
    slots.push(slot);
  }
  // slotCount kecil (< 3) tidak bisa memberi 3 slot unik; itu kesalahan konfigurasi.
  if (slots.length !== PIR_SLOT_CANDIDATES) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'slotCount terlalu kecil untuk 3 kandidat');
  }
  return slots;
}

export interface PirRecordInput {
  /** Index OPRF 32 byte milik pengguna. */
  oprfIndex: Uint8Array;
  /** Body JSON (UTF-8) yang akan disimpan. */
  body: Uint8Array;
  /** Ukuran record tetap per shard. */
  recordBytes: number;
}

export function encodePirRecord({ oprfIndex, body, recordBytes }: PirRecordInput): Uint8Array {
  if (
    !Number.isSafeInteger(recordBytes) ||
    recordBytes < PIR_MIN_RECORD_BYTES ||
    recordBytes > PIR_MAX_RECORD_BYTES
  ) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'recordBytes di luar batas');
  }
  const bodyLimit = recordBytes - PIR_RECORD_HEADER_BYTES - PIR_RECORD_TAG_BYTES;
  if (body.length > bodyLimit) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'body melebihi recordBytes');
  }
  const out = new Uint8Array(recordBytes);
  out[0] = PIR_RECORD_VERSION;
  out.set(pirRecordIndexTag(oprfIndex), 1);
  out[33] = (body.length >>> 8) & 0xff;
  out[34] = body.length & 0xff;
  out.set(body, PIR_RECORD_HEADER_BYTES);
  const tag = sha256(out.subarray(0, recordBytes - PIR_RECORD_TAG_BYTES));
  out.set(tag.subarray(0, PIR_RECORD_TAG_BYTES), recordBytes - PIR_RECORD_TAG_BYTES);
  return out;
}

export type PirRecordDecode =
  | { status: 'miss' }
  /** Slot valid milik kunci lain (checksum benar, `ix` berbeda). */
  | { status: 'other' }
  | { status: 'ok'; body: Uint8Array };

function allZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] !== 0) return false;
  return true;
}

function equalsConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Dekode record hasil XOR dua server.
 *
 * Tiga hasil, dan perbedaannya adalah inti `docs/42`:
 *  - `miss`  — slot kosong (semua byte nol).
 *  - `other` — slot berisi record sah milik kunci lain (checksum benar, `ix`
 *    berbeda). Bukan serangan: klien lanjut ke slot kandidat berikutnya.
 *  - `ok`    — record milik `oprfIndex` ini.
 *
 * Versi tak dikenal, panjang aneh, atau checksum salah **melempar**
 * `PIR_RECORD_INVALID`; pemanggil memetakannya ke `PIR_TAMPERED`, tidak pernah
 * ke "tidak ditemukan".
 */
export function decodePirRecord(bytes: Uint8Array, oprfIndex: Uint8Array): PirRecordDecode {
  if (bytes.length < PIR_MIN_RECORD_BYTES) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'record terlalu pendek');
  }
  if (allZero(bytes)) return { status: 'miss' };
  if (bytes[0] !== PIR_RECORD_VERSION) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'versi record tidak dikenal');
  }
  const bodyLength = (bytes[33]! << 8) | bytes[34]!;
  const bodyLimit = bytes.length - PIR_RECORD_HEADER_BYTES - PIR_RECORD_TAG_BYTES;
  if (bodyLength > bodyLimit) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'panjang body melebihi record');
  }
  const tag = sha256(bytes.subarray(0, bytes.length - PIR_RECORD_TAG_BYTES));
  if (
    !equalsConstantTime(
      tag.subarray(0, PIR_RECORD_TAG_BYTES),
      bytes.subarray(bytes.length - PIR_RECORD_TAG_BYTES),
    )
  ) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'checksum record salah');
  }
  const expectedTag = pirRecordIndexTag(oprfIndex);
  if (!equalsConstantTime(bytes.subarray(1, 1 + PIR_INDEX_BYTES), expectedTag)) {
    return { status: 'other' };
  }
  return {
    status: 'ok',
    body: bytes.subarray(PIR_RECORD_HEADER_BYTES, PIR_RECORD_HEADER_BYTES + bodyLength),
  };
}

export interface PirManifest {
  suite: typeof PIR_SUITE;
  shard: number;
  shardCount: number;
  slotCount: number;
  recordBytes: number;
  epoch: number;
  entryCount: number;
  /** sha256 hex atas slot terurut (32 byte). */
  dbRoot: string;
  /** Identitas penandatangan, mis. `nyx-a`. */
  operator: string;
  /** sha256 hex atas kunci publik ML-DSA yang menandatangani. */
  keyId: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

function assertInteger(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`PIR manifest: ${label} tidak valid`);
  }
  return value;
}

export function parsePirManifest(raw: unknown): PirManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('PIR manifest: bukan objek');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.suite !== PIR_SUITE) throw new Error('PIR manifest: suite tidak didukung');
  const shard = assertInteger(obj.shard, 'shard', 0);
  const shardCount = assertInteger(obj.shardCount, 'shardCount', 1);
  if (shard >= shardCount) throw new Error('PIR manifest: shard di luar shardCount');
  const slotCount = assertInteger(obj.slotCount, 'slotCount', PIR_SLOT_CANDIDATES);
  const recordBytes = assertInteger(obj.recordBytes, 'recordBytes', PIR_MIN_RECORD_BYTES);
  if (recordBytes > PIR_MAX_RECORD_BYTES) {
    throw new Error('PIR manifest: recordBytes di luar batas');
  }
  const epoch = assertInteger(obj.epoch, 'epoch', 1);
  const entryCount = assertInteger(obj.entryCount, 'entryCount', 0);
  if (entryCount > slotCount) throw new Error('PIR manifest: entryCount melebihi slotCount');
  if (typeof obj.dbRoot !== 'string' || !HEX32.test(obj.dbRoot)) {
    throw new Error('PIR manifest: dbRoot bukan sha256 hex');
  }
  if (typeof obj.keyId !== 'string' || !HEX32.test(obj.keyId)) {
    throw new Error('PIR manifest: keyId bukan sha256 hex');
  }
  if (typeof obj.operator !== 'string' || obj.operator.length === 0 || obj.operator.length > 64) {
    throw new Error('PIR manifest: operator tidak valid');
  }
  return {
    suite: PIR_SUITE,
    shard,
    shardCount,
    slotCount,
    recordBytes,
    epoch,
    entryCount,
    dbRoot: obj.dbRoot,
    operator: obj.operator,
    keyId: obj.keyId,
  };
}

function manifestFields(manifest: PirManifest, withOperator: boolean): string {
  const fields = [
    manifest.suite,
    String(manifest.shard),
    String(manifest.shardCount),
    String(manifest.slotCount),
    String(manifest.recordBytes),
    String(manifest.epoch),
    String(manifest.entryCount),
    manifest.dbRoot,
    manifest.keyId,
  ];
  if (withOperator) fields.push(manifest.operator);
  return MANIFEST_DOMAIN + fields.join('|');
}

/** Byte yang ditandatangani ML-DSA-65 (mencakup `operator`). */
export function pirManifestMessage(manifest: PirManifest): Uint8Array {
  return new TextEncoder().encode(manifestFields(manifest, true));
}

/**
 * Dua server dianggap sepakat bila semua field kecuali `operator` sama.
 * `keyId` ikut dibandingkan: kunci berbeda berarti operator berbeda.
 */
export function pirManifestsAgree(a: PirManifest, b: PirManifest): boolean {
  return manifestFields(a, false) === manifestFields(b, false);
}

/**
 * Shard untuk sebuah indeks: 4 byte pertama `sha256(oprfIndex)` mod `shardCount`.
 * Builder dan klien WAJIB memakai fungsi ini; kalau keduanya menghitung sendiri,
 * satu perbedaan kecil membuat semua pencarian "tidak ditemukan".
 */
export function pirShardFor(oprfIndex: Uint8Array, shardCount: number): number {
  if (oprfIndex.length !== PIR_INDEX_BYTES) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'oprfIndex harus 32 byte');
  }
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'shardCount tidak valid');
  }
  const digest = sha256(oprfIndex);
  const value = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return value % shardCount;
}

/** Panjang share: `ceil(slotCount/8)` byte, bit i = byte i/8, LSB-first. */
export function pirShareLen(slotCount: number): number {
  return Math.ceil(slotCount / 8);
}

/** `share[slot/8] ^= 1 << (slot%8)` — membalik satu bit tanpa menyalin. */
export function pirShareToggle(share: Uint8Array, slot: number): void {
  const byte = slot >>> 3;
  if (byte >= share.length) throw new PirRecordError('PIR_RECORD_INVALID', 'slot di luar share');
  share[byte] = share[byte]! ^ (1 << (slot & 7));
}

/** XOR dua jawaban; panjang berbeda berarti salah satu server menjawab ngawur. */
export function pirXor(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new PirRecordError('PIR_RECORD_INVALID', 'panjang jawaban server berbeda');
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** `dbRoot` atas slot terurut; builder dan verifikator memakai fungsi yang sama. */
export function pirDbRoot(slots: Uint8Array[], recordBytes: number): string {
  const hash = sha256.create();
  const length = new Uint8Array(4);
  length[0] = (recordBytes >>> 24) & 0xff;
  length[1] = (recordBytes >>> 16) & 0xff;
  length[2] = (recordBytes >>> 8) & 0xff;
  length[3] = recordBytes & 0xff;
  hash.update(length);
  for (const slot of slots) {
    if (slot.length !== recordBytes) throw new Error('PIR dbRoot: ukuran slot tidak seragam');
    hash.update(slot);
  }
  return bytesToHex(hash.digest());
}
