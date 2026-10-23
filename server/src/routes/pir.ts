// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4b] Proxy PIR: `/params` dan `/query`.
 *
 * Router hanya dipasang saat `PIR_ENABLED=1` (lihat `app.ts`). Query tetap
 * opaque: server tidak mem-parse dan tidak mencatat isinya. Semua kripto PIR
 * ada di sidecar `server/pir-sidecar`; jalur ini hanya meneruskan byte dan
 * menegakkan auth + rate limit yang sama dengan pencarian.
 */

import express, { type RequestHandler, type Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { searchIpLimiter, searchLimiter } from '../middleware/rateLimiter.js';
import type { PirConfig } from '../pir/config.js';

const PIR_UNAVAILABLE = 'PIR_UNAVAILABLE';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_QUERY_BYTES = '8mb';

export interface PirRouterOptions {
  /** Guard auth; default `requireAuth`. */
  auth?: RequestHandler;
  /** Limiter tambahan untuk query; default limiter pencarian. */
  limiters?: RequestHandler[];
  /** Fetch impl (DI untuk tes). */
  fetchImpl?: typeof fetch;
  /** Batas waktu request ke sidecar. */
  timeoutMs?: number;
}

export default function createPirRouter(
  config: PirConfig,
  options: PirRouterOptions = {},
): Router {
  const router = express.Router();
  const auth = options.auth ?? requireAuth;
  const limiters = options.limiters ?? [searchIpLimiter, searchLimiter];
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rawQuery = express.raw({ type: 'application/octet-stream', limit: MAX_QUERY_BYTES });

  router.use(auth);

  router.get('/params', async (req, res) => {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      const ifNoneMatch = req.get('if-none-match');
      if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
      const upstream = await fetchImpl(`${config.serviceUrl}/params`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (upstream.status === 304) {
        res.status(304).end();
        return;
      }
      if (!upstream.ok) {
        await upstream.arrayBuffer().catch(() => undefined);
        res.status(503).json({ error: PIR_UNAVAILABLE });
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.status(200);
      res.set('Content-Type', 'application/json');
      res.set('Cache-Control', 'private, max-age=60');
      const etag = upstream.headers.get('etag');
      if (etag) res.set('ETag', etag);
      res.send(bytes);
    } catch (error) {
      console.warn(
        '[PIR] sidecar params gagal:',
        error instanceof Error ? error.message : error,
      );
      res.status(503).json({ error: PIR_UNAVAILABLE });
    }
  });

  router.post('/query', ...limiters, rawQuery, async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'PIR_QUERY_REQUIRED' });
      return;
    }
    try {
      const upstream = await fetchImpl(`${config.serviceUrl}/query`, {
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
          res.status(400).json({ error: 'PIR_QUERY_INVALID' });
        } else {
          res.status(503).json({ error: PIR_UNAVAILABLE });
        }
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.status(200);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Cache-Control', 'no-store');
      res.send(bytes);
    } catch (error) {
      console.warn(
        '[PIR] sidecar query gagal:',
        error instanceof Error ? error.message : error,
      );
      res.status(503).json({ error: PIR_UNAVAILABLE });
    }
  });

  return router;
}
