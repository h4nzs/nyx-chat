// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-admin@nyx-app.my.id].

// Inti mutex lintas-tab via Service Worker — logika REGISTRY murni dan SYNC.
//
// KENAPA SW: navigator.locks (Web Locks API) adalah satu-satunya primitif
// browser untuk mutual exclusion lintas-tab, tapi tidak semua browser
// memilikinya. Service Worker adalah SATU-SATUNYA konteks eksekusi lain yang
// TUNGGAL per-origin — semua tab berbicara dengan instance SW yang sama, jadi
// state di sini benar-benar shared dan operasi acquire/release-nya sejati
// (berbeda dengan localStorage yang tanpa test-and-set atomik).
//
// DESAIN HEARTBEAT: pemegang lock WAJIB mengirim HEARTBEAT berkala (client
// mengirim tiap 1s; lihat swMutexClient). Lock dianggap BASI bila tidak ada
// heartbeat dalam LOCK_STALE_MS — tab yang crash/tutup tanpa release tidak
// menggantung pemohon berikutnya selamanya. (Semua tab sama-origin berbagi
// event loop SW; timer heartbeat dijalan oleh tab aktif mana pun yang sedang
// menunggu/memegang — pemegang sejati mengirimnya dari intervaL-nya sendiri.)
//
// File ini SENGAJA tanpa import dan tanpa async: semua fungsi sinkron dan
// murni terhadap registry yang diberikan, sehingga unit test bisa memverifikasi
// semantics exclusion tanpa mock DOM/MessageChannel.

/** Lock dianggap basi bila tidak ada heartbeat selama rentang ini (ms). */
export const LOCK_STALE_MS = 4000;

export interface MutexEntry {
  /** Identifier uneg pemegang lock (crypto.randomUUID() per tab). */
  holderId: string;
  /** Timestamp heartbeat terakhir (Date.now() saat pesan diproses SW). */
  lastBeat: number;
}

export type MutexRegistry = Record<string, MutexEntry>;

/** Aksi pesan client → SW (lihat swMutexClient.ts / handler di sw.ts). */
export type MutexRequest =
  | { type: 'ACQUIRE'; lockName: string; holderId: string; now: number }
  | { type: 'HEARTBEAT'; lockName: string; holderId: string; now: number }
  | { type: 'RELEASE'; lockName: string; holderId: string; now: number };

/** Respons SW → client. granted=false berarti lock dipegang pihak lain. */
export type MutexResponse = { granted: boolean; holder: 'you' | 'other' | 'none' };

/** Buat registry kosong (dipakai SW saat init & unit test per kasus). */
export function createMutexRegistry(): MutexRegistry {
  return {};
}

/**
 * Bersihkan entri basi (tanpa heartbeat dalam LOCK_STALE_MS) — dipanggil di
 * awal SETIAP operasi agar takeover stale otomatis tanpa timer di SW.
 */
export function sweepStaleLocks(registry: MutexRegistry, now: number): void {
  for (const name of Object.keys(registry)) {
    const entry = registry[name];
    if (entry && now - entry.lastBeat > LOCK_STALE_MS) {
      delete registry[name];
    }
  }
}

/**
 * Coba pegang `lockName`. granted bila bebas (atau basi — sudah di-sweep)
 * ATAU sudah dipegang holderId sendiri (re-entrant per tab).
 */
export function acquireLock(
  registry: MutexRegistry,
  req: Extract<MutexRequest, { type: 'ACQUIRE' }>
): MutexResponse {
  sweepStaleLocks(registry, req.now);
  const existing = registry[req.lockName];
  if (existing && existing.holderId !== req.holderId) {
    return { granted: false, holder: 'other' };
  }
  registry[req.lockName] = { holderId: req.holderId, lastBeat: req.now };
  return { granted: true, holder: 'you' };
}

/** Tandai pemegang masih hidup. Ditolak bila lock bukan milik holderId. */
export function heartbeatLock(
  registry: MutexRegistry,
  req: Extract<MutexRequest, { type: 'HEARTBEAT' }>
): MutexResponse {
  sweepStaleLocks(registry, req.now);
  const existing = registry[req.lockName];
  if (!existing) return { granted: false, holder: 'none' };
  if (existing.holderId !== req.holderId) return { granted: false, holder: 'other' };
  existing.lastBeat = req.now;
  return { granted: true, holder: 'you' };
}

/**
 * Lepas lock — HANYA bila dipanggil pemegang sah. Release dari pihak lain
 * diabaikan (mencegah tab lain melepas lock yang sedang kita pegang).
 */
export function releaseLock(
  registry: MutexRegistry,
  req: Extract<MutexRequest, { type: 'RELEASE' }>
): MutexResponse {
  sweepStaleLocks(registry, req.now);
  const existing = registry[req.lockName];
  if (!existing) return { granted: false, holder: 'none' };
  if (existing.holderId !== req.holderId) return { granted: false, holder: 'other' };
  delete registry[req.lockName];
  return { granted: true, holder: 'you' };
}

/** Dispatcher tunggal untuk handler message di sw.ts. */
export function handleMutexRequest(registry: MutexRegistry, req: MutexRequest): MutexResponse {
  switch (req.type) {
    case 'ACQUIRE':
      return acquireLock(registry, req);
    case 'HEARTBEAT':
      return heartbeatLock(registry, req);
    case 'RELEASE':
      return releaseLock(registry, req);
  }
}
