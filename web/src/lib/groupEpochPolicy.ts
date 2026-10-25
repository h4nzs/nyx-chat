// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.6] Kebijakan rotasi era grup (PCS kasar, tanpa MLS).
 *
 * Batas kejujuran yang harus tetap ditulis di UI/dokumen: ini BUKAN PCS
 * per-pesan. Kompromi satu anggota masih bisa membaca era yang sedang berjalan
 * sampai rotasi berikutnya; yang dikurangi adalah panjang jendela itu.
 *
 * Dua pemicu, keduanya dari data server (klien tidak menyimpan counter):
 *  - **umur**: `now - anchor >= GROUP_EPOCH_MAX_AGE_MS` (default 24 jam);
 *  - **jumlah pesan**: `messageSeq - messageSeqSaatRotasi >=
 *    GROUP_EPOCH_MAX_MESSAGES` (default 500).
 *
 * `anchor` = yang paling baru antara `epochRotatedAt` (server), catatan lokal
 * saat klien ini merotasi, dan `createdAt`. Kalau semuanya tidak ada, pakai
 * `now` — grup tanpa data tidak boleh memicu rotasi massal saat app dibuka.
 */

export const GROUP_EPOCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const GROUP_EPOCH_MAX_MESSAGES = 500;

export interface ServerEpochState {
  rotatedAt?: number | null;
  createdAt?: number | null;
  messageSeq?: number | null;
}

export interface LocalEpochState {
  rotatedAt?: number;
  messageSeq?: number;
}

export interface EpochRotationInput {
  now: number;
  server: ServerEpochState;
  local?: LocalEpochState | null;
  maxAgeMs?: number;
  maxMessages?: number;
}

export type EpochRotationReason = 'age' | 'messages';

export type EpochRotationDecision =
  | { rotate: true; reason: EpochRotationReason }
  | { rotate: false; reason: 'fresh' };

function positive (value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function decideEpochRotation (input: EpochRotationInput): EpochRotationDecision {
  const maxAgeMs = input.maxAgeMs ?? GROUP_EPOCH_MAX_AGE_MS;
  const maxMessages = input.maxMessages ?? GROUP_EPOCH_MAX_MESSAGES;

  const anchor = Math.max(
    positive(input.server.rotatedAt),
    positive(input.local?.rotatedAt),
    positive(input.server.createdAt),
  ) || input.now;

  // Baseline hanya dari catatan lokal: server menghitung `messageSeq` sepanjang
  // umur percakapan, jadi tanpa baseline setiap grup lama langsung "jatuh tempo".
  const messageBaseline = positive(input.local?.messageSeq);
  const messagesSince = positive(input.server.messageSeq) - messageBaseline;
  if (messagesSince >= maxMessages) return { rotate: true, reason: 'messages' };

  if (input.now - anchor >= maxAgeMs) return { rotate: true, reason: 'age' };
  return { rotate: false, reason: 'fresh' };
}
