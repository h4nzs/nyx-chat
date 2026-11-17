// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.16.2 T3] Deep link push tanpa membocorkan id percakapan.
 *
 * Provider push hanya melihat token acak 256-bit per pengiriman per
 * subscription. Pemetaan token → percakapan hidup di Redis (milik server), bukan
 * di payload, jadi FCM/APNs tidak bisa mengorelasikan perangkat, percakapan,
 * maupun irama pesan.
 *
 * Token TIDAK dihapus saat dipakai: notifikasi bisa diklik berkali-kali dan
 * React StrictMode memanggil resolver dua kali. Batas hidupnya adalah TTL;
 * setelah itu klik jatuh ke daftar chat seperti biasa.
 */

import { randomBytes } from 'node:crypto';

export const PUSH_LINK_TTL_SECONDS = 24 * 60 * 60;

const PREFIX = 'push:link:';

/** Bentuk minimal klien Redis yang dibutuhkan (mudah di-fake di tes). */
export interface PushLinkStore {
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function pushLinkKey(token: string): string {
  return `${PREFIX}${token}`;
}

/**
 * Buat token untuk satu pengiriman push ke satu subscription.
 *
 * @returns token opaque, atau `null` bila Redis gagal — notifikasi tetap
 *          dikirim tanpa deep link (kegagalan penyimpanan tidak boleh menahan
 *          notifikasi).
 */
export async function createPushLinkToken(
  store: PushLinkStore,
  opts: { userId: string; subscriptionId: string; conversationId: string }
): Promise<string | null> {
  const token = randomBytes(32).toString('base64url');
  try {
    await store.set(
      pushLinkKey(token),
      JSON.stringify({
        userId: opts.userId,
        subscriptionId: opts.subscriptionId,
        conversationId: opts.conversationId,
      }),
      { EX: PUSH_LINK_TTL_SECONDS }
    );
    return token;
  } catch {
    return null;
  }
}

/**
 * Tukar token menjadi id percakapan. Hanya pemilik token (userId yang sama)
 * yang boleh membukanya; token orang lain tidak membocorkan apa pun.
 */
export async function resolvePushLinkToken(
  store: PushLinkStore,
  opts: { token: string; userId: string }
): Promise<string | null> {
  const { token, userId } = opts;
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  if (typeof userId !== 'string' || userId.length === 0) return null;

  try {
    const raw = await store.get(pushLinkKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      userId?: unknown;
      subscriptionId?: unknown;
      conversationId?: unknown;
    };
    if (parsed.userId !== userId) return null;
    return typeof parsed.conversationId === 'string' ? parsed.conversationId : null;
  } catch {
    return null;
  }
}
