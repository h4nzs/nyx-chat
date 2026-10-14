// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.9 WS-E(2)] Cache alamat relay panggilan di sisi klien.
 *
 * Signaling panggilan tidak lagi memakai userId di wire: kedua sisi bertukar
 * **token relay** buram (32 karakter base64url) yang diterbitkan server per sesi
 * (`POST /api/call-tokens`). Modul ini:
 *
 *   - memetakan `userId → token` (untuk mengirim) dan `token → userId` (untuk
 *     mengenali pengirim paket masuk),
 *   - mengambil token secara batch (satu request untuk seluruh peserta grup),
 *   - cache-nya hanya berlaku selama tab hidup — token memang berumur pendek.
 *
 * Kegagalan pengambilan token **tidak** di-fallback ke userId: pemanggil
 * mendapatkan `null`, dan jalur signaling menolak mengirim (fail-closed). Kalau
 * ini jatuh ke userId, sifat unlinkability-nya hilang tanpa terlihat.
 */

import { CALL_RELAY_TOKEN_PATTERN } from '@nyx/shared';
import { api } from './api';

const tokenByUser = new Map<string, string>();
const userByToken = new Map<string, string>();

/** Bentuk token relay (satu definisi dengan server, lewat `@nyx/shared`). */
export const isCallRelayToken = (value: unknown): value is string =>
  typeof value === 'string' && CALL_RELAY_TOKEN_PATTERN.test(value);

/** Hook test: buang cache antar-kasus. */
export function resetCallRelayTokenCache(): void {
  tokenByUser.clear();
  userByToken.clear();
}

function remember(userId: string, token: string): void {
  tokenByUser.set(userId, token);
  userByToken.set(token, userId);
}

/**
 * Ambil alamat relay untuk sekumpulan userId sekaligus (peserta panggilan grup
 * = satu request). Id yang sudah ter-cache tidak diminta ulang.
 */
export async function ensureCallRelayTokens(userIds: string[]): Promise<void> {
  const missing = [...new Set(userIds)].filter(
    (id) => typeof id === 'string' && id.length > 0 && !tokenByUser.has(id)
  );
  if (missing.length === 0) return;

  try {
    const res = await api<{ self?: unknown; peers?: Record<string, unknown> }>('/api/call-tokens', {
      method: 'POST',
      body: JSON.stringify({ userIds: missing }),
    });
    const peers = res?.peers ?? {};
    for (const [userId, token] of Object.entries(peers)) {
      if (isCallRelayToken(token)) remember(userId, token);
    }
  } catch (e) {
    console.warn('[CallRelay] Gagal mengambil alamat relay panggilan:', e);
  }
}

/** Alamat relay untuk satu peer, atau `null` bila server tidak memberi token. */
export async function callRelayTokenFor(userId: string): Promise<string | null> {
  const cached = tokenByUser.get(userId);
  if (cached) return cached;
  await ensureCallRelayTokens([userId]);
  return tokenByUser.get(userId) ?? null;
}

/** Pemetaan balik alamat relay paket masuk → userId, atau `null` bila tak dikenal. */
export async function userIdForCallRelayToken(token: unknown): Promise<string | null> {
  if (!isCallRelayToken(token)) return null;
  const cached = userByToken.get(token);
  if (cached) return cached;

  try {
    const res = await api<{ users?: Record<string, unknown> }>('/api/call-tokens/resolve', {
      method: 'POST',
      body: JSON.stringify({ tokens: [token] }),
    });
    const userId = res?.users?.[token];
    if (typeof userId === 'string' && userId.length > 0) {
      remember(userId, token);
      return userId;
    }
  } catch (e) {
    console.warn('[CallRelay] Gagal menyelesaikan alamat relay panggilan:', e);
  }
  return null;
}
