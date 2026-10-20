// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.6.4] Envelope distribusi sender-key grup.
 *
 * v2 (beku, tetap dibaca):
 *   [0x02][chainId(8)][u32 iter][CK(32)][metadataKey(32)] = 77 byte
 *
 * v3 (aktif saat PQ v2 menyala):
 *   [0x03][chainId(8)][u32 iter][CK(32)][metadataKey(32)][senderKeyId(8)] = 85 byte
 *
 * v4 (aktif saat PQ v2 menyala, 2026-10-20):
 *   [0x04][chainId(8)][u32 iter][CK(32)][metadataKey(32)][senderKeyId(8)][signingKeyV2(1952)] = 2037 byte
 *
 * `senderKeyId` adalah pengenal 8 byte turunan ML-DSA-65 public key pengirim
 * (`BLAKE2b-256("NYX-PQ-GROUP-V4" || signingKeyV2)[:8]`). Envelope v3 membawa
 * id ini agar penerima bisa memilih/mencocokkan kunci verifikasi anggota tanpa
 * menebak dari urutan state; field `senderSigningKeyV2` pada event distribusi
 * tetap dikirim untuk kompatibilitas pembaca v2.
 *
 * v4 membawa public key verifikasi pengirim DI DALAM envelope (yang sudah
 * diseal per-device), sehingga penerima tidak perlu lookup bundle untuk
 * memverifikasi metadata/pesan `sigV:2`. Ini menutup kasus klien penerima yang
 * belum bisa memetakan pseudonym pengirim (metadata belum ter-decrypt) dan
 * karena itu tidak bisa menemukan bundle perangkat pengirim.
 *
 * Envelope tidak memuat tanda tangan: seluruh isi sudah diseal per-device
 * (`pq_box_seal_v2`), sehingga hanya device tujuan yang bisa membukanya.
 */

import { blake2b } from '@noble/hashes/blake2.js';
import { ML_DSA_65_PUBLIC_KEY_BYTES } from './cryptoSuite.js';

export const GROUP_ENVELOPE_V2 = 0x02;
export const GROUP_ENVELOPE_V3 = 0x03;
export const GROUP_ENVELOPE_V4 = 0x04;
export const GROUP_CHAIN_ID_BYTES = 8;
export const GROUP_CHAIN_KEY_BYTES = 32;
export const GROUP_METADATA_KEY_BYTES = 32;
export const GROUP_SENDER_KEY_ID_BYTES = 8;
export const GROUP_ENVELOPE_V2_BYTES = 1 + GROUP_CHAIN_ID_BYTES + 4 + GROUP_CHAIN_KEY_BYTES + GROUP_METADATA_KEY_BYTES;
export const GROUP_ENVELOPE_V3_BYTES = GROUP_ENVELOPE_V2_BYTES + GROUP_SENDER_KEY_ID_BYTES;
export const GROUP_ENVELOPE_V4_BYTES = GROUP_ENVELOPE_V3_BYTES + ML_DSA_65_PUBLIC_KEY_BYTES;

const SENDER_KEY_ID_DOMAIN = 'NYX-PQ-GROUP-V4';

export interface GroupEnvelopeV2 {
  version: 2;
  chainId: Uint8Array;
  iteration: number;
  chainKey: Uint8Array;
  metadataKey: Uint8Array;
}

export interface GroupEnvelopeV3 extends Omit<GroupEnvelopeV2, 'version'> {
  version: 3;
  senderKeyId: Uint8Array;
}

export interface GroupEnvelopeV4 extends Omit<GroupEnvelopeV3, 'version'> {
  version: 4;
  signingKeyV2: Uint8Array;
}

