// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Gerbang token: "apakah sesi ini masih boleh dipakai?".
 *
 * Sebelum ini pemeriksaannya hanya hidup di `middleware/auth.ts` (REST), jadi
 * pintu socket (`realtime/gateway.ts`) menerima token yang sudah di-blacklist
 * atau milik akun yang sudah di-ban: KICK memutus koneksi, lalu klien reconnect
 * dengan cookie `at` yang sama dan diterima lagi. Jalur WebTransport punya
 * masalah yang sama, dan tidak melewati `requireAuth` sama sekali — karena itu
 * `isUserBanned` dipakai juga di `network/redisBridge.ts`.
 *
 * Semantik kegagalan infrastruktur sengaja SAMA dengan versi lama di requireAuth
 * (jangan diubah tanpa keputusan):
 *   - Redis mati → blacklist JTI dilewati (log), ban tetap dicoba lewat DB;
 *   - Redis DAN DB mati → lolos (fail-open), karena menolak semua sesi saat
 *     Redis/Database down mengubah gangguan infra menjadi pemadaman total.
 */

/** Klaim minimum yang dibutuhkan gerbang ini. */
export interface TokenGatePayload {
  id: string;
  jti?: string;
}

/** Irisan klien Redis yang dipakai (cukup untuk fake di test). */
export interface TokenGateRedis {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
}

/** Irisan klien Prisma yang dipakai. */
export interface TokenGateDb {
  user: {
    findUnique(args: unknown): Promise<{ bannedAt: Date | null; banReason: string | null } | null>;
  };
}

export type TokenGateResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string; reason?: string };

export type BanVerdict = { banned: false } | { banned: true; reason?: string };

/** Pesan ban identik dengan middleware REST — klien mem-parse teks ini. */
export const SUSPENDED_ERROR = 'ACCESS DENIED: Your account has been suspended.';

/** Cache status ban di Redis (detik) — di-invalidate saat ban/unban. */
const BAN_CACHE_TTL_SECONDS = 900;

/**
 * Apakah akun ini di-ban?
 *
 * Satu query DB per user per 15 menit (hasilnya di-cache 'OK'/'BANNED'), jadi
 * aman dipanggil di jalur per-pesan. Bila Redis mati, ban tetap diperiksa lewat
 * DB — paritas dengan REST, di mana kegagalan cache tidak boleh mematikan
 * penegakan ban. Ban yang benar-benar terjadi tetap langsung terasa karena
 * `routes/admin.ts` mengirim KICK dan menghapus cache-nya.
 */
export async function isUserBanned (
  deps: { redis: TokenGateRedis; db: TokenGateDb },
  userId: string
): Promise<BanVerdict> {
  const { redis, db } = deps;
  const banCacheKey = `ban_status:${userId}`;

  try {
    const cachedStatus = await redis.get(banCacheKey);
    if (cachedStatus === 'BANNED') return { banned: true };
    if (cachedStatus) return { banned: false };

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, banReason: true }
    });
    if (user?.bannedAt) {
      await redis.setEx(banCacheKey, BAN_CACHE_TTL_SECONDS, 'BANNED').catch(() => {});
      return { banned: true, reason: user.banReason ?? undefined };
    }
    await redis.setEx(banCacheKey, BAN_CACHE_TTL_SECONDS, 'OK').catch(() => {});
    return { banned: false };
  } catch {
    console.warn('[Auth] Ban cache unavailable — falling back to direct DB query');
    try {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { bannedAt: true, banReason: true }
      });
      if (user?.bannedAt) return { banned: true, reason: user.banReason ?? undefined };
      return { banned: false };
    } catch {
      console.error('[Auth] Redis AND DB unavailable — skipping ban check entirely');
      return { banned: false };
    }
  }
}

export async function evaluateTokenGate (
  payload: TokenGatePayload,
  deps: { redis: TokenGateRedis; db: TokenGateDb }
): Promise<TokenGateResult> {
  // 1. Token yang sudah di-revoke (logout, logout-all, revokasi sesi).
  if (payload.jti) {
    try {
      if (await deps.redis.get(`revoked_jti:${payload.jti}`)) {
        return { ok: false, status: 401, error: 'Token revoked. Please login again.' };
      }
    } catch {
      console.warn('[Auth] Redis unavailable — skipping token blacklist check');
    }
  }

  // 2. Akun yang di-ban.
  const ban = await isUserBanned(deps, payload.id);
  if (ban.banned) {
    return { ok: false, status: 403, error: SUSPENDED_ERROR, reason: ban.reason };
  }

  return { ok: true };
}
