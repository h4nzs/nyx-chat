// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 1.5] `pq_box_seal` **v2** — sealed box murni X-Wing.
 *
 * v1 (beku) membungkus envelope sebagai:
 *   `[ephemeral X25519 pub 32][X-Wing ct 1120][nonce 24][ct]`
 * sehingga setiap penyegelan ikut memuat DH X25519 (classical-only). v2 membuang
 * kunci klasik sepenuhnya: rahasia = X-Wing encapsulation ke kunci PQ penerima.
 *
 * Envelope v2 diberi magic 4 byte agar penerima bisa membedakannya dari v1
 * tanpa menebak panjang (v1 diawali 32 byte kunci publik ephemeral yang bisa
 * bernilai apa pun):
 *   `[magic 4][X-Wing ct 1120][nonce 24][ct]`
 *
 * Peluang kunci ephemeral v1 kebetulan berawalan magic adalah 2^-32; jalur
 * deteksi tetap memverifikasi sisa struktur (panjang minimum) sebelum memilih v2.
 */

import { XWING_CIPHERTEXT_BYTES } from './cryptoSuite.js';

/** Magic envelope v2: ASCII "NYS2". */
export const PQ_SEAL_V2_MAGIC = 0x4e595332;
export const PQ_SEAL_V2_HEADER_BYTES = 4;
export const PQ_SEAL_V2_CT_BYTES = XWING_CIPHERTEXT_BYTES;
export const PQ_SEAL_V2_NONCE_BYTES = 24;
/** Tag Poly1305 dari XChaCha20-Poly1305 IETF. */
export const PQ_SEAL_V2_TAG_BYTES = 16;
export const PQ_SEAL_V2_MIN_BYTES =
  PQ_SEAL_V2_HEADER_BYTES + PQ_SEAL_V2_CT_BYTES + PQ_SEAL_V2_NONCE_BYTES + PQ_SEAL_V2_TAG_BYTES;

export interface PqSealV2Parts {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  sealed: Uint8Array;
}

function assertLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new Error(`pq_seal v2: panjang ${name} tidak sah (${value.length}, harus ${expected})`);
  }
}

/** Serialisasi envelope v2: `[magic][ct][nonce][sealed]`. */
export function serializePqSealV2(parts: PqSealV2Parts): Uint8Array {
  assertLength('ciphertext', parts.ciphertext, PQ_SEAL_V2_CT_BYTES);
  assertLength('nonce', parts.nonce, PQ_SEAL_V2_NONCE_BYTES);
  if (parts.sealed.length < PQ_SEAL_V2_TAG_BYTES) {
    throw new Error('pq_seal v2: ciphertext ter-seal terlalu pendek');
  }
  const out = new Uint8Array(PQ_SEAL_V2_HEADER_BYTES + parts.ciphertext.length + parts.nonce.length + parts.sealed.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, PQ_SEAL_V2_MAGIC, false);
  let offset = PQ_SEAL_V2_HEADER_BYTES;
  out.set(parts.ciphertext, offset);
  offset += parts.ciphertext.length;
  out.set(parts.nonce, offset);
  offset += parts.nonce.length;
  out.set(parts.sealed, offset);
  return out;
}

/**
 * Apakah buffer tampak seperti envelope v2 (magic + panjang minimum)?
 * Fungsi ini hanya menyaring; kegagalan parse sebenarnya tetap dilempar oleh
 * `deserializePqSealV2`.
 */
export function isPqSealV2(buffer: Uint8Array): boolean {
  if (buffer.length < PQ_SEAL_V2_MIN_BYTES) return false;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return view.getUint32(0, false) === PQ_SEAL_V2_MAGIC;
}

/** Parse envelope v2; melempar bila magic/panjang tidak sah. */
export function deserializePqSealV2(buffer: Uint8Array): PqSealV2Parts {
  if (buffer.length < PQ_SEAL_V2_MIN_BYTES) {
    throw new Error('pq_seal v2: envelope terlalu pendek');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, false) !== PQ_SEAL_V2_MAGIC) {
    throw new Error('pq_seal v2: magic envelope tidak sah');
  }
  let offset = PQ_SEAL_V2_HEADER_BYTES;
  const ciphertext = buffer.slice(offset, offset + PQ_SEAL_V2_CT_BYTES);
  offset += PQ_SEAL_V2_CT_BYTES;
  const nonce = buffer.slice(offset, offset + PQ_SEAL_V2_NONCE_BYTES);
  offset += PQ_SEAL_V2_NONCE_BYTES;
  const sealed = buffer.slice(offset);
  return { ciphertext, nonce, sealed };
}
