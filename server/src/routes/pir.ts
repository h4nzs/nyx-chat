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
import { parsePirManifest } from '@nyx/shared';
import { requireAuth } from '../middleware/auth.js';
import { pirQueryLimiter } from '../middleware/rateLimiter.js';
import { findPirServer, type PirConfig, type PirServer } from '../pir/config.js';
import { verifyPirManifest } from '../pir/manifest.js';

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

function parseShard(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
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
    const shard = parseShard(req.query.shard);
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
        res.status(502).json({ error: PIR_MANIFEST_INVALID });
        return;
      }
      if (
        manifest.shard !== shard ||
        !verifyPirManifest(manifest, signature, publicKey)
      ) {
        console.warn(`[PIR] manifest server ${server.id} shard ${shard} tidak valid`);
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
    const server = resolve(String(req.params.server ?? ''));
    if (!server) {
      res.status(404).json({ error: 'PIR_SERVER_UNKNOWN' });
      return;
    }
    const shard = parseShard(req.query.shard);
    if (shard === null) {
      res.status(400).json({ error: 'PIR_SHARD_INVALID' });
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
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
          res.status(400).json({ error: 'PIR_QUERY_INVALID' });
        } else if (upstream.status === 404) {
          res.status(404).json({ error: 'PIR_SHARD_UNKNOWN' });
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
        '[PIR] query gagal:',
        error instanceof Error ? error.message : error,
      );
      res.status(503).json({ error: PIR_UNAVAILABLE });
    }
  });

  return router;
}
