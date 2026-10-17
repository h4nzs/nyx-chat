// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/10 §10.12 · docs/29 §5.6] Pengukuran latensi ingress jalur WSS.
 *
 * Modul ini ada supaya satu-satunya bagian yang tidak bisa diuji dari gateway —
 * pembacaan jam — terpisah dari soket. Gateway socket.io tidak dijalankan di
 * unit test (butuh server HTTP + klien sungguhan), sedangkan aturan alert
 * bertumpu pada angka yang dihasilkan di sini; jadi bagian yang bisa salah
 * (apakah satu pengerjaan menghasilkan tepat SATU observasi, dan apakah
 * penolakan/error tidak ikut terhitung) diuji langsung, bukan lewat soket.
 *
 * Yang diukur: dari event socket.io masuk ke handler sampai handler selesai —
 * termasuk `checkRateLimit` dan `isActiveDeviceAllowed` (keduanya jalan DI DALAM
 * handler) serta publish ke `nyx:downstream`. Jalur yang ditolak guard tetap
 * terhitung: ia memang selesai lebih cepat, dan justru itu bentuk trafik yang
 * harus terlihat di distribusi — mengecualikannya berarti p95 hanya
 * menggambarkan trafik yang diterima, definisi yang berbeda untuk satu angka.
 *
 * Yang TIDAK dihitung: pengerjaan yang melempar. Handler yang gagal direset
 * koneksinya oleh gateway (`socket.disconnect`), dan itu kegagalan, bukan
 * "ingress lambat" — memasukkan jalur error ke histogram akan menggeser p95
 * dengan durasi yang tidak mewakili pelayanan yang berhasil.
 *
 * Pembandingnya di jalur cepat: `nyx_transport_ingress_seconds` (sidecar Rust,
 * `server/transport-sidecar/src/metrics.rs`). Cakupan keduanya sengaja tidak
 * identik — lihat komentar `WSS_INGRESS_SECONDS` di `metrics.ts`.
 */

import { WSS_INGRESS_SECONDS, observeHistogram } from './metrics.js';

/** Waktu jam yang monotonik (tahan perubahan jam sistem selama pengukuran). */
function nowMilliseconds(): number {
  return performance.now();
}

/**
 * Jalankan `run` dan catat durasinya (detik) ke `nyx_wss_ingress_seconds`.
 *
 * Nilai balik dan error diteruskan apa adanya: pengukuran tidak boleh mengubah
 * perilaku jalur yang diukur (tanpa ini, satu bug di metrik bisa memutus
 * pengiriman pesan).
 */
export async function measureWssIngress<T>(run: () => Promise<T>): Promise<T> {
  const started = nowMilliseconds();
  const result = await run();
  observeHistogram(WSS_INGRESS_SECONDS, (nowMilliseconds() - started) / 1000);
  return result;
}
