// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP5] Proxy PIR dua server: `/api/pir/:server/manifest` dan
 * `/api/pir/:server/query`.
 *
 * Satu request hanya menyentuh **satu** server. Klien wajib memakai dua relay
 * OHTTP berbeda; menggabungkan kedua share dalam satu request akan membuat
 * relay melihat `q1 ⊕ q2 = e_i` dan indeks yang dicari langsung terbuka.
 *
 * Manifest diverifikasi tanda tangannya di sini sebelum diteruskan (pertahanan
 * berlapis). Klien tetap memverifikasi sendiri dengan kunci yang di-pin, karena
 * proxy ini juga bagian dari server yang tidak dipercaya.
 */

import express, { type RequestHandler, type Router } from 'express';
import { PIR_SUITE, parsePirManifest } from '@nyx/shared';
import { requireAuth } from '../middleware/auth.js';
import { pirQueryLimiter } from '../middleware/rateLimiter.js';
import { findPirServer, type PirConfig, type PirServer } from '../pir/config.js';
import { verifyPirManifest } from '../pir/manifest.js';
import {
  incCounter,
  observeHistogram,
  PIR_MANIFEST_MISMATCH,
  PIR_QUERY,
  PIR_QUERY_SECONDS,
} from '../utils/metrics.js';

const PIR_UNAVAILABLE = 'PIR_UNAVAILABLE';
const PIR_MANIFEST_INVALID = 'PIR_MANIFEST_INVALID';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_QUERY_BYTES = '64kb';

export interface PirRouterOptions {
  /** Guard auth; default `requireAuth`. */
  auth?: RequestHandler;
  /** Limiter query; default `pirQueryLimiter`. */
  limiters?: RequestHandler[];
  /** Fetch impl (DI untuk tes). */
  fetchImpl?: typeof fetch;
  /** Batas waktu request ke sidecar. */
  timeoutMs?: number;
}

type PirQueryResult = 'ok' | 'invalid' | 'shard_unknown' | 'unavailable';

function recordQueryResult(result: PirQueryResult, startedAt: number): void {
  incCounter(PIR_QUERY, { result });
  observeHistogram(PIR_QUERY_SECONDS, (Date.now() - startedAt) / 1000);
}

function parseShard(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

async function forwardSummary(
  config: PirConfig,
  server: PirServer,
  res: express.Response,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  try {
    const upstream = await fetchImpl(`${server.url}/manifest`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) {
      await upstream.arrayBuffer().catch(() => undefined);
      res.status(upstream.status === 404 ? 404 : 503).json({
        error: upstream.status === 404 ? 'PIR_SHARD_UNKNOWN' : PIR_UNAVAILABLE,
      });
      return;
    }
    const payload = (await upstream.json().catch(() => null)) as {
      shardCount?: unknown;
      epoch?: unknown;
      suite?: unknown;
    } | null;
    if (
      payload?.suite !== PIR_SUITE ||
      !Number.isSafeInteger(payload.shardCount) ||
      (payload.shardCount as number) < 1 ||
      !Number.isSafeInteger(payload.epoch)
    ) {
      console.warn(`[PIR] ringkasan manifest server ${server.id} tidak valid`);
      incCounter(PIR_MANIFEST_MISMATCH);
      res.status(502).json({ error: PIR_MANIFEST_INVALID });
      return;
    }
    res.status(200);
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'no-store');
    res.json({ shardCount: payload.shardCount, epoch: payload.epoch, suite: payload.suite });
  } catch (error) {
    console.warn(
      '[PIR] ringkasan manifest gagal:',
      error instanceof Error ? error.message : error,
    );
    res.status(503).json({ error: PIR_UNAVAILABLE });
  }
}

