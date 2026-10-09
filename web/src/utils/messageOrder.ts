// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 2 — B1] Urutan pesan di klien.
 *
 * Penentu urutan utama adalah `seq` yang ditetapkan server per-conversation
 * (jam dinding `createdAt` sudah dikasar ke bucket 15 menit, jadi TIDAK boleh
 * dipakai sebagai penentu utama). Dua kasus khusus:
 *
 *  - **Pesan pending/optimistik** (belum di-ACK server, belum punya `seq`)
 *    harus dianggap PALING BARU — bukan `seq = 0`. Kalau tidak, bubble
 *    "SENDING" akan melompat ke atas riwayat (posisi terlama) setiap kali
 *    state di-sort ulang (pesan masuk, sync, dsb). Offline queue bisa tertahan
 *    lama, jadi ini bukan sekadar kilatan sesaat.
 *  - **Baris legacy** yang belum punya `seq` (seq = 0) memang pesan lama →
 *    tetap di bawah pesan ber-seq.
 */

/** Bentuk minimal yang dibutuhkan — `Message` dari shared memenuhi ini. */
export interface OrderableMessage {
  seq?: number;
  sentAt?: number;
  createdAt?: string | Date;
  optimistic?: boolean;
  tempId?: number;
  id?: string;
}

const PENDING_RANK = Number.MAX_SAFE_INTEGER;

/** Pesan yang belum punya `seq` server (bubble optimistik / antrean offline). */
export function isPendingMessage(m: OrderableMessage): boolean {
  if (m.optimistic === true) return true;
  if (typeof m.tempId === 'number') return true;
  // Sabuk-dan-gesper: beberapa jalur hanya menandai id `temp_<n>`.
  return typeof m.id === 'string' && m.id.startsWith('temp_');
}

function orderRank(m: OrderableMessage): number {
  if (typeof m.seq === 'number' && m.seq > 0) return m.seq;
  return isPendingMessage(m) ? PENDING_RANK : 0;
}

function messageTimeMs(m: OrderableMessage): number {
  if (typeof m.sentAt === 'number' && Number.isFinite(m.sentAt)) return m.sentAt;
  const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/** Naik (oldest → newest). 0 = urutan sama; pemanggil boleh menambah tie-break. */
export function compareMessagesByOrder(a: OrderableMessage, b: OrderableMessage): number {
  const ra = orderRank(a);
  const rb = orderRank(b);
  if (ra !== rb) return ra - rb;
  return messageTimeMs(a) - messageTimeMs(b);
}
