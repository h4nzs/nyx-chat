// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [MODAL-PRELOAD] Util untuk preload chunk modal global saat idle.
 *
 * Latar: modal global dirender on-demand (lazy). Jika chunk baru diunduh SAAT
 * modal pertama kali dibuka, Suspense boundary menampilkan fallback — dan bila
 * fallback itu full-screen (atau `null` untuk overlay yang belum siap), UI
 * terlihat blink/hilang sesaat. Dengan preload saat idle, chunk sudah ada di
 * cache browser jauh sebelum user menyentuh modal apa pun → Suspense tidak pernah
 * suspend di jalur normal.
 *
 * Strategi: `requestIdleCallback` (fallback `setTimeout`) dengan timeout 3s,
 * lalu preload berurutan satu per satu agar tidak berebut bandwidth dengan
 * chunk halaman yang mungkin juga sedang dimuat. Aman dipanggil kapan pun;
 * di `beforeunload`/destructured env, fetch gagal secara silent (catch kosong).
 */

export type LazyLoader = () => Promise<unknown>;

const preloadQueue: LazyLoader[] = [];
let scheduled = false;

const runPreload = async () => {
  for (const load of preloadQueue) {
    try {
      await load();
    } catch {
      // Preload gagal (offline, deploy baru) — tidak fatal; chunk akan
      // dimuat on-demand seperti biasa saat modal dibuka.
    }
  }
  preloadQueue.length = 0;
};

const scheduleIdle = (cb: () => void) => {
  const ric = (globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(cb, { timeout: 3000 });
  } else {
    setTimeout(cb, 1200);
  }
};

/**
 * Jadwalkan preload satu atau lebih lazy-loader saat browser idle.
 * Dipanggil sekali dari App setelah bootstrap; pemanggilan lagi adalah no-op
 * untuk item yang sudah masuk antrean.
 */
export const preloadOnIdle = (loaders: LazyLoader[]) => {
  preloadQueue.push(...loaders);
  if (scheduled) return;
  scheduled = true;
  scheduleIdle(() => {
    void runPreload();
  });
};
