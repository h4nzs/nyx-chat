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
 *     lewat jalur `no-header`.
 *
 * Status **426 Upgrade Required** (bukan 403): artinya persis "klienmu terlalu
 * tua", bisa dibedakan operator dari penolakan izin, dan ditolak SEBELUM body
 * permintaan disentuh. Yang ditolak dicatat di
 * `nyx_client_version_rejected_total{result}` supaya lonjakan klien lama
 * terlihat di dashboard, bukan hanya di konsol pengguna.
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

    const decision = evaluateClientVersion(req.headers[CLIENT_VERSION_HEADER], policyFromEnv());
    if (decision.ok) {
      next();
      return;
    }

    incCounter(CLIENT_VERSION_REJECTED, { result: decision.reason });
    console.warn(
      `[ClientVersion] ditolak: klien ${decision.clientVersion ?? 'tidak diketahui'} < minimum ${decision.minimumVersion ?? '?'} (${req.method} ${req.originalUrl})`
    );
    res.status(426).json({
      error: 'CLIENT_TOO_OLD',
      message: clientVersionRejectionMessage(decision),
      clientVersion: decision.clientVersion,
      minimumVersion: decision.minimumVersion,
    });
  };
}
