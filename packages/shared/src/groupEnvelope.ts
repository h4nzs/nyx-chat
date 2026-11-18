// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.3.2] Envelope distribusi sender-key grup — hanya v4.
 *
 *   [0x04][chainId(8)][u32 iter][CK(32)][metadataKey(32)][senderKeyId(8)][signingKeyV2(1952)] = 2037 byte
 *
 * Bentuk v2 (77 byte, tanpa `senderKeyId`/`signingKeyV2`) dan v3 (85 byte, tanpa
 * `signingKeyV2`) tidak dibaca lagi: keduanya tidak membawa kunci verifikasi
 * pengirim, sehingga penerima harus menebak kunci dari urutan state. Envelope
 * versi lama ditolak dengan pesan jelas, bukan diturunkan ke bentuk v4.
 *
 * `senderKeyId` adalah pengenal 8 byte turunan ML-DSA-65 public key pengirim
 * (`BLAKE2b-256("NYX-PQ-GROUP-V4" || signingKeyV2)[:8]`), dipakai penerima untuk
 * mencocokkan kunci verifikasi anggota tanpa lookup bundle.
 *
 * Envelope tidak memuat tanda tangan: seluruh isi sudah diseal per-device
 * (`pq_box_seal_v2`), sehingga hanya device tujuan yang bisa membukanya.
 */

import { blake2b } from '@noble/hashes/blake2.js';
import { ML_DSA_65_PUBLIC_KEY_BYTES } from './cryptoSuite.js';

export const GROUP_ENVELOPE_V4 = 0x04;
export const GROUP_CHAIN_ID_BYTES = 8;
export const GROUP_CHAIN_KEY_BYTES = 32;
export const GROUP_METADATA_KEY_BYTES = 32;
export const GROUP_SENDER_KEY_ID_BYTES = 8;

const OFFSET_CHAIN_ID = 1;
const OFFSET_ITERATION = OFFSET_CHAIN_ID + GROUP_CHAIN_ID_BYTES;
const OFFSET_CHAIN_KEY = OFFSET_ITERATION + 4;
const OFFSET_METADATA_KEY = OFFSET_CHAIN_KEY + GROUP_CHAIN_KEY_BYTES;
const OFFSET_SENDER_KEY_ID = OFFSET_METADATA_KEY + GROUP_METADATA_KEY_BYTES;
const OFFSET_SIGNING_KEY_V2 = OFFSET_SENDER_KEY_ID + GROUP_SENDER_KEY_ID_BYTES;

export const GROUP_ENVELOPE_V4_BYTES = OFFSET_SIGNING_KEY_V2 + ML_DSA_65_PUBLIC_KEY_BYTES;

const SENDER_KEY_ID_DOMAIN = 'NYX-PQ-GROUP-V4';

export interface GroupEnvelope {
  version: 4;
  chainId: Uint8Array;
  iteration: number;
  chainKey: Uint8Array;
  metadataKey: Uint8Array;
  senderKeyId: Uint8Array;
  signingKeyV2: Uint8Array;
}

function assertLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new Error(`grup envelope: panjang ${name} tidak sah (${value.length}, harus ${expected})`);
  }
}

/** Pengenal 8 byte kunci verifikasi ML-DSA pengirim (domain-separated). */
export function deriveGroupSenderKeyId(signingKeyV2: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(SENDER_KEY_ID_DOMAIN);
  const input = new Uint8Array(domain.length + signingKeyV2.length);
  input.set(domain, 0);
  input.set(signingKeyV2, domain.length);
  return blake2b(input, { dkLen: 32 }).slice(0, GROUP_SENDER_KEY_ID_BYTES);
}

export function packGroupEnvelope(envelope: GroupEnvelope): Uint8Array {
  if (envelope.version !== 4) {
    throw new Error(`grup envelope: versi ${String((envelope as { version?: unknown }).version)} tidak didukung — hanya v4`);
  }
  assertLength('chainId', envelope.chainId, GROUP_CHAIN_ID_BYTES);
  assertLength('chainKey', envelope.chainKey, GROUP_CHAIN_KEY_BYTES);
  assertLength('metadataKey', envelope.metadataKey, GROUP_METADATA_KEY_BYTES);
  assertLength('senderKeyId', envelope.senderKeyId, GROUP_SENDER_KEY_ID_BYTES);
  assertLength('signingKeyV2', envelope.signingKeyV2, ML_DSA_65_PUBLIC_KEY_BYTES);
  if (!Number.isInteger(envelope.iteration) || envelope.iteration < 0 || envelope.iteration > 0xffffffff) {
    throw new Error('grup envelope: iteration di luar u32');
  }
  if (!constantTimeEqual(deriveGroupSenderKeyId(envelope.signingKeyV2), envelope.senderKeyId)) {
    throw new Error('grup envelope: senderKeyId tidak cocok dengan signingKeyV2');
  }

  const out = new Uint8Array(GROUP_ENVELOPE_V4_BYTES);
  out[0] = GROUP_ENVELOPE_V4;
  out.set(envelope.chainId, OFFSET_CHAIN_ID);
  new DataView(out.buffer).setUint32(OFFSET_ITERATION, envelope.iteration, false);
  out.set(envelope.chainKey, OFFSET_CHAIN_KEY);
  out.set(envelope.metadataKey, OFFSET_METADATA_KEY);
  out.set(envelope.senderKeyId, OFFSET_SENDER_KEY_ID);
  out.set(envelope.signingKeyV2, OFFSET_SIGNING_KEY_V2);
  return out;
}

/**
 * Parse envelope v4. Melempar untuk versi/panjang lain supaya pemanggil bisa
 * melaporkan envelope legacy secara terlihat (bukan diam-diam kehilangan kunci
 * grup).
 */
export function parseGroupEnvelope(bytes: Uint8Array): GroupEnvelope {
  if (bytes.length === 0) throw new Error('grup envelope: kosong');
  const version = bytes[0];
  if (version !== GROUP_ENVELOPE_V4) {
    throw new Error(`grup envelope: versi 0x${(version ?? 0).toString(16)} tidak didukung — hanya v4`);
  }
  if (bytes.length !== GROUP_ENVELOPE_V4_BYTES) {
    throw new Error(`grup envelope: panjang v4 tidak sah (${bytes.length}, harus ${GROUP_ENVELOPE_V4_BYTES})`);
  }

  return {
    version: 4,
    chainId: bytes.slice(OFFSET_CHAIN_ID, OFFSET_ITERATION),
    iteration: new DataView(bytes.buffer, bytes.byteOffset + OFFSET_ITERATION, 4).getUint32(0, false),
    chainKey: bytes.slice(OFFSET_CHAIN_KEY, OFFSET_METADATA_KEY),
    metadataKey: bytes.slice(OFFSET_METADATA_KEY, OFFSET_SENDER_KEY_ID),
    senderKeyId: bytes.slice(OFFSET_SENDER_KEY_ID, OFFSET_SIGNING_KEY_V2),
    signingKeyV2: bytes.slice(OFFSET_SIGNING_KEY_V2, GROUP_ENVELOPE_V4_BYTES),
  };
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