export default function createPirRouter(
  config: PirConfig,
  options: PirRouterOptions = {},
): Router {
  const router = express.Router();
  const auth = options.auth ?? requireAuth;
  const limiters = options.limiters ?? [pirQueryLimiter];
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rawQuery = express.raw({ type: 'application/octet-stream', limit: MAX_QUERY_BYTES });

  const resolve = (id: string | undefined): PirServer | null =>
    id ? findPirServer(config, id) : null;

  router.use(auth);

  router.get('/:server/manifest', async (req, res) => {
    const server = resolve(String(req.params.server ?? ''));
    if (!server) {
      res.status(404).json({ error: 'PIR_SERVER_UNKNOWN' });
      return;
    }
    // Tanpa `shard`: ringkasan (shardCount/epoch) supaya klien tahu berapa
    // shard sebelum meminta manifest bertanda tangan. Shard tidak diketahui
    // sebelum server memberi tahu — bukan parameter wajib di sini.
    const rawShard = req.query.shard;
    if (rawShard === undefined) {
      await forwardSummary(config, server, res, fetchImpl, timeoutMs);
      return;
    }
    const shard = parseShard(rawShard);
    if (shard === null) {
      res.status(400).json({ error: 'PIR_SHARD_INVALID' });
      return;
    }

    try {
      const upstream = await fetchImpl(`${server.url}/manifest?shard=${shard}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!upstream.ok) {
        await upstream.arrayBuffer().catch(() => undefined);
        res.status(upstream.status === 404 ? 404 : 503).json({
          error: upstream.status === 404 ? 'PIR_SHARD_UNKNOWN' : PIR_UNAVAILABLE,
        });
        return;
      }
      const payload = (await upstream.json().catch(() => null)) as
        | { manifest?: unknown; signature?: unknown }
        | null;
      const publicKey = config.manifestKeys.get(server.id)!;
      let manifest: ReturnType<typeof parsePirManifest>;
      let signature = '';
      try {
        manifest = parsePirManifest(payload?.manifest);
        signature = typeof payload?.signature === 'string' ? payload.signature : '';
      } catch {
        console.warn(`[PIR] manifest server ${server.id} bukan manifest v2`);
        incCounter(PIR_MANIFEST_MISMATCH);
        res.status(502).json({ error: PIR_MANIFEST_INVALID });
        return;
      }
      if (
        manifest.shard !== shard ||
        !verifyPirManifest(manifest, signature, publicKey)
      ) {
        console.warn(`[PIR] manifest server ${server.id} shard ${shard} tidak valid`);
        incCounter(PIR_MANIFEST_MISMATCH);
        res.status(502).json({ error: PIR_MANIFEST_INVALID });
        return;
      }
      res.status(200);
      res.set('Content-Type', 'application/json');
      res.set('Cache-Control', 'no-store');
      res.json({ manifest, signature });
    } catch (error) {
      console.warn(
        '[PIR] manifest gagal:',
        error instanceof Error ? error.message : error,
      );
      res.status(503).json({ error: PIR_UNAVAILABLE });
    }
  });

  router.post('/:server/query', ...limiters, rawQuery, async (req, res) => {
    const startedAt = Date.now();
    const server = resolve(String(req.params.server ?? ''));
    if (!server) {
      recordQueryResult('invalid', startedAt);
      res.status(404).json({ error: 'PIR_SERVER_UNKNOWN' });
      return;
    }
    // Query selalu butuh shard: share yang panjangnya salah ditolak sidecar,
    // dan menebak shard akan membocorkan/menghasilkan jawaban tak berarti.
    const shard = parseShard(req.query.shard);
    if (shard === null) {
      recordQueryResult('invalid', startedAt);
      res.status(400).json({ error: 'PIR_SHARD_INVALID' });
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      recordQueryResult('invalid', startedAt);
      res.status(400).json({ error: 'PIR_QUERY_REQUIRED' });
      return;
    }

    try {
      const upstream = await fetchImpl(`${server.url}/query?shard=${shard}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          accept: 'application/octet-stream',
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!upstream.ok) {
        await upstream.arrayBuffer().catch(() => undefined);
        if (upstream.status === 400) {
          recordQueryResult('invalid', startedAt);
          res.status(400).json({ error: 'PIR_QUERY_INVALID' });
        } else if (upstream.status === 404) {
          recordQueryResult('shard_unknown', startedAt);
          res.status(404).json({ error: 'PIR_SHARD_UNKNOWN' });
        } else {
          recordQueryResult('unavailable', startedAt);
          res.status(503).json({ error: PIR_UNAVAILABLE });
        }
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      recordQueryResult('ok', startedAt);
      res.status(200);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Cache-Control', 'no-store');
      res.send(bytes);
    } catch (error) {
      console.warn(
        '[PIR] query gagal:',
        error instanceof Error ? error.message : error,
      );
      recordQueryResult('unavailable', startedAt);
      res.status(503).json({ error: PIR_UNAVAILABLE });
    }
  });

  return router;
}
