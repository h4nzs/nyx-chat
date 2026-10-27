// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R2 2026-10-15] Pemasangan gerbang versi klien (`utils/clientVersion.ts`) ke
 * Express.
 *
 * Dipasang untuk seluruh `/api`, kecuali jalur yang **harus** tetap bisa dipanggil
 * klien apa pun supaya operator tidak buta:
 *   - `/api/health` — probe liveness (klien lama tidak relevan);
 *   - `/api/metrics`/`/metrics` berada di luar `/api`, jadi tidak tersentuh;
 *   - `/api/admin/cleanup` TIDAK dikecualikan khusus, tapi ia dilindungi kunci
 *     dan dipanggil alat ops (curl), yang tidak mengirim header versi → lolos
 *     lewat jalur `no-header` **selama mode ketat mati**. Bila
 *     `CLIENT_VERSION_REQUIRE_MUTATIONS=1`, alat ops itu ikut ditolak (POST
 *     tanpa header) — setel `x-nyx-client-version` di perintahnya atau jalankan
 *     pemeliharaan sebelum menyalakan mode tersebut (§10.14).
 *
 * Status **426 Upgrade Required** (bukan 403): artinya persis "klienmu terlalu
 * tua", bisa dibedakan operator dari penolakan izin, dan ditolak SEBELUM body
 * permintaan disentuh. Yang ditolak dicatat di
 * `nyx_client_version_rejected_total{result}` supaya lonjakan klien lama
 * terlihat di dashboard, bukan hanya di konsol pengguna.
 *
 * [D1 2026-10-27] Bila operator menyalakan `CLIENT_VERSION_REQUIRE_MUTATIONS=1`,
 * **mutasi** tanpa header versi ditolak di sini dengan kode
 * `CLIENT_VERSION_REQUIRED` (masih 426 + alasan `strict-no-header` di metrik).
 * Baca tetap lolos: klien lama harus bisa memuat data dan melihat pesan
 * "perbarui aplikasi" saat mencoba menulis, bukan kehilangan akses baca sama
 * sekali. Default (tanpa env itu) tidak berubah: tanpa header = lolos.
 */

import type { NextFunction, Request, Response } from 'express';
import { CLIENT_VERSION_REJECTED, incCounter } from '../utils/metrics.js';
import {
  clientVersionRejectionMessage,
  evaluateClientVersion,
  type ClientVersionPolicy,
} from '../utils/clientVersion.js';

/** Nama header versi klien (dikirim `web/src/lib/api.ts`). */
export const CLIENT_VERSION_HEADER = 'x-nyx-client-version';

/** Jalur yang tidak pernah digerbang (liveness/probe). */
const ALWAYS_ALLOWED = new Set(['/health', '/health/live', '/health/ready']);

/**
 * @param policyFromEnv dibaca **per permintaan** (bukan saat modul dimuat)
 *   supaya operator bisa mengubah `MIN_CLIENT_VERSION` lewat restart PM2 tanpa
 *   menyentuh kode, dan supaya uji bisa menyetel env-nya sendiri.
 */
export function clientVersionGate(policyFromEnv: () => ClientVersionPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // `req.path` relatif terhadap mount point (`/api`), jadi `app.use('/api', …)`
    // memberi `/health`, bukan `/api/health`.
    if (ALWAYS_ALLOWED.has(req.path)) {
      next();
      return;
    }

    const decision = evaluateClientVersion(
      req.headers[CLIENT_VERSION_HEADER],
      policyFromEnv(),
      req.method
    );
    if (decision.ok) {
      next();
      return;
    }

    incCounter(CLIENT_VERSION_REJECTED, { result: decision.reason });
    console.warn(
      `[ClientVersion] ditolak (${decision.reason}): klien ${decision.clientVersion ?? 'tidak diketahui'} < minimum ${decision.minimumVersion ?? '?'} (${req.method} ${req.originalUrl})`
    );
    res.status(426).json({
      // Kode berbeda supaya operator bisa membedakan "versi terbaca tapi tua"
      // dari "versi tidak dinyatakan pada request yang mengubah state" tanpa
      // harus membaca log.
      error: decision.reason === 'strict-no-header' ? 'CLIENT_VERSION_REQUIRED' : 'CLIENT_TOO_OLD',
      message: clientVersionRejectionMessage(decision),
      clientVersion: decision.clientVersion,
      minimumVersion: decision.minimumVersion,
    });
  };
}
