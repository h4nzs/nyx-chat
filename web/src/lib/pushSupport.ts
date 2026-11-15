// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Jalur push hanya boleh disentuh di build produksi.
 *
 * [BUG 2026-11-12] `sw.js` hanya ada di build PWA; di build dev menyentuh
 * `navigator.serviceWorker` MEMBEKUKAN main thread WebKit (`SecurityError:
 * Script …/sw.js load failed`), dan blokirnya sinkron sehingga `setTimeout`
 * pemutus pun tidak berbunyi. Dua tempat yang terkena: `logout()` di
 * `@store/auth` dan `/settings` lewat `usePushNotifications` — keduanya
 * menggantung sampai tes mati (nightly `Smoke Firefox + WebKit` run
 * 43015446345; repro lokal Docker WebKit). Karena tanpanya tidak ada langganan
 * push yang bisa ada, di dev jalur ini dilewati sepenuhnya.
 */
export function isPushSupported(): boolean {
  return (
    import.meta.env.PROD &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}
