// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit N9-01] Identitas klien untuk trafik OHTTP **tanpa akun**.
 *
 * Gateway OHTTP memanggil API lewat loopback, jadi `req.ip` di API adalah
 * `127.0.0.1` untuk SEMUA pengguna OHTTP. Perbaikan N8-02 memakai subjek token
 * OHTTP, tetapi jalur bukti KT (`POST /api/keys/kt/search`) sengaja **tanpa
 * token dan tanpa cookie** (audit N7-01) — sehingga jalur yang paling sering
 * dipakai jatuh kembali ke satu tag bersama, dan dua klien wajar sudah cukup
 * menghabiskannya (relay 120/menit per klien vs bucket API 240/menit).
 *
 * Satu-satunya pihak yang masih melihat alamat klien adalah **relay**. Jadi
 * relay-lah yang menghitung tag: `HMAC(secret, alamat)` — alamatnya tidak pernah
 * keluar dari proses relay, dan tag itu tidak bisa dibalik menjadi IP.
 *
 * Kenapa tag harus ditandatangani: gateway bisa dijangkau langsung (tanpa relay).
 * Kalau API mempercayai header tag begitu saja, penyerang cukup mengarang tag
 * baru di setiap request untuk mendapat bucket tanpa batas. Karena itu tag hanya
 * dipercaya bila datang bersama token internal relay (`x-nyx-ohttp-internal`,
 * rahasia proses yang juga dipakai mode `OHTTP_TOKEN_MODE=off`). Yang tidak
 * membawa token tetap di-key per IP seperti sebelumnya — tidak ada jalur yang
 * menjadi lebih longgar.
 *
 * Modul ini sengaja **tanpa** impor `atRestSecrets`/config: relay proses
 * terpisah (`nyx-ohttp-relay`) memakainya dan tidak boleh ikut memuat kunci
 * at-rest, sodium, atau Prisma hanya untuk menghitung satu HMAC.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Header token internal relay → gateway → API. */
export const OHTTP_INTERNAL_HEADER = 'x-nyx-ohttp-internal';
/** Header tag klien hasil HMAC relay (bukan IP, bukan id akun). */
export const OHTTP_CLIENT_TAG_HEADER = 'x-nyx-ohttp-client-tag';

/** Bentuk tag yang diterima: base64url 16–128 karakter (HMAC-SHA256 = 43). */
const CLIENT_TAG_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Token internal proses ini. Disetel sekali saat router OHTTP dipasang
 * (`app.ts`), sehingga keyGenerator limiter tidak perlu mengimpor konfigurasi
 * (yang akan membuat siklus impor).
 */
let internalToken: string | undefined;

export function setOhttpInternalToken(token: string | undefined): void {
  internalToken = token && token.length > 0 ? token : undefined;
}

export function getOhttpInternalToken(): string | undefined {
  return internalToken;
}

function tokenMatches(presented: string): boolean {
  if (!internalToken) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(internalToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Alamat klien menurut relay. `CF-Connecting-IP` didahulukan karena edge
 * Cloudflare menimpanya; `X-Forwarded-For` tidak dipakai (entri depan bisa
 * dikendalikan klien). Nilai ini **tidak pernah dikirim** ke gateway/API.
 */
export function ohttpClientAddress(req: Pick<Request, 'headers' | 'ip'>): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim() !== '') return cfIp.trim();
  if (typeof req.ip === 'string' && req.ip !== '') return req.ip;
  return 'unknown';
}

/** Tag klien: HMAC satu arah dengan rahasia relay (bukan alamatnya). */
export function relayClientTag(secret: string, clientAddress: string): string {
  return createHmac('sha256', secret)
    .update(`nyx-ohttp-client-tag-v1:${clientAddress}`)
    .digest('base64url');
}

/**
 * Tag klien mentah, hanya bila request benar-benar datang dari relay tepercaya.
 * `undefined` = pakai identitas lain (token OHTTP/IP) seperti sebelumnya.
 */
export function trustedRelayClientTag(
  req: Pick<Request, 'headers'>
): string | undefined {
  const presented = req.headers[OHTTP_INTERNAL_HEADER];
  if (typeof presented !== 'string' || !tokenMatches(presented)) return undefined;
  const tag = req.headers[OHTTP_CLIENT_TAG_HEADER];
  if (typeof tag !== 'string' || !CLIENT_TAG_RE.test(tag)) return undefined;
  return tag;
}

/** Status tag untuk metrik (`nyx_ohttp_client_tag_total`). */
export type OhttpClientTagStatus = 'tagged' | 'untagged' | 'untrusted' | 'no-token';

/**
 * [audit N9-01] Klasifikasi tag klien per request gateway.
 *
 * Tanpa token internal di proses ini, tag tidak mungkin dipercaya — dilaporkan
 * `no-token` (bukan `untagged`) karena itu kondisi konfigurasi yang harus
 * terlihat di Prometheus, bukan sekadar request tanpa tag. `untrusted` berarti
 * header dikirim tetapi tidak lolos verifikasi (token beda antar proses, atau
 * dikarang lewat gateway langsung).
 *
 * Fungsi ini murni: hanya membaca header dan token proses yang sudah disetel.
 */
export function classifyOhttpClientTag(
  req: Pick<Request, 'headers'>
): OhttpClientTagStatus {
  if (!internalToken) return 'no-token';
  const tag = req.headers[OHTTP_CLIENT_TAG_HEADER];
  const internal = req.headers[OHTTP_INTERNAL_HEADER];
  const hasTag = typeof tag === 'string' && tag.length > 0;
  const hasInternal = typeof internal === 'string' && internal.length > 0;
  if (!hasTag && !hasInternal) return 'untagged';
  return trustedRelayClientTag(req) ? 'tagged' : 'untrusted';
}
