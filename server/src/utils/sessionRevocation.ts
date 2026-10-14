// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(4)] Revokasi sesi (remote logout) — logika dipindah ke util
 * supaya bisa diuji **perilakunya** dengan klien Prisma palsu (aturan repo:
 * unit test tanpa Postgres/Redis), bukan sekadar regex atas source.
 *
 * Yang dikunci (security-relevant):
 *   1. Sesi milik user lain tidak bisa dicabut — dicari lewat `device.userId`
 *      dan dibalas 404 (bukan 403: jangan membocorkan keberadaan jti milik
 *      orang lain).
 *   2. Pencabutan berlaku untuk **seluruh family** (rotasi token tidak boleh
 *      menyisakan token lama yang masih bisa dipakai), lalu semua JTI family
 *      yang belum kedaluwarsa dimasukkan blacklist Redis.
 *   3. JTI yang sudah kedaluwarsa tidak perlu di-blacklist (TTL ≤ 0).
 */

import { ApiError } from './errors.js';

export interface RevocableToken {
  jti: string;
  familyId: string;
  deviceId: string | null;
  expiresAt: Date | string;
  device?: { userId: string } | null;
}

export interface SessionRevocationDb {
  refreshToken: {
    findUnique(args: { where: { jti: string }; include?: unknown }): Promise<RevocableToken | null>;
    updateMany(args: {
      where: { familyId: string; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
    findMany(args: {
      where: { familyId: string };
      select: { jti: true; expiresAt: true };
    }): Promise<Array<{ jti: string; expiresAt: Date | string }>>;
  };
}

/** Penulis blacklist JTI (produksi: `redisClient.setEx`). */
export type SessionBlacklistFn = (jti: string, ttlSeconds: number) => Promise<void>;

export interface SessionRevocationResult {
  deviceId: string | null;
  familyId: string;
  /** JTI yang benar-benar dimasukkan blacklist (belum kedaluwarsa). */
  revokedJtis: string[];
}

/**
 * Cabut satu sesi beserta seluruh family-nya. Melempar `ApiError(404)` bila jti
 * tidak ada atau bukan milik `userId`.
 */
export async function revokeSessionFamily(
  db: SessionRevocationDb,
  opts: { jti: string; userId: string; now?: number },
  blacklist: SessionBlacklistFn
): Promise<SessionRevocationResult> {
  const token = await db.refreshToken.findUnique({
    where: { jti: opts.jti },
    include: { device: { select: { userId: true } } },
  });

  if (!token || token.device?.userId !== opts.userId) {
    throw new ApiError(404, 'Session not found or unauthorized');
  }

  const now = opts.now ?? Date.now();

  await db.refreshToken.updateMany({
    where: { familyId: token.familyId, revokedAt: null },
    data: { revokedAt: new Date(now) },
  });

  const familyTokens = await db.refreshToken.findMany({
    where: { familyId: token.familyId },
    select: { jti: true, expiresAt: true },
  });

  const revokedJtis: string[] = [];
  for (const ft of familyTokens) {
    const expiresIn = Math.floor((new Date(ft.expiresAt).getTime() - now) / 1000);
    if (expiresIn > 0) {
      await blacklist(ft.jti, expiresIn);
      revokedJtis.push(ft.jti);
    }
  }

  return { deviceId: token.deviceId, familyId: token.familyId, revokedJtis };
}
