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

  // Kasus 2: envelope N>0, atau state/envelope tanpa anchor — replay bila
  // state tidak lebih rendah DAN anchor (bila keduanya ada) identik.
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
  /** chainId era (wrapper v2) — identitas rantai eksplisit. */
  chainId?: string;
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
 * Pilih state rantai untuk sebuah pesan dengan mencocokkan `chainId` eksplisit
 * wrapper terhadap state (aktif + arsip). State aktif diprioritaskan di atas
 * arsip (libsignal: push_front + pop_back). Return null bila tidak ada yang
 * cocok — penebakan dilarang (sumber bug "MK lintas era tertukar" 2026-10-02).
 * [2026-10 legacy purge] Alias keyId (prefix CK) sudah dihapus.
 */
export function pickChainState<T extends ChainStateRef>(
  states: T[],
  ref: ChainRef
): T | null {
  const id = typeof ref.chainId === 'string' && ref.chainId.length > 0 ? ref.chainId : null;
  if (!id) return null;

  const live = states.filter(s => !s.archivedAt);
  const archived = states.filter(s => !!s.archivedAt);

  for (const pool of [live, archived]) {
    const hit = pool.find(s => s.chainId === id);
    if (hit) return hit;
  }
  return null;
}


/**
 * Apakah chainId yang datang adalah era yang SUDAH diarsipkan? Replay offline
 * (SYSTEM GROUP_KEY tersimpan) untuk era lama tidak boleh menimpa era aktif
 * yang lebih baru. `archivedAt` hanya ada pada snapshot arsip.
 */
export function isArchivedEraReplay(
  states: (ChainStateRef & { chainId?: string })[],
  chainId: string
): boolean {
  return states.some(s => s.chainId === chainId && !!s.archivedAt);
}
