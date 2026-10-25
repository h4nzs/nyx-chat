// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Satu allowlist origin untuk REST (`app.ts`) dan gateway
 * socket.io (`realtime/gateway.ts`).
 *
 * Dulu daftar ini ditulis dua kali, identik. Menambah satu origin di satu tempat
 * membuat transport lain tetap memblokir — gejalanya "koneksi mati / pesan
 * hilang" tanpa error yang jelas, dan komentar di `app.ts` mencatat kejadian
 * serupa dengan header `x-group-token`.
 */

/** Origin tetap yang selalu diterima (sama untuk dua transport). */
const BUILTIN_ORIGINS = [
  'https://nyx-app.my.id',
  'https://www.nyx-app.my.id',
  'https://api.nyx-app.my.id',
  'https://app.nyx-app.my.id',
  'https://rt.nyx-app.my.id',
  'https://storage.nyx-app.my.id',
];

/**
 * Varian HTTP/localhost — HANYA di luar production, supaya origin http tidak
 * pernah diterima di deployment yang sebenarnya.
 */
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://nyx-app.my.id',
  'http://www.nyx-app.my.id',
  'http://app.nyx-app.my.id',
  'http://api.nyx-app.my.id',
  'http://rt.nyx-app.my.id',
  'http://storage.nyx-app.my.id',
];

/** Escape karakter regex sebelum wildcard pada `CORS_ORIGIN` diubah jadi `.*`. */
export function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface OriginAllowlistOptions {
  /** `CORS_ORIGIN` (boleh string berkoma yang sudah di-split, atau string tunggal). */
  corsOrigin: string[] | string;
  isProd: boolean;
}

/**
 * Apakah origin ini boleh bicara dengan server?
 * `origin` kosong (request tanpa header `Origin`, mis. cron/server-to-server)
 * diterima: tidak ada browser yang perlu dilindungi di jalur itu.
 */
export function isAllowedOrigin (origin: string, opts: OriginAllowlistOptions): boolean {
  if (!origin) return true;

  const baseOrigins = Array.isArray(opts.corsOrigin) ? opts.corsOrigin : [opts.corsOrigin];
  const allowedOrigins = [
    ...baseOrigins,
    ...BUILTIN_ORIGINS,
    ...(opts.isProd ? [] : DEV_ORIGINS),
  ];

  return allowedOrigins.some((allowedOrigin) => {
    if (!allowedOrigin) return false;
    if (allowedOrigin.includes('*')) {
      const pattern = escapeRegExp(allowedOrigin).replace(/\\\*/g, '.*');
      return new RegExp('^' + pattern + '$').test(origin);
    }
    return allowedOrigin === origin;
  });
}
