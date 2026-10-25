// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P7] Relay OHTTP sebagai **proses terpisah**.
 *
 * Kenapa dipisah: selama relay dan gateway berada di proses (dan log) yang sama,
 * "relay melihat IP, gateway melihat isi" hanya klaim arsitektur — satu proses
 * bisa mengorelasikan keduanya. Proses relay ini:
 *
 *   - hanya menerima `POST /relay` berisi amplop opaque,
 *   - meneruskan byte apa adanya ke gateway loopback (`OHTTP_GATEWAY_TARGET`),
 *   - **membuang seluruh header klien** (termasuk `authorization`, `cookie`,
 *     `x-forwarded-for`) — tidak ada identitas jaringan yang ikut ke gateway,
 *   - tidak punya DB, Redis, Prisma, atau log isi request.
 *
 * Batas jujur: kedua proses tetap di host yang sama, jadi operator host tetap
 * bisa mengorelasikan lewat jaringan/waktu. Yang dihilangkan adalah korelasi
 * *di dalam aplikasi* dan di log aplikasi. Untuk pemisahan jaringan sungguhan,
 * jalankan relay di host lain dan arahkan `OHTTP_GATEWAY_TARGET` lewat jalur
 * privat — itu keputusan operator, bukan sesuatu yang bisa diklaim kode ini.
 */

import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';

const OHTTP_REQUEST_TYPE = 'message/ohttp-req';
const OHTTP_RESPONSE_TYPE = 'message/ohttp-res';
const DEFAULT_MAX_BODY = '8mb';

export interface OhttpRelayOptions {
  /** URL gateway internal, WAJIB loopback (bukan input klien). */
  gatewayTarget: string;
  /**
   * Hostname tambahan yang dipercaya selain loopback (deployment Docker: nama
   * service `server`). Default kosong = hanya loopback. Daftar ini harus pendek
   * dan eksplisit; host di luar daftar tetap ditolak.
   */
  trustedGatewayHosts?: readonly string[];
  /** Batas body amplop (default 8 MB, sama dengan gateway). */
  maxBody?: string;
  /** Rate limit per IP relay (default 120/menit, sama dengan relay in-proses). */
  rateLimitPerMinute?: number;
  /** Timeout ke gateway (ms). Gateway yang menggantung = 504, bukan koneksi mati. */
  upstreamTimeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Tolak target non-loopback saat start. Relay tanpa batas ini adalah open proxy
 * (siapa pun bisa memakai `/relay` untuk menyuruh server memanggil URL apa pun),
 * dan kesalahan konfigurasi seperti itu harus terlihat saat boot, bukan saat
 * disalahgunakan.
 */
export function assertLoopbackGateway(
  gatewayTarget: string,
  trustedHosts: readonly string[] = []
): URL {
  let url: URL;
  try {
    url = new URL(gatewayTarget);
  } catch {
    throw new Error('OHTTP relay: OHTTP_GATEWAY_TARGET bukan URL yang valid');
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return url;

  const trusted = trustedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (trusted.includes(url.hostname.toLowerCase())) {
    // Docker/selfhost: `server` adalah nama service internal. Target tetap dari
    // konfigurasi, bukan input klien.
    console.warn(
      `[ohttp-relay] gateway non-loopback dipercaya: ${url.hostname} ` +
        '(dari OHTTP_GATEWAY_TRUSTED_HOSTS — pastikan ini jaringan internal, bukan host publik).'
    );
    return url;
  }

  throw new Error(
    `OHTTP relay: OHTTP_GATEWAY_TARGET harus loopback (didapat ${url.hostname}). ` +
      'Relay yang meneruskan ke host lain = open proxy; tambahkan host ke ' +
      'OHTTP_GATEWAY_TRUSTED_HOSTS hanya bila itu jaringan internal tepercaya.'
  );
}

export function createOhttpRelayApp(options: OhttpRelayOptions): Express {
  const gateway = assertLoopbackGateway(options.gatewayTarget, options.trustedGatewayHosts);
  const timeoutMs = options.upstreamTimeoutMs ?? 15_000;
  const app = express();
  // Body biner opaque: JANGAN di-parse JSON, dan jangan percaya content-type klien.
  const rawBody = express.raw({ type: () => true, limit: options.maxBody ?? DEFAULT_MAX_BODY });
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: options.rateLimitPerMinute ?? 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, upstream: `${gateway.hostname}:${gateway.port || '80'}${gateway.pathname}` });
  });

  app.post('/relay', limiter, rawBody, async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'OHTTP_REQUEST_BODY_REQUIRED' });
      return;
    }

    // Header dibangun eksplisit — bukan disalin. Header klien apa pun (cookie,
    // authorization, x-forwarded-for, user-agent) tidak pernah sampai ke gateway.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetch(options.gatewayTarget, {
        method: 'POST',
        headers: { 'content-type': OHTTP_REQUEST_TYPE },
        body: new Uint8Array(body).buffer,
        signal: controller.signal,
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status).type(OHTTP_RESPONSE_TYPE).send(bytes);
    } catch {
      // Jangan bocorkan detail upstream (bisa memuat host/port internal).
      if (!res.headersSent) res.status(502).json({ error: 'OHTTP_UPSTREAM_FAILED' });
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}
