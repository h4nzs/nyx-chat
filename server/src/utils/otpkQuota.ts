// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Kuota harian pengambilan bundle yang mengonsumsi One-Time PreKey (OTPK),
 * per pasangan (requester, target).
 *
 * Tanpa kuota, satu akun bisa menghabiskan stok OTPK korban dengan loop
 * GET /prekey-bundle/:userId sehingga korban kehabisan OTPK untuk handshake
 * baru. Counter Redis atomik INCR+EXPIRE per pasangan; over-quota → 429
 * SEBELUM ada OTPK dikonsumsi (fail-closed). NaN dari Redis = fail-open
 * (preseden limiter lain di repo: infra error tidak memblokir trafik sah).
 */

import { ApiError } from './errors.js';
// [docs/28 Tier 4] key Redis tidak menyematkan userId asli (tag HMAC pepper).
import { identityTag } from './redisIdentity.js';

/** Batas konsumsi OTPK per pasangan (requester, target) per 24 jam. */
export const OTPK_FETCH_DAILY_MAX = 30;

/** TTL counter kuota (detik) — 24 jam. */
export const OTPK_QUOTA_TTL_SECONDS = 86400;

/**
 * Kunci Redis counter kuota OTPK untuk satu pasangan.
 *
 * [docs/28 Tier 4] Kedua sisi di-tag (`identityTag`), bukan userId asli: snapshot
 * Redis/AOF tidak boleh memetakan "siapa meminta pre-key siapa". Deterministik
 * per pasangan → counter tetap idempoten seperti sebelumnya.
 */
export const otpkQuotaKey = (requesterId: string, targetId: string): string =>
  `otpkq:${identityTag(requesterId)}:${identityTag(targetId)}`;

export type OtpkCounterFn = (key: string, ttlSeconds: number) => Promise<number>;

/**
 * Membangun gate kuota dengan counter yang dapat disuntik (untuk unit test).
 * Gate melempar ApiError(429) begitu ADA pasangan yang melebihi batas;
 * dipanggil sebelum query konsumsi OTPK sehingga tidak ada OTPK terbuang.
 */
export const makeOtpkQuotaGate =
  (incr: OtpkCounterFn) =>
  async (requesterId: string, targetIds: string[]): Promise<void> => {
    const counts = await Promise.all(
      targetIds.map((targetId) =>
        incr(otpkQuotaKey(requesterId, targetId), OTPK_QUOTA_TTL_SECONDS)
      )
    );

    const exceeded = counts.some(
      (count) => !Number.isNaN(count) && count > OTPK_FETCH_DAILY_MAX
    );
    if (exceeded) {
      throw new ApiError(429, 'Pre-key bundle quota exceeded for one or more users');
    }
  };
