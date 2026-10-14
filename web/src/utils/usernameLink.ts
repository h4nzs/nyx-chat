// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.13 WS-I] Username links `/u/<hashId>`.
 *
 * Link berbagi profil lama (`/connect?u=&i=&p=`) memuat userId + profil
 * terenkripsi di query string. Link pendek ini hanya membawa **hashId** —
 * nilai yang sudah dikirim klien ke `/api/users/search` untuk pencocokan persis
 * (tanpa enumerasi, rate-limit + exact match). Validasi di sini memakai aturan
 * yang sama dengan server (`users.ts` `isExactHash`): 43 char base64url
 * (Argon2id klien) atau 64 hex (blind index ter-pepper).
 */

/** Panjang hashId Argon2id-base64url dari klien. */
export const USERNAME_HASH_BASE64URL_LENGTH = 43;

/** Panjang blind index ter-pepper (hex). */
export const USERNAME_HASH_HEX_LENGTH = 64;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const HEX_RE = /^[a-f0-9]{64}$/;

/**
 * true bila nilai berbentuk hashId yang sah. Dipakai di klien agar format salah
 * tidak pernah dikirim ke server (hemat request + tidak menambah sampah rate-limit).
 */
export function isValidUsernameHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === USERNAME_HASH_BASE64URL_LENGTH && BASE64URL_RE.test(value)) return true;
  if (value.length === USERNAME_HASH_HEX_LENGTH && HEX_RE.test(value)) return true;
  return false;
}

/** Ambil hashId dari segmen URL `/u/:hashId`; `null` bila tidak sah. */
export function parseUsernameHashSegment(raw: string | undefined | null): string | null {
  return isValidUsernameHash(raw) ? raw : null;
}

/**
 * Bangun link pendek absolut. Melempar bila hashId tidak sah — mencegah link
 * rusak ikut tersebar.
 */
export function buildUsernameLink(origin: string, hashId: string): string {
  if (!isValidUsernameHash(hashId)) throw new Error('Hash ID tidak sah');
  const base = origin.replace(/\/+$/, '');
  return `${base}/u/${encodeURIComponent(hashId)}`;
}
