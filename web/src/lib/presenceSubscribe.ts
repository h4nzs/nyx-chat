// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/28 Tier 1.5 / D14] Presence lazy/opt-in — sisi klien.
 *
 * Server tidak lagi mengirim snapshot peer saat connect. Klien MEMINTA status
 * untuk kontak yang sedang ia tampilkan; server memvalidasi bahwa peminta memang
 * peer (dari membership) dan mengirim join/leave hanya ke pelanggan.
 *
 * Helper ini menyatukan permintaan dari beberapa permukaan UI (daftar chat,
 * header chat, modal profil) menjadi SATU event `presence:subscribe`:
 *   - dedupe: himpunan sama & baru saja dikirim → tidak mengirim ulang;
 *   - debounce: beberapa pemanggil dalam satu tick digabung;
 *   - throttle: pengiriman berikutnya menunggu interval minimum (selaras dengan
 *     rate limit server `presence_subscribe` 60/menit).
 */

import { transportClient } from './transportClient';

/** Interval minimum antar-permintaan (ms) — di bawah rate limit server. */
export const PRESENCE_SUBSCRIBE_MIN_INTERVAL_MS = 20_000;

let lastRequested: string[] = [];
let lastSentAt = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUserIds: string[] | null = null;

function normalize(userIds: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const id of userIds) {
    if (typeof id === 'string' && id.length > 0) set.add(id);
  }
  return Array.from(set).sort();
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function flush(): void {
  debounceTimer = null;
  const ids = pendingUserIds ?? [];
  pendingUserIds = null;

  const now = Date.now();
  const unchangedAndRecent = sameIds(ids, lastRequested) && now - lastSentAt < PRESENCE_SUBSCRIBE_MIN_INTERVAL_MS;
  if (unchangedAndRecent) return;

  lastRequested = ids;
  lastSentAt = now;
  try {
    transportClient.sendEvent('presence:subscribe', { userIds: ids });
  } catch {
    // Transport belum siap — permintaan berikutnya (interval/visibility) akan
    // mengulang; presence bukan jalur kritis.
  }
}

/**
 * Minta status presence untuk `userIds` (union dari semua permukaan UI yang
 * sedang menampilkan kontak). Aman dipanggil sesering apa pun.
 */
export function requestPresence(userIds: Iterable<string>): void {
  pendingUserIds = normalize(userIds);
  if (debounceTimer) return;
  debounceTimer = setTimeout(flush, 120);
}

/** Hook test / logout: lupakan cache permintaan supaya event berikutnya dikirim. */
export function resetPresenceSubscriptionCache(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  pendingUserIds = null;
  lastRequested = [];
  lastSentAt = 0;
}
