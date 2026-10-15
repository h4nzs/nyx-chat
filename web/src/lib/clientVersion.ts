// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R2 2026-10-15] Satu sumber kebenaran untuk header versi klien.
 *
 * Kenapa modul terpisah, bukan konstanta di dalam `lib/api.ts`: ada beberapa
 * jalur REST yang **tidak** lewat `api()`/`apiUpload()` — alat WebMCP di
 * `main.tsx`, pembersihan sesi server di `nukeProtocol.ts`, dan proksi gambar di
 * `LinkPreviewCard.tsx`. Modul kecil tanpa dependensi membuat semuanya memakai
 * nilai yang sama tanpa risiko siklus impor (`nukeProtocol` ↔ `api` keduanya
 * memanggil `fetch` sendiri-sendiri saat wipe).
 *
 * Nilainya `__APP_VERSION__` (di-inject Vite dari `package.json`) — build
 * ber-`define` yang sama dengan yang ditampilkan di halaman Settings, jadi
 * angka yang dilihat pengguna dan angka yang diputuskan server tidak bisa
 * berbeda.
 */

/** Nama header yang dibaca `middleware/clientVersion.ts` di server. */
export const CLIENT_VERSION_HEADER = 'x-nyx-client-version';

/** Versi build klien. */
export const CLIENT_VERSION_VALUE = __APP_VERSION__;

/** Header siap-pakai untuk `fetch`/XHR di luar `lib/api.ts`. */
export function clientVersionHeaders(): Record<string, string> {
  return { [CLIENT_VERSION_HEADER]: CLIENT_VERSION_VALUE };
}
