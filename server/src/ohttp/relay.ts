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
import { invalidTrustedProxyReason } from './clientTag.js';

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
  // [audit N11-04] Peringatan trust proxy hanya relevan bila ada hop jaringan
  // nyata. Profil selfhost (gateway 127.0.0.1) justru WAJIB mengosongkan
  // OHTTP_TRUSTED_PROXIES; mencetak "setel ke CIDR nginx" di sana menuntun
  // operator ke nilai yang ditolak `verify-boot.sh`.
  const gatewayHost = (() => {
    try {
      return new URL(gatewayTarget).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  })();
  const gatewayOnLoopback = LOOPBACK_BINDS.has(gatewayHost);
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

  // [audit N9-01] Tag klien per relay. Tanpa ini, semua pengguna OHTTP berbagi
  // satu bucket limiter di API (`127.0.0.1`) untuk jalur tanpa akun seperti
  // bukti KT. Nilainya HARUS sama dengan `OHTTP_INTERNAL_TOKEN` di proses API.
  const internalToken = (process.env.OHTTP_INTERNAL_TOKEN ?? '').trim();
  if (internalToken && internalToken.length < 32) {
    throw new Error('OHTTP relay: OHTTP_INTERNAL_TOKEN minimal 32 karakter');
  }
  if (!internalToken) {
    console.warn(
      '[ohttp-relay] OHTTP_INTERNAL_TOKEN kosong: tag klien tidak dikirim, sehingga ' +
        'rate limit API untuk trafik OHTTP tanpa akun (bukti KT) menjadi satu bucket bersama.'
    );
  }

  // [audit N10-03] Hanya hop di daftar ini yang boleh meneruskan
  // `CF-Connecting-IP`. Default loopback; nginx di jaringan container harus
  // dicantumkan, kalau tidak semua klien kembali berbagi tag alamat nginx.
  const trustedProxies = (process.env.OHTTP_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // [audit N11-05] Entri yang tidak bisa diparse dulu hilang tanpa gejala →
  // hop nginx tidak dipercaya dan semua klien berbagi satu bucket. Sekarang
  // alasan per entri terlihat di log start.
  for (const entry of trustedProxies) {
    const reason = invalidTrustedProxyReason(entry);
    if (reason) {
      console.warn(
        `[ohttp-relay] OHTTP_TRUSTED_PROXIES: entri "${entry}" diabaikan (${reason}) — ` +
          'hop itu TIDAK dipercaya, jadi header klien dari sana diabaikan.'
      );
    }
  }
  if (trustedProxies.length === 0) {
    if (gatewayOnLoopback) {
      console.log(
        '[ohttp-relay] OHTTP_TRUSTED_PROXIES kosong: benar untuk selfhost (nginx → relay lewat loopback). ' +
          'Isi hanya bila nginx berada di jaringan container.'
      );
    } else {
      console.warn(
        '[ohttp-relay] OHTTP_TRUSTED_PROXIES kosong padahal target gateway bukan loopback: ' +
          'setel alamat/CIDR nginx (IPv4 atau IPv6), kalau tidak semua klien berbagi tag alamat nginx.'
      );
    }
  }

  const app = createOhttpRelayApp({
    gatewayTarget,
    trustedGatewayHosts,
    trustedProxies: trustedProxies.length > 0 ? trustedProxies : undefined,
    internalToken: internalToken || undefined,
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
