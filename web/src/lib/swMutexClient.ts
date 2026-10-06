// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

// Klien mutex lintas-tab via Service Worker (semantik registry: swMutexCore.ts).
// Jalur: tab → postMessage SW → registry SW (tunggal per-origin) → balasan
// via MessageChannel. Pemegang lock mengirim heartbeat berkala agar tidak
// di-sweep sebagai basi (LOCK_STALE_MS). Bila SW tidak mengendalikan halaman
// ini (jsdom, SW belum aktif, non-PWA), helper di sini no-op graceful →
// pemanggil (refreshLock) jatuh ke mutex localStorage.
//
// KOREKSIAN ANTI-CLOBBER: setiap request membawa `id` unik dan balasan SW
// men-echo id yang sama — beberapa request boleh in-flight sekaligus dalam
// satu tab (mis. heartbeat yang belum selesai saat release dikirim) tanpa
// saling menimpa resolver.

import { LOCK_STALE_MS } from './swMutexCore';

/** Heartbeat dikirim lebih cepat dari stale window (faktor aman 4×). */
const HEARTBEAT_INTERVAL_MS = LOCK_STALE_MS / 4;

/** Jeda antar percobaan acquire saat lock dipegang pihak lain. */
const ACQUIRE_POLL_MS = 30;

/** Batas total menunggu acquire — fallback localStorage selalu tersedia. */
const ACQUIRE_TIMEOUT_MS = 10_000;

/** Identifier uneg per-tab (randomUUID tersedia di semua target browser). */
const TAB_ID: string = crypto.randomUUID();

interface MutexResponse {
  granted: boolean;
  holder: 'you' | 'other' | 'none';
  /** Echo id request — untuk mencocokkan balasan dengan resolver-nya. */
  id: number;
}

type MutexRequestPayload = {
  type: 'ACQUIRE' | 'HEARTBEAT' | 'RELEASE';
  lockName: string;
  holderId: string;
};

/** SW mengendalikan halaman ini? Bila tidak, tier mutex SW dilewati. */
export function isSwMutexAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.serviceWorker?.controller
  );
}

/** Amplop pesan tab → SW. Field `__nyxMutex` membedakannya dari pesan push. */
interface MutexEnvelope {
  __nyxMutex: true;
  id: number;
  req: MutexRequestPayload;
}

let port: MessagePort | null = null;
let channel: MessageChannel | null = null;
let nextRequestId = 0;
const pending = new Map<number, (v: MutexResponse | null) => void>();

function ensurePort(): MessagePort | null {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) {
    return null;
  }
  if (port) return port;
  channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent) => {
    const data = event.data as MutexResponse | undefined;
    if (data && typeof data.id === 'number') {
      const resolve = pending.get(data.id);
      pending.delete(data.id);
      resolve?.(data);
    }
  };
  port = channel.port2;
  return port;
}

/** Kirim satu request ke SW. Resolve null bila SW tidak tersedia/gagal. */
function requestMutex(req: MutexRequestPayload): Promise<MutexResponse | null> {
  const p = ensurePort();
  if (!p) return Promise.resolve(null);
  const id = ++nextRequestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    try {
      const envelope: MutexEnvelope = { __nyxMutex: true, id, req };
      p.postMessage(envelope);
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

/** Coba pegang lock SEKALI. false bila SW tak tersedia / lock dipegang orang lain. */
export async function tryAcquireSwMutex(lockName: string): Promise<boolean> {
  const res = await requestMutex({ type: 'ACQUIRE', lockName, holderId: TAB_ID });
  return res?.granted === true;
}

/** Loop acquire: poll tiap 30ms hingga granted / timeout / abort. */
export async function acquireSwMutexWithRetry(
  lockName: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<boolean> {
  // Tanpa SW controller → jangan buang waktu polling 10s; fallback pemanggil
  // (localStorage) harus segera mengambil alih.
  if (!isSwMutexAvailable()) return false;
  const deadline = Date.now() + (opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS);
  while (true) {
    if (await tryAcquireSwMutex(lockName)) return true;
    if (Date.now() > deadline) return false;
    if (opts.signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, ACQUIRE_POLL_MS));
    if (opts.signal?.aborted) return false;
  }
}

/** Heartbeat: tandai pemegang masih hidup (dipanggil interval saat memegang). */
function sendHeartbeat(lockName: string): Promise<boolean> {
  return requestMutex({ type: 'HEARTBEAT', lockName, holderId: TAB_ID }).then(
    (res) => res?.granted === true
  );
}

/** Lepas lock (fire-and-forget) + hentikan heartbeat. */
export function releaseSwMutex(lockName: string): void {
  stopHeartbeat();
  void requestMutex({ type: 'RELEASE', lockName, holderId: TAB_ID });
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(lockName: string): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat(lockName).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Hasil withSwMutex DIBUNGKUS: `false` polos ambigu karena fn (silentRefresh)
 * sendiri bisa bernilai false secara sah.
 */
export type SwMutexResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Jalankan fn di bawah mutex SW: acquire ber-retry → heartbeat berkala →
 * release di finally. `{ ok: false }` artinya SW tak tersedia atau gagal
 * acquire dalam batas waktu (pemanggil memutuskan fallback); fn HANYA
 * dijalankan saat lock didapat.
 */
export async function withSwMutex<T>(
  lockName: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {}
): Promise<SwMutexResult<T>> {
  const ok = await acquireSwMutexWithRetry(lockName, { timeoutMs: opts.timeoutMs });
  if (!ok) return { ok: false };
  startHeartbeat(lockName);
  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseSwMutex(lockName);
  }
}

// Tab yang ditutup tanpa release tetap aman: heartbeat berhenti → registry SW
// menyapu lock sebagai basi dalam LOCK_STALE_MS. pagehide mempercepatnya.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    // Tidak tahu lock mana yang dipegang di modul ini — cukup hentikan
    // heartbeat; sweep stale SW yang melepas lock.
    stopHeartbeat();
  });
}
