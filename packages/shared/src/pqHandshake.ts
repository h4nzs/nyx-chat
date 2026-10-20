// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 1.4] Handshake X3DH **v2** — X-Wing murni + tanda tangan ML-DSA.
 *
 * Jalur v1 (beku, lihat `crypto.worker.ts` HANDSHAKE_VERSION 0x01) masih
 * mencampur DH X25519 (dh1–dh4) dengan X-Wing. v2 membuang seluruh DH:
 *
 *   rahasia sesi = BLAKE2b-256( ss_id ‖ ss_spk [‖ ss_otpk] )
 *
 * di mana tiap `ss_*` adalah shared secret dari **satu** encapsulation X-Wing:
 *   - `ss_id`  : X-Wing ke `pqIdentityKey` lawan (static-static)
 *   - `ss_spk` : X-Wing ke `pqSignedPreKey` lawan (memberi forward secrecy)
 *   - `ss_otpk`: X-Wing ke satu OTPK lawan (opsional)
 *
 * Tanpa DH, penerima tidak bisa menyimpulkan siapa pengirim dari matematika KEM
 * saja (siapa pun bisa melakukan encapsulation). Karena itu inisiator
 * **menandatangani transkrip** handshake dengan ML-DSA; penerima memverifikasi
 * dengan `signingKeyV2` inisiator (dari bundle/KT). Transkrip mengikat kedua
 * identitas + semua ciphertext, sehingga tanda tangan tidak bisa dipindah ke
 * handshake lain.
 *
 * Tanda tangan dihitung atas transkrip yang DIHASILKAN fungsi ini, dan verifikasi
 * memakai transkrip yang dibangun ulang dari ciphertext yang di-parse — bukan
 * atas byte serialisasi mentah — supaya field tanda tangan tidak masuk ke input.
 */

import {
  ML_DSA_65_PUBLIC_KEY_BYTES,
  ML_DSA_65_SIGNATURE_BYTES,
  X25519_PUBLIC_KEY_BYTES,
  XWING_CIPHERTEXT_BYTES,
} from './cryptoSuite.js';

/** Magic byte handshake NYX ('N'), sama dengan v1. */
export const HANDSHAKE_V2_MAGIC = 0x4e;
/** Versi wire handshake v2 (X-Wing murni + ML-DSA). */
export const HANDSHAKE_V2_VERSION = 0x02;
/** Bit flag: handshake menyertakan ciphertext OTPK. */
export const HANDSHAKE_V2_FLAG_OTPK = 0x01;

export const HANDSHAKE_V2_HEADER_BYTES = 4;
export const HANDSHAKE_V2_CT_BYTES = XWING_CIPHERTEXT_BYTES;

/** Panjang minimum v2 tanpa OTPK: header + 2 ct + tanda tangan. */
export const HANDSHAKE_V2_MIN_BYTES =
  HANDSHAKE_V2_HEADER_BYTES + 2 * HANDSHAKE_V2_CT_BYTES + ML_DSA_65_SIGNATURE_BYTES;

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, false);
}

function concatLengthPrefixed(fields: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const field of fields) total += 4 + field.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const field of fields) {
    writeU32(view, offset, field.length);
    offset += 4;
    out.set(field, offset);
    offset += field.length;
  }
  return out;
}

export interface HandshakeV2Ciphertexts {
  ctId: Uint8Array;
  ctSpk: Uint8Array;
  ctOtpk?: Uint8Array;
}

export interface HandshakeV2Parsed extends HandshakeV2Ciphertexts {
  signature: Uint8Array;
}

function assertLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new Error(`x3dh v2: panjang ${name} tidak sah (${value.length}, harus ${expected})`);
  }
}

