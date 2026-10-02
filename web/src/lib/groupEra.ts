// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
// web/src/lib/groupEra.ts
//
// [INVARIANT 2 — IDEMPOTENT RECEIVE 2026-10-02]
// Deteksi replay distribusi sender key (pola libsignal
// process_sender_key_distribution_message: state era sama TIDAK pernah
// ditimpa/di-rewind). Helper pure — tanpa import store/worker — agar bisa
// di-unit-test langsung.

export interface EraStateSnapshot {
  /** Chain key posisi terkini (sudah ratchet maju). */
  CK: string;
  /** Posisi ratchet terkini. */
  N: number;
  /** Anchor chain key AWAL era (opsional — state legacy belum punya). */
  eraCK?: string;
}

/**
 * Apakah envelope distribusi yang datang adalah replay era yang SAMA dengan
 * state penerima sekarang?
 *
 * Envelope fulfillment selalu menyegel (initialCK, N=0) → envelope N=0 bukan
 * berarti era baru; bandingkan anchor era, bukan CK mentah (CK tersimpan
 * selalu posisi terkini — membandingkannya menyebabkan false "era baru" dan
 * rewind ke N=0 pada setiap offline sync, bug 2026-10-02).
 */
export function isSameEraDistribution(
  existing: EraStateSnapshot | null,
  incomingCK: string,
  incomingN: number
): boolean {
  if (!existing) return false;

  const incomingEraCK = incomingN === 0 ? incomingCK : undefined;

  // Kasus 1: kedua sisi ter-ancor → bandingkan anchor era.
  if (existing.eraCK && incomingEraCK) {
    return existing.eraCK === incomingEraCK;
  }

  // Kasus 2: legacy tanpa anchor + replay N=0 — state sudah ada dan maju;
  // envelope N=0 datang lagi = replay distribusi era yang sama.
  if (incomingN === 0) {
    return incomingN <= existing.N;
  }

  // Kasus 3: envelope N>0 — replay bila state tidak lebih rendah DAN
  // anchor (bila keduanya ada) identik.
  return existing.N >= incomingN &&
    (!existing.eraCK || !incomingEraCK || existing.eraCK === incomingEraCK);
}

// ---------------------------------------------------------------------------
// [REWRITE 2026-10-02 — ROUTING CHAIN ala libsignal]
// `sender_key_state_for_chain_id` (sender_keys.rs): pesan membawa identitas
// rantai eksplisit; penerima memilih state dari kumpulan record (aktif +
// arsip, maks MAX_SENDER_KEY_STATES). Helper PURE — di-unit-test langsung.
// ---------------------------------------------------------------------------

/** Referensi rantai yang dibawa wrapper pesan/metadata. */
export interface ChainRef {
  /** chainId era (wrapper baru) — 8-char prefix chain key awal era. */
  chainId?: string;
  /** keyId legacy (wrapper lama) — 8-char prefix CK pada posisi pesan. */
  keyId?: string;
}

export interface ChainStateRef {
  /** Identitas era eksplisit (state baru). */
  chainId?: string;
  /** Anchor era (state lama). */
  eraCK?: string;
  /** Chain key posisi terkini. */
  CK: string;
  /** Snapshot arsip era lama (archivedAt terisi). */
  archivedAt?: number;
}

/**
 * Pilih state rantai untuk sebuah pesan: cocokkan chainId (baru) lalu keyId
 * (legacy, domain sama — prefix CK) terhadap chainId/eraCK/CK tiap state.
 * State aktif diprioritaskan di atas arsip (libsignal: push_front + pop_back).
 * Return null bila tidak ada yang cocok — penebakan dilarang (sumber bug
 * "MK lintas era tertukar" 2026-10-02).
 */
export function pickChainState<T extends ChainStateRef>(
  states: T[],
  ref: ChainRef
): T | null {
  const ids = [ref.chainId, ref.keyId].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
  if (ids.length === 0) return null;

  const live = states.filter(s => !s.archivedAt);
  const archived = states.filter(s => !!s.archivedAt);

  for (const pool of [live, archived]) {
    for (const id of ids) {
      const hit =
        pool.find(s => s.chainId === id) ??
        pool.find(s => (s.eraCK ?? '').substring(0, 8) === id) ??
        pool.find(s => (s.CK ?? '').substring(0, 8) === id);
      if (hit) return hit;
    }
  }
  return null;
}
