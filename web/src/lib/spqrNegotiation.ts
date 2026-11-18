// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.3.2] Kapabilitas jalur ratchet braid (SPQR).
 *
 * Tidak ada lagi negosiasi versi: braid v2 adalah satu-satunya jalur wire
 * (`spqrWire.ts`), jadi tidak ada `ackV`, kill switch, atau rollback yang perlu
 * diputuskan per pengiriman. Kapabilitas `spqr-ratchet` TETAP diiklankan —
 * relay memakainya untuk memastikan frame braid boleh lewat, dan sidecar wajib
 * memuatnya di `SERVER_CAPABILITIES`.
 */

import { CLIENT_CAPABILITIES } from '@nyx/shared';

/**
 * Nama kapabilitas saat pertukaran hello transport. Diambil dari
 * `@nyx/shared` (satu sumber dengan sidecar/klien lain) — bukan literal lokal,
 * supaya klien tidak bisa menyimpang dari konstanta yang diuji paritasnya.
 */
export const SPQR_CAPABILITY: string = CLIENT_CAPABILITIES.SPQR_RATCHET;

/** Kapabilitas yang diiklankan klien pada hello transport. */
export function advertisedCapabilities(): string[] {
  return [SPQR_CAPABILITY];
}