export type GroupEnvelope = GroupEnvelopeV2 | GroupEnvelopeV3 | GroupEnvelopeV4;

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
  assertLength('chainId', envelope.chainId, GROUP_CHAIN_ID_BYTES);
  assertLength('chainKey', envelope.chainKey, GROUP_CHAIN_KEY_BYTES);
  assertLength('metadataKey', envelope.metadataKey, GROUP_METADATA_KEY_BYTES);
  if (!Number.isInteger(envelope.iteration) || envelope.iteration < 0 || envelope.iteration > 0xffffffff) {
    throw new Error('grup envelope: iteration di luar u32');
  }
  if (envelope.version === 3) {
    assertLength('senderKeyId', envelope.senderKeyId, GROUP_SENDER_KEY_ID_BYTES);
  } else if (envelope.version === 4) {
    assertLength('senderKeyId', envelope.senderKeyId, GROUP_SENDER_KEY_ID_BYTES);
    assertLength('signingKeyV2', envelope.signingKeyV2, ML_DSA_65_PUBLIC_KEY_BYTES);
    if (!constantTimeEqual(deriveGroupSenderKeyId(envelope.signingKeyV2), envelope.senderKeyId)) {
      throw new Error('grup envelope: senderKeyId tidak cocok dengan signingKeyV2');
    }
  } else if (envelope.version !== 2) {
    throw new Error(`grup envelope: versi ${String((envelope as { version?: unknown }).version)} tidak didukung`);
  }

  const size = envelope.version === 4
    ? GROUP_ENVELOPE_V4_BYTES
    : envelope.version === 3
      ? GROUP_ENVELOPE_V3_BYTES
      : GROUP_ENVELOPE_V2_BYTES;
  const out = new Uint8Array(size);
  out[0] = envelope.version;
  out.set(envelope.chainId, 1);
  new DataView(out.buffer).setUint32(9, envelope.iteration, false);
  out.set(envelope.chainKey, 13);
  out.set(envelope.metadataKey, 13 + GROUP_CHAIN_KEY_BYTES);
  if (envelope.version === 3 || envelope.version === 4) {
    out.set(envelope.senderKeyId, GROUP_ENVELOPE_V2_BYTES);
  }
  if (envelope.version === 4) {
    out.set(envelope.signingKeyV2, GROUP_ENVELOPE_V3_BYTES);
  }
  return out;
}

/**
 * Parse envelope v2/v3. Melempar untuk versi/panjang tak dikenal supaya
 * pemanggil bisa melaporkan envelope legacy secara terlihat (bukan diam-diam
 * kehilangan kunci grup).
 */
export function parseGroupEnvelope(bytes: Uint8Array): GroupEnvelope {
  if (bytes.length === 0) throw new Error('grup envelope: kosong');
  const version = bytes[0];
  if (version === GROUP_ENVELOPE_V2) {
    if (bytes.length !== GROUP_ENVELOPE_V2_BYTES) {
      throw new Error(`grup envelope: panjang v2 tidak sah (${bytes.length}, harus ${GROUP_ENVELOPE_V2_BYTES})`);
    }
  } else if (version === GROUP_ENVELOPE_V3) {
    if (bytes.length !== GROUP_ENVELOPE_V3_BYTES) {
      throw new Error(`grup envelope: panjang v3 tidak sah (${bytes.length}, harus ${GROUP_ENVELOPE_V3_BYTES})`);
    }
  } else if (version === GROUP_ENVELOPE_V4) {
    if (bytes.length !== GROUP_ENVELOPE_V4_BYTES) {
      throw new Error(`grup envelope: panjang v4 tidak sah (${bytes.length}, harus ${GROUP_ENVELOPE_V4_BYTES})`);
    }
  } else {
    throw new Error(`grup envelope: versi 0x${(version ?? 0).toString(16)} tidak didukung`);
  }

  const chainId = bytes.slice(1, 1 + GROUP_CHAIN_ID_BYTES);
  const iteration = new DataView(bytes.buffer, bytes.byteOffset + 9, 4).getUint32(0, false);
  const chainKey = bytes.slice(13, 13 + GROUP_CHAIN_KEY_BYTES);
  const metadataKey = bytes.slice(13 + GROUP_CHAIN_KEY_BYTES, GROUP_ENVELOPE_V2_BYTES);
  if (version === GROUP_ENVELOPE_V2) {
    return { version: 2, chainId, iteration, chainKey, metadataKey };
  }
  const senderKeyId = bytes.slice(GROUP_ENVELOPE_V2_BYTES, GROUP_ENVELOPE_V3_BYTES);
  if (version === GROUP_ENVELOPE_V3) {
    return { version: 3, chainId, iteration, chainKey, metadataKey, senderKeyId };
  }
  return {
    version: 4,
    chainId,
    iteration,
    chainKey,
    metadataKey,
    senderKeyId,
    signingKeyV2: bytes.slice(GROUP_ENVELOPE_V3_BYTES, GROUP_ENVELOPE_V4_BYTES),
  };
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
