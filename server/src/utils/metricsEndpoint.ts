// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/27 §27.7 + docs/30 WS-G] Exporter `/metrics` — **loopback only**.
 *
 * Sengaja BUKAN route Express: nginx mem-proxy semua path ke `nyx-api`, jadi
 * endpoint di app publik akan ikut terekspos ke internet (metrik internal =
 * peta infrastruktur + volume trafik). Listener terpisah di 127.0.0.1 membuat
 * hanya Prometheus di host yang sama (atau tunnel) yang bisa membaca.
 *
 * Env:
 *   METRICS_HOST (default 127.0.0.1) — JANGAN diubah tanpa alasan sadar.
 *   METRICS_PORT (default 9464)      — 0 = matikan exporter.
 */
import { createServer, type Server } from 'node:http';
import { renderMetricsText } from './metrics.js';

let metricsServer: Server | null = null;

export function metricsHost(): string {
  return process.env.METRICS_HOST || '127.0.0.1';
}

export function metricsPort(): number {
  const raw = process.env.METRICS_PORT;
  if (raw === undefined) return 9464;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 9464;
}

/** Mulai exporter. Return `null` bila dimatikan (METRICS_PORT=0). */
export function startMetricsServer(): Server | null {
  const port = metricsPort();
  if (port === 0) {
    console.log('[Metrics] Exporter dimatikan (METRICS_PORT=0).');
    return null;
  }

  const host = metricsHost();
  metricsServer = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url || '').split('?')[0] !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    const body = renderMetricsText();
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });

  metricsServer.on('error', (err) => {
    console.error('[Metrics] Exporter gagal jalan:', err);
  });

  metricsServer.listen(port, host, () => {
    console.log(`📊 Metrics exporter (loopback) at http://${host}:${port}/metrics`);
  });

  // Jangan menahan proses saat shutdown.
  metricsServer.unref();

  return metricsServer;
}

export function stopMetricsServer(): void {
  metricsServer?.close();
  metricsServer = null;
}
