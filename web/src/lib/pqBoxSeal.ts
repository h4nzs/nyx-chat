// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 1.5 / PQ-only 2026-10-23] Choke point sealed box per-device.
 *
 * Hanya v2 (X-Wing murni, magic `NYS2`) yang dipakai. Jalur hybrid v1
 * (DH X25519 + X-Wing) dan `crypto_box_seal` v1 dihapus bersama fallback-nya:
 * tidak ada lagi ciphertext yang boleh dibuat dengan format lama. Parameter
 * kunci klasik tetap diterima agar pemanggil tidak perlu diubah, tetapi
 * diabaikan — pembukaan hanya menerima envelope `isPqSealV2`.
 */

import { isPqSealV2 } from '@nyx/shared';
import { worker_pq_box_seal_v2, worker_pq_box_seal_v2_open } from './crypto-worker-proxy';

export async function sealForDevice(
  message: Uint8Array | string,
  pqPublicKey: Uint8Array,
  _classicalPublicKey?: Uint8Array
): Promise<Uint8Array> {
  return worker_pq_box_seal_v2(message, pqPublicKey);
}

export async function openSealedForDevice(
  sealed: Uint8Array,
  pqPrivateKey: Uint8Array,
  _classicalPrivateKey?: Uint8Array
): Promise<Uint8Array> {
  if (!isPqSealV2(sealed)) {
    throw new Error('sealed box v1 tidak lagi didukung (PQ-only)');
  }
  return worker_pq_box_seal_v2_open(sealed, pqPrivateKey);
}
