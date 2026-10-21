// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Profil chaff transport (datagram penyamaran idle).
 *
 * Aturan yang dikodekan di sini, bukan di worker:
 *  - **Tab background = chaff berhenti.** Chaff dari tab yang tidak dilihat
 *    tidak menyamarkan siapa pun: ia justru menandai "app dibuka" lewat
 *    lonjakan trafik, dan membakar kuota. Cover traffic aplikasi pun memakai
 *    aturan visibilitas yang sama (26.10.3).
 *  - **Mode Maximum menaikkan denyut** (2 s vs 3 s) tanpa mengubah ukuran
 *    datagram — ukuran >1000 byte berisiko di-drop QUIC.
 *  - Nilai selalu di-clamp; worker juga meng-clamp ulang sebagai pertahanan
 *    kedua (pesan worker bisa datang dari jalur lain di masa depan).
 */

export interface ChaffProfile {
  enabled: boolean;
  intervalMs: number;
  jitterMs: number;
  sizeBytes: number;
}

export const CHAFF_BASE_INTERVAL_MS = 3000;
export const CHAFF_BASE_JITTER_MS = 500;
export const CHAFF_MAXIMUM_INTERVAL_MS = 2000;
export const CHAFF_MAXIMUM_JITTER_MS = 400;
/** ≤ MTU datagram QUIC (~1200 B) agar tidak drop diam-diam. */
export const CHAFF_MAX_DATAGRAM_BYTES = 1000;

export function resolveChaffProfile(input: {
  visible: boolean;
  maximum?: boolean;
}): ChaffProfile {
  if (!input.visible) {
    return {
      enabled: false,
      intervalMs: CHAFF_BASE_INTERVAL_MS,
      jitterMs: CHAFF_BASE_JITTER_MS,
      sizeBytes: CHAFF_MAX_DATAGRAM_BYTES,
    };
  }
  return {
    enabled: true,
    intervalMs: input.maximum ? CHAFF_MAXIMUM_INTERVAL_MS : CHAFF_BASE_INTERVAL_MS,
    jitterMs: input.maximum ? CHAFF_MAXIMUM_JITTER_MS : CHAFF_BASE_JITTER_MS,
    sizeBytes: CHAFF_MAX_DATAGRAM_BYTES,
  };
}
