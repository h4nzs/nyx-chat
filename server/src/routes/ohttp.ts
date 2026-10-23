// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 3] Router OHTTP: `/config`, `/relay`, `/gateway`.
 *
 * Router hanya dipasang saat `OHTTP_ENABLED=1` (lihat `app.ts`), jadi deployment
 * biasa tidak mengiklankan jalur ini. Relay sengaja "bodoh": ia hanya meneruskan
 * byte ke gateway yang URL-nya berasal dari konfigurasi server, bukan dari klien
 * (tidak ada open proxy / SSRF). Tidak ada logging isi request di sini.
 */

import express, { type RequestHandler, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { encodeOhttpKeyConfigCollection } from '@nyx/shared';
import { OHTTP_OPS, incCounter } from '../utils/metrics.js';
import { signOhttpToken } from '../utils/ohttpToken.js';
import { newJti } from '../utils/jwt.js';
import { safeEqualStrings } from '../utils/validate.js';
import type { OhttpConfig } from '../ohttp/config.js';
import { createLoopbackDispatcher, handleOhttpGateway, type OhttpDispatcher } from '../ohttp/gateway.js';

const OHTTP_REQUEST_TYPE = 'message/ohttp-req';
const OHTTP_RESPONSE_TYPE = 'message/ohttp-res';

export interface OhttpRouterOptions {
  /** Dispatcher target; default loopback ke API sendiri. */
  dispatch?: OhttpDispatcher;
  /** Guard auth+CSRF untuk /relay saat token mode off. */
  relayGuards?: RequestHandler[];
}

export default function createOhttpRouter(config: OhttpConfig, options: OhttpRouterOptions = {}): Router {
  const router = express.Router();
  const port = process.env.PORT ?? '4000';
  const dispatch = options.dispatch ?? createLoopbackDispatcher(`http://127.0.0.1:${port}`);
  const tokenMode = config.tokenMode ?? 'on';
  const relayGuards = tokenMode === 'off' ? options.relayGuards ?? [] : [];
  if (tokenMode === 'off' && relayGuards.length === 0) {
    throw new Error('OHTTP: token mode off membutuhkan relayGuards (auth + CSRF)');
  }
  // Semua body OHTTP adalah biner opaque; jangan pernah di-parse JSON.
  const rawBody = express.raw({ type: () => true, limit: '128kb' });
  // Relay/gateway tidak punya sesi, jadi limiter ini satu-satunya penahan
  // penyalahgunaan. Angka konservatif: klien hanya memakai OHTTP untuk
  // endpoint yang di-allowlist (pencarian/prekey), bukan untuk semua trafik.
  const ohttpLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/config', (_req, res) => {
    res.type('application/ohttp-keys');
    // Seluruh slot rotasi dipublikasikan: klien lama tetap memakai pin key id-nya,
    // klien baru memilih key id tertinggi.
    res.send(Buffer.from(encodeOhttpKeyConfigCollection(config.publicConfigs)));
    incCounter(OHTTP_OPS, { route: 'config', result: 'ok' });
  });

  router.post('/relay', ohttpLimiter, ...relayGuards, rawBody, async (req, res, next) => {
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        incCounter(OHTTP_OPS, { route: 'relay', result: 'invalid' });
        res.status(400).json({ error: 'OHTTP_REQUEST_BODY_REQUIRED' });
        return;
      }
      const upstreamHeaders: Record<string, string> = { 'content-type': OHTTP_REQUEST_TYPE };
      if (tokenMode === 'off') {
        if (!req.user || !config.internalToken) {
          res.status(401).json({ error: 'OHTTP_RELAY_AUTH_REQUIRED' });
          return;
        }
        upstreamHeaders.authorization = `Bearer ${signOhttpToken({
          userId: req.user.id,
          deviceId: req.deviceId,
          jti: newJti(),
        })}`;
        upstreamHeaders['x-nyx-ohttp-internal'] = config.internalToken;
      }
      const upstream = await fetch(config.relayTarget, {
        method: 'POST',
        headers: upstreamHeaders,
        body: new Uint8Array(body).buffer,
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      incCounter(OHTTP_OPS, { route: 'relay', result: upstream.ok ? 'ok' : 'upstream' });
      res.status(upstream.status).type(OHTTP_RESPONSE_TYPE).send(bytes);
    } catch (error) {
      incCounter(OHTTP_OPS, { route: 'relay', result: 'invalid' });
      next(error);
    }
  });

  router.post('/gateway', ohttpLimiter, rawBody, async (req, res, next) => {
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'OHTTP_REQUEST_BODY_REQUIRED' });
        return;
      }
      let injectedAuthorization: string | undefined;
      if (tokenMode === 'off') {
        const internal = req.get('x-nyx-ohttp-internal');
        if (!config.internalToken || !internal || !safeEqualStrings(internal, config.internalToken)) {
          incCounter(OHTTP_OPS, { route: 'gateway', result: 'forbidden' });
          res.status(403).json({ error: 'OHTTP_GATEWAY_FORBIDDEN' });
          return;
        }
        const authorization = req.get('authorization');
        if (!authorization?.startsWith('Bearer ')) {
          incCounter(OHTTP_OPS, { route: 'gateway', result: 'forbidden' });
          res.status(403).json({ error: 'OHTTP_GATEWAY_FORBIDDEN' });
          return;
        }
        injectedAuthorization = authorization;
      }
      const encapsulated = await handleOhttpGateway(
        config,
        new Uint8Array(body),
        dispatch,
        config.allowlist,
        { injectedAuthorization },
      );
      incCounter(OHTTP_OPS, { route: 'gateway', result: 'ok' });
      res.type(OHTTP_RESPONSE_TYPE).send(Buffer.from(encapsulated));
    } catch (error) {
      // Dekripsi gagal = request tidak bisa dipercaya; jangan bocorkan detail.
      if (error instanceof Error && error.name === 'OhttpError') {
        // Key id tak dikenal (klien memakai kunci yang sudah dipensiunkan) sangat
        // berbeda dari amplop rusak — bedakan hasilnya supaya rotasi terlihat.
        const unknownKey = error.message.includes('key id');
        incCounter(OHTTP_OPS, { route: 'gateway', result: unknownKey ? 'unknown_key' : 'invalid' });
        res.status(400).json({ error: 'OHTTP_INVALID_REQUEST' });
        return;
      }
      incCounter(OHTTP_OPS, { route: 'gateway', result: 'invalid' });
      next(error);
    }
  });

  return router;
}