/** Serialisasi wire v2: `[magic][version][flags][pad][ctId][ctSpk][ctOtpk?][signature]`. */
export function serializeHandshakeV2(input: HandshakeV2Ciphertexts & { signature: Uint8Array }): Uint8Array {
  assertLength('ctId', input.ctId, HANDSHAKE_V2_CT_BYTES);
  assertLength('ctSpk', input.ctSpk, HANDSHAKE_V2_CT_BYTES);
  if (input.ctOtpk) assertLength('ctOtpk', input.ctOtpk, HANDSHAKE_V2_CT_BYTES);
  assertLength('signature', input.signature, ML_DSA_65_SIGNATURE_BYTES);

  const hasOtpk = !!input.ctOtpk;
  const size =
    HANDSHAKE_V2_HEADER_BYTES +
    HANDSHAKE_V2_CT_BYTES * (hasOtpk ? 3 : 2) +
    ML_DSA_65_SIGNATURE_BYTES;
  const out = new Uint8Array(size);
  out[0] = HANDSHAKE_V2_MAGIC;
  out[1] = HANDSHAKE_V2_VERSION;
  out[2] = hasOtpk ? HANDSHAKE_V2_FLAG_OTPK : 0x00;
  out[3] = 0x00;
  let offset = HANDSHAKE_V2_HEADER_BYTES;
  out.set(input.ctId, offset);
  offset += HANDSHAKE_V2_CT_BYTES;
  out.set(input.ctSpk, offset);
  offset += HANDSHAKE_V2_CT_BYTES;
  if (input.ctOtpk) {
    out.set(input.ctOtpk, offset);
    offset += HANDSHAKE_V2_CT_BYTES;
  }
  out.set(input.signature, offset);
  return out;
}

/** Parse wire v2. Melempar bila magic/versi/panjang tidak sah. */
export function deserializeHandshakeV2(buffer: Uint8Array): HandshakeV2Parsed {
  if (buffer.length < HANDSHAKE_V2_MIN_BYTES) {
    throw new Error('x3dh v2: buffer handshake terlalu pendek');
  }
  if (buffer[0] !== HANDSHAKE_V2_MAGIC) {
    throw new Error('x3dh v2: magic byte handshake tidak sah');
  }
  if (buffer[1] !== HANDSHAKE_V2_VERSION) {
    throw new Error('x3dh v2: versi handshake tidak didukung');
  }
  const hasOtpk = (buffer[2]! & HANDSHAKE_V2_FLAG_OTPK) !== 0;
  const expected =
    HANDSHAKE_V2_HEADER_BYTES +
    HANDSHAKE_V2_CT_BYTES * (hasOtpk ? 3 : 2) +
    ML_DSA_65_SIGNATURE_BYTES;
  if (buffer.length !== expected) {
    throw new Error(`x3dh v2: panjang handshake tidak sah (${buffer.length}, harus ${expected})`);
  }
  let offset = HANDSHAKE_V2_HEADER_BYTES;
  const ctId = buffer.slice(offset, offset + HANDSHAKE_V2_CT_BYTES);
  offset += HANDSHAKE_V2_CT_BYTES;
  const ctSpk = buffer.slice(offset, offset + HANDSHAKE_V2_CT_BYTES);
  offset += HANDSHAKE_V2_CT_BYTES;
  let ctOtpk: Uint8Array | undefined;
  if (hasOtpk) {
    ctOtpk = buffer.slice(offset, offset + HANDSHAKE_V2_CT_BYTES);
    offset += HANDSHAKE_V2_CT_BYTES;
  }
  const signature = buffer.slice(offset, offset + ML_DSA_65_SIGNATURE_BYTES);
  return { ctId, ctSpk, ctOtpk, signature };
}

/**
 * Transkrip yang ditandatangani inisiator dan diverifikasi ulang penerima.
 * Mengikat kedua identitas + semua ciphertext (OTPK diwakili panjang 0 bila absen).
 * Domain ML-DSA (`PQ_V2_DOMAINS.HANDSHAKE`) dipegang lewat `context` saat sign/verify.
 */
export function buildHandshakeV2Transcript(input: {
  initiatorSigningKeyV2: Uint8Array;
  responderIdentityKey: Uint8Array;
  ctId: Uint8Array;
  ctSpk: Uint8Array;
  ctOtpk?: Uint8Array;
}): Uint8Array {
  assertLength('initiatorSigningKeyV2', input.initiatorSigningKeyV2, ML_DSA_65_PUBLIC_KEY_BYTES);
  assertLength('responderIdentityKey', input.responderIdentityKey, X25519_PUBLIC_KEY_BYTES);
  assertLength('ctId', input.ctId, HANDSHAKE_V2_CT_BYTES);
  assertLength('ctSpk', input.ctSpk, HANDSHAKE_V2_CT_BYTES);
  if (input.ctOtpk) assertLength('ctOtpk', input.ctOtpk, HANDSHAKE_V2_CT_BYTES);
  return concatLengthPrefixed([
    input.initiatorSigningKeyV2,
    input.responderIdentityKey,
    input.ctId,
    input.ctSpk,
    input.ctOtpk ?? new Uint8Array(0),
  ]);
}
