// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P7] Entrypoint `nyx-ohttp-relay` — proses relay terpisah.
 *
 *   OHTTP_GATEWAY_TARGET=http://127.0.0.1:4000/api/ohttp/gateway \
 *   OHTTP_RELAY_PORT=4100 \
 *   pnpm --filter nyx-server run relay
 *
 * Default hanya mendengarkan loopback; port publik harus lewat nginx/cloudflared
 * (lihat `ops/nginx/nyx.conf`). Proses ini **tidak** butuh DATABASE_URL, Redis,
 * JWT_SECRET, atau key ring — kalau salah satunya dibutuhkan, berarti ada
 * tanggung jawab yang salah tempat.
 */

import { createServer } from 'node:http';
import { createOhttpRelayApp } from './relayApp.js';

const DEFAULT_PORT = 4100;
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function readPort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OHTTP relay: OHTTP_RELAY_PORT tidak valid (${raw})`);
  }
  return port;
}

function main(): void {
  const gatewayTarget = (process.env.OHTTP_GATEWAY_TARGET ?? '').trim();
  if (!gatewayTarget) {
    throw new Error(
      'OHTTP relay: OHTTP_GATEWAY_TARGET wajib diisi (mis. http://127.0.0.1:4000/api/ohttp/gateway)'
    );
  }
  // Token mode "off" berarti relay harus mencetak token auth/CSRF — itu butuh
  // sesi & DB, yang tidak dimiliki proses ini. Tolak saat boot, jangan diam-diam
  // meneruskan request tanpa identitas.
  if (process.env.OHTTP_TOKEN_MODE === 'off') {
    throw new Error(
      'OHTTP relay: OHTTP_TOKEN_MODE=off tidak didukung proses relay terpisah ' +
        '(relay tidak punya sesi/DB untuk mencetak token). Pakai mode "on".'
    );
  }

  const host = (process.env.OHTTP_RELAY_HOST ?? '127.0.0.1').trim();
  if (!LOOPBACK_BINDS.has(host)) {
    // Docker/selfhost: bind di jaringan container (`0.0.0.0`) adalah hal normal,
    // tetapi di host biasa itu berarti relay terbuka langsung ke internet tanpa
    // rate limit edge. Jadikan keputusan eksplisit, bukan default.
    if (process.env.OHTTP_RELAY_ALLOW_PUBLIC_BIND !== '1') {
      throw new Error(
        `OHTTP relay: OHTTP_RELAY_HOST=${host} bukan loopback. Buka lewat reverse proxy, ` +
          'atau set OHTTP_RELAY_ALLOW_PUBLIC_BIND=1 bila bind lebar memang disengaja (Docker).'
      );
    }
    console.warn(
      `[ohttp-relay] PERINGATAN: bind ke ${host} (bukan loopback). Pastikan firewall/network ` +
        'namespace yang membatasi, karena relay tidak punya autentikasi dan tidak mencatat IP.'
    );
  }
  const port = readPort(process.env.OHTTP_RELAY_PORT);

  const trustedGatewayHosts = (process.env.OHTTP_GATEWAY_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  const app = createOhttpRelayApp({
    gatewayTarget,
    trustedGatewayHosts,
    maxBody: process.env.OHTTP_RELAY_MAX_BODY,
    rateLimitPerMinute: process.env.OHTTP_RELAY_RATE_LIMIT
      ? Number(process.env.OHTTP_RELAY_RATE_LIMIT)
      : undefined,
  });

  const server = createServer(app);
  server.listen(port, host, () => {
    console.log(`[ohttp-relay] listening on http://${host}:${port} → ${gatewayTarget}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[ohttp-relay] ${signal} — menutup listener`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  console.error(`[ohttp-relay] gagal start: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  process.exitCode = 1;
}
