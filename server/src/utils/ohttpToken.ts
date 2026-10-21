// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 3] Token carriage untuk OHTTP.
 *
 * Cookie sesi `HttpOnly` tidak bisa dibaca JS → tidak bisa masuk amplop OHTTP.
 * Solusinya token bearer berumur SANGAT pendek yang diletakkan DI DALAM amplop:
 *
 *  - `scope: 'ohttp'` + `aud: 'ohttp'`, TTL 120 detik (`OHTTP_TOKEN_TTL_SEC`);
 *  - hanya berlaku untuk target allowlist OHTTP dan hanya method GET — token
 *    yang bocor tidak bisa dipakai untuk mengirim pesan/mengubah apa pun;
 *  - punya `jti` sehingga bisa dicabut lewat blacklist Redis yang sudah ada
 *    (`revoked_jti:<jti>`) tanpa mekanisme baru;
 *  - tidak pernah ditulis ke storage klien (hanya di memori modul klien).
 *
 * Batas kejujuran: token ini menyembunyikan IP klien dari API, BUKAN
 * menyembunyikan bahwa ada satu akun yang sedang mencari. Yang dilindungi
 * adalah `requester IP → target` di log/edge, sesuai §35.7 Fase 3.
 */

import jwt from 'jsonwebtoken';
import { env } from '../config.js';
import { isOhttpTargetAllowed } from '@nyx/shared';

export const OHTTP_TOKEN_SCOPE = 'ohttp';
export const OHTTP_TOKEN_AUDIENCE = 'ohttp';
export const OHTTP_TOKEN_TTL_SEC = 120;

export interface OhttpTokenInput {
  userId: string;
  deviceId?: string;
  jti: string;
}

export function signOhttpToken(input: OhttpTokenInput): string {
  return jwt.sign(
    {
      id: input.userId,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      scope: OHTTP_TOKEN_SCOPE,
      aud: OHTTP_TOKEN_AUDIENCE,
      jti: input.jti,
    },
    env.jwtSecret,
    { expiresIn: OHTTP_TOKEN_TTL_SEC },
  );
}

/** Payload token ini token OHTTP bertingkat? */
export function isOhttpScopedPayload(payload: { scope?: unknown } | null | undefined): boolean {
  return payload?.scope === OHTTP_TOKEN_SCOPE;
}

/**
 * Token OHTTP hanya sah untuk endpoint yang sama dengan allowlist gateway.
 * Dipanggil `requireAuth`, jadi token yang dicoba di luar jalur itu ditolak
 * walaupun tanda tangannya valid.
 */
export function isOhttpScopeRequestAllowed(method: string, originalUrl: string): boolean {
  return method.toUpperCase() === 'GET' && isOhttpTargetAllowed(method, originalUrl);
}
