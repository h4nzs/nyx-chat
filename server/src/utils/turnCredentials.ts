// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(1)] Kredensial TURN time-limited untuk coturn self-host.
 *
 * Sebelum ini `/api/keys/turn` hanya menerbitkan kredensial dari Cloudflare
 * (primer) + STUN operator. WS-E(1) memindahkan coturn menjadi **primer**:
 * coturn dijalankan dengan `use-auth-secret` + `static-auth-secret`, dan server
 * menandatangani kredensial jangka pendek supaya:
 *
 *   - tidak perlu menyimpan akun TURN per user (tanpa tabel baru),
 *   - kredensial kedaluwarsa cepat (default 600 s) sehingga bocor tidak awet,
 *   - **identitas di username memakai `identityTag`**, bukan userId — log coturn
 *     tidak memetakan sesi call ke akun (aturan `docs/28`).
 *
 * Konvensi coturn (dipakai apa adanya, bukan format buatan kita):
 *
 *   username   = "<unixExpiry>:<userid>"
 *   credential = base64( HMAC-SHA1( static-auth-secret, username ) )
 *
 * Modul ini murni (tanpa I/O) supaya bisa diuji perilakunya, bukan regex.
 */

import { createHmac } from 'node:crypto';

/** TTL default kredensial TURN (detik). */
export const DEFAULT_TURN_TTL_SECONDS = 600;

/** Batas bawah TTL — terlalu pendek membuat call putus di tengah. */
export const MIN_TURN_TTL_SECONDS = 60;

/** Batas atas TTL — dibatasi sehari seperti hotspot kredensial Cloudflare. */
export const MAX_TURN_TTL_SECONDS = 86_400;

export interface TurnCredential {
  username: string;
  credential: string;
  /** Unix seconds saat kredensial kedaluwarsa (sama dengan prefiks username). */
  expiresAt: number;
  ttlSeconds: number;
}

/** Jepit TTL ke rentang sah; nilai tak sah → default. */
export function clampTurnTtl(ttlSeconds: number | undefined | null): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) return DEFAULT_TURN_TTL_SECONDS;
  const rounded = Math.floor(ttlSeconds);
  if (rounded < MIN_TURN_TTL_SECONDS) return MIN_TURN_TTL_SECONDS;
  if (rounded > MAX_TURN_TTL_SECONDS) return MAX_TURN_TTL_SECONDS;
  return rounded;
}

/**
 * Parsing `TURN_URLS` (dipisah koma, boleh ada spasi/baris baru). Hanya skema
 * `turn:`/`turns:` yang diterima — nilai lain (mis. URL HTTP yang salah tempel)
 * dibuang, bukan diteruskan ke klien sebagai ICE server yang tak berguna.
 */
export function parseTurnUrls(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const url = part.trim();
    if (!/^turns?:/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Terbitkan kredensial coturn. `nowSeconds` dapat disuntik agar test
 * deterministik (produksi memakai waktu sistem).
 */
export function mintTurnCredential(opts: {
  secret: string;
  /** Nilai `identityTag(userId)` — BUKAN userId mentah. */
  identityTag: string;
  ttlSeconds?: number;
  nowSeconds?: number;
}): TurnCredential {
  if (!opts.secret) throw new Error('TURN static auth secret kosong');
  if (!opts.identityTag) throw new Error('TURN identity tag kosong');

  const ttlSeconds = clampTurnTtl(opts.ttlSeconds);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const username = `${expiresAt}:${opts.identityTag}`;
  const credential = createHmac('sha1', opts.secret).update(username).digest('base64');
  return { username, credential, expiresAt, ttlSeconds };
}

/** Bentuk ICE server untuk TURN yang membawa username/credential. */
export interface TurnIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Bungkus kredensial menjadi satu entri ICE server (beberapa URL sekaligus). */
export function buildTurnIceServers(urls: string[], credential: TurnCredential): TurnIceServer[] {
  if (urls.length === 0) return [];
  return [{ urls, username: credential.username, credential: credential.credential }];
}

/** true bila coturn dikonfigurasi lengkap (secret + minimal satu URL turn/turns). */
export function isCoturnConfigured(secret: string | undefined | null, urls: string[]): boolean {
  return typeof secret === 'string' && secret.length > 0 && urls.length > 0;
}
