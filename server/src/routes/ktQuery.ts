// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.5 WS-A / docs/32 §32.8 / docs/34] Proxy `/api/keys/kt/*`.
 *
 * Klien memakai endpoint ini untuk mengambil bukti KT; verifikasi kriptografinya
 * terjadi **di klien** (WASM `keytrans-v2`). Server NYX hanya meneruskan
 * byte dari `nyx-kt-query-v2` dan tidak pernah menyentuh kunci rahasia pengguna.
 *
 * Bentuk jawaban: base64url dari protobuf mentah — `fullTreeHead` +
 * `condensed` — karena parser protobuf ada di WASM, bukan di JS.
 *
 * Degradasi terlihat: kalau `KT_QUERY_URL` kosong → 503 `KT_QUERY_DISABLED`;
 * kalau search key tidak ada di log → 404 `KT_NOT_FOUND`; kalau layanan mati →
 * 502 `KT_UNAVAILABLE`. Klien yang memutuskan jatuh ke TOFU dan menampilkannya,
 * bukan gagal senyap.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { generalLimiter } from '../middleware/rateLimiter.js';
import {
  KtQueryError,
  fetchKtDistinguished,
  fetchKtHead,
  fetchKtMonitor,
  fetchKtProof,
  fetchKtPublicConfig,
  ktQueryConfigured,
} from '../utils/ktQuery.js';

const router: Router = Router();

/** Hash 32 byte sebagai base64url (tanpa padding), sama seperti klien mengirimnya. */
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/** Search key mentah base64url (mis. `distinguished` adalah 13 byte). */
const BASE64URL_ANY = /^[A-Za-z0-9_-]{1,128}$/;

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function parseTreeSize(value: unknown, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new KtQueryError('INVALID_ARGUMENT', `${field} harus angka`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new KtQueryError('INVALID_ARGUMENT', `${field} harus bilangan bulat > 0`);
  }
  return parsed;
}

function sendKtError(res: import('express').Response, error: unknown): void {
  if (error instanceof KtQueryError) {
    switch (error.code) {
      case 'DISABLED':
        res.status(503).json({ error: 'KT_QUERY_DISABLED', message: error.message });
        return;
      case 'INVALID_ARGUMENT':
        res.status(400).json({ error: 'KT_INVALID_ARGUMENT', message: error.message });
        return;
      case 'NOT_FOUND':
        res.status(404).json({ error: 'KT_NOT_FOUND', message: error.message });
        return;
      case 'MALFORMED_RESPONSE':
        // Bukti yang tidak bisa dibaca = kegagalan layanan, bukan "tidak ada".
        res.status(502).json({ error: 'KT_UNAVAILABLE', message: error.message });
        return;
      default:
        res.status(502).json({ error: 'KT_UNAVAILABLE', message: error.message });
        return;
    }
  }
  res.status(502).json({ error: 'KT_UNAVAILABLE', message: (error as Error).message });
}

function searchInputFromQuery(query: Record<string, unknown>): {
  hash?: string;
  key?: string;
  last?: number;
  distinguished?: number;
} {
  const hash = typeof query.hash === 'string' ? query.hash : undefined;
  const key = typeof query.key === 'string' ? query.key : undefined;

  if (hash === undefined && key === undefined) {
    throw new KtQueryError('INVALID_ARGUMENT', 'wajib salah satu: hash atau key');
  }
  if (hash !== undefined && key !== undefined) {
    throw new KtQueryError('INVALID_ARGUMENT', 'hash dan key tidak boleh bersamaan');
  }
  if (hash !== undefined && !BASE64URL_32.test(hash)) {
    throw new KtQueryError('INVALID_ARGUMENT', 'hash harus base64url dari 32 byte');
  }
  if (key !== undefined && !BASE64URL_ANY.test(key)) {
    throw new KtQueryError('INVALID_ARGUMENT', 'key harus base64url');
  }

  return {
    hash,
    key,
    last: parseTreeSize(query.last, 'last'),
    distinguished: parseTreeSize(query.distinguished, 'distinguished'),
  };
}

// === Bukti untuk satu usernameHash ===
router.get('/search', generalLimiter, requireAuth, async (req, res) => {
  try {
    const proof = await fetchKtProof(searchInputFromQuery(req.query as Record<string, unknown>));
    res.json({ fullTreeHead: encode(proof.fullTreeHead), condensed: encode(proof.condensed) });
  } catch (error) {
    sendKtError(res, error);
  }
});

// === Anchor `distinguished` (sebelum klien mengenal kontak mana pun) ===
router.get('/distinguished', generalLimiter, requireAuth, async (req, res) => {
  try {
    const proof = await fetchKtDistinguished({
      last: parseTreeSize(req.query.last, 'last'),
      distinguished: parseTreeSize(req.query.distinguished, 'distinguished'),
    });
    res.json({ fullTreeHead: encode(proof.fullTreeHead), condensed: encode(proof.condensed) });
  } catch (error) {
    sendKtError(res, error);
  }
});

// === Bukti monitor ===
// Body: `{ monitorRequest: <base64url protobuf transparency.MonitorRequest> }`.
// Klien membangun permintaan itu dari monitoring data tersimpan; jawabannya
// dipasangkan dengan permintaan yang sama saat `verify_monitor`.
router.post('/monitor', generalLimiter, requireAuth, async (req, res) => {
  try {
    const encoded = (req.body as { monitorRequest?: unknown } | undefined)?.monitorRequest;
    if (typeof encoded !== 'string' || !BASE64URL_ANY.test(encoded)) {
      throw new KtQueryError('INVALID_ARGUMENT', 'monitorRequest (base64url) wajib ada');
    }
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.byteLength === 0 || bytes.byteLength > 1 << 20) {
      throw new KtQueryError('INVALID_ARGUMENT', 'monitorRequest berukuran tidak wajar');
    }
    const response = await fetchKtMonitor(new Uint8Array(bytes));
    res.json({ monitorResponse: encode(response) });
  } catch (error) {
    sendKtError(res, error);
  }
});

// === Kunci publik log: klien membandingkan ini dengan yang diharapkan ===
router.get('/config', generalLimiter, requireAuth, async (_req, res) => {
  if (!ktQueryConfigured()) {
    res.status(503).json({
      error: 'KT_QUERY_DISABLED',
      message: 'KT_QUERY_URL tidak diatur — verifikasi kunci tidak tersedia',
    });
    return;
  }
  try {
    res.json(await fetchKtPublicConfig());
  } catch (error) {
    sendKtError(res, error);
  }
});

// === Tree head ringkas (`{treeSize, timestamp, root}`) untuk gossip antar-klien ===
// Bukan bukti: root di sini hanya untuk **membandingkan** head antar-klien
// (`docs/30` §30.5 tahap C — deteksi split-view). Verifikasi tetap dari bukti.
router.get('/head', generalLimiter, requireAuth, async (_req, res) => {
  try {
    res.json(await fetchKtHead());
  } catch (error) {
    sendKtError(res, error);
  }
});

export default router;
