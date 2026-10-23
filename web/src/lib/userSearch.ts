// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Satu pintu pencarian user (blind index).
 *
 * Pemanggil lama memakai `api()` langsung di tiga tempat (hook pencarian, daftar
 * chat, store percakapan). Semuanya sekarang lewat sini supaya jalur OHTTP
 * berlaku seragam — kalau hanya satu tempat yang diubah, IP klien tetap bocor
 * dari tempat lain dan perlindungannya jadi ilusi.
 *
 * Saat `VITE_OHTTP_ENABLED=1`, request dikirim lewat relay → gateway sehingga
 * API/edge tidak melihat IP pemanggil. **Tidak ada fallback diam-diam** ke HTTP
 * biasa: gagal OHTTP = gagal pencarian. Fallback otomatis akan mengembalikan
 * kebocoran yang justru ingin dicegah, tanpa terlihat oleh user.
 */

import type { MinimalProfile } from '@nyx/shared';
import { api } from './api';
import { isRawIdentifierHash, oprfSearchEnabled, oprfSearchIndex } from './searchOprfClient';

export interface UserSearchHit {
  id: string;
  encryptedProfile?: string | null;
  isVerified?: boolean;
  publicKey?: string;
}

/**
 * [docs/35 Fase 4] Padding query pencarian.
 *
 * `q` bisa 43 karakter (hash klien) atau 64 hex (hash-ID lama), sehingga
 * panjang URL membocorkan bentuk identifier yang dicari ke relay/log edge
 * walaupun isinya sudah hash. Parameter `pad` acak **mengisi sisa slot q sampai
 * 64 karakter**, jadi panjang path total SERAGAM untuk kedua bentuk. Server
 * hanya membaca `q` dan mengabaikan `pad` (route tidak memvalidasi query ketat).
 *
 * Ini mitigasi panjang, bukan penyembunyian isi: q tetap hash, dan OHTTP
 * (Fase 3) yang menyembunyikan path sepenuhnya dari edge.
 */
export const SEARCH_QUERY_SLOT_CHARS = 64;
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomPadChars(count: number, rng: () => number): string {
  let pad = '';
  for (let i = 0; i < count; i += 1) {
    const index = Math.floor(Math.min(1, Math.max(0, rng())) * BASE64URL_CHARS.length);
    pad += BASE64URL_CHARS[Math.min(BASE64URL_CHARS.length - 1, index)];
  }
  return pad;
}

/** Path pencarian dengan panjang total tetap untuk 43-char dan 64-hex. */
export function paddedSearchPath(hashedQuery: string, rng: () => number = Math.random): string {
  const fill = Math.max(0, SEARCH_QUERY_SLOT_CHARS - hashedQuery.length);
  return `/api/users/search?q=${encodeURIComponent(hashedQuery)}&pad=${randomPadChars(fill, rng)}`;
}

export async function searchUsersByHash(hashedQuery: string): Promise<UserSearchHit[]> {
  // [docs/35 Fase 4a] Saat gate aktif, 43-char Argon2id diubah ke index OPRF;
  // 64-hex (legacy / share echo) diteruskan apa adanya.
  const effectiveQuery =
    oprfSearchEnabled() && isRawIdentifierHash(hashedQuery)
      ? await oprfSearchIndex(hashedQuery)
      : hashedQuery;
  const path = paddedSearchPath(effectiveQuery);
  const { ohttpEnabled, ohttpJson } = await import('./ohttpClient');
  if (ohttpEnabled()) {
    return ohttpJson<UserSearchHit[]>(path);
  }
  return api<UserSearchHit[]>(path);
}

/** Versi bertipe untuk hook yang memakai `MinimalProfile`. */
export async function searchProfilesByHash(hashedQuery: string): Promise<MinimalProfile[]> {
  return (await searchUsersByHash(hashedQuery)) as unknown as MinimalProfile[];
}
