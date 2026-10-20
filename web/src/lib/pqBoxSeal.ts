// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 1.5] Choke point sealed box per-device v1/v2.
 *
 * v1 (beku) mencampur DH X25519 + X-Wing; v2 murni X-Wing. Penyegelan memilih
 * versi lewat gerbang `VITE_PQ_V2`; pembukaan mendeteksi versi dari magic
 * envelope (`isPqSealV2`), jadi ciphertext v1 yang beredar tetap bisa dibuka.
 */

import { isPqSealV2 } from '@nyx/shared';
import {
  worker_pq_box_seal,
  worker_pq_box_seal_open,
  worker_pq_box_seal_v2,
  worker_pq_box_seal_v2_open,
} from './crypto-worker-proxy';
import { resolvePqV2Enabled } from './pqCapability';

export async function sealForDevice(
  message: Uint8Array | string,
  pqPublicKey: Uint8Array,
  classicalPublicKey: Uint8Array
): Promise<Uint8Array> {
  if (resolvePqV2Enabled()) {
    return worker_pq_box_seal_v2(message, pqPublicKey);
  }
  return worker_pq_box_seal(message, pqPublicKey, classicalPublicKey);
}

export async function openSealedForDevice(
  sealed: Uint8Array,
  pqPrivateKey: Uint8Array,
  classicalPrivateKey: Uint8Array
): Promise<Uint8Array> {
  if (isPqSealV2(sealed)) {
    return worker_pq_box_seal_v2_open(sealed, pqPrivateKey);
  }
  return worker_pq_box_seal_open(sealed, pqPrivateKey, classicalPrivateKey);
}
