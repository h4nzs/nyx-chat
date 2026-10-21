// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 4] Kunci limiter pencarian.
 *
 * Dipisah dari `middleware/rateLimiter.ts` supaya bisa diuji tanpa memuat
 * `express-rate-limit` + `RedisStore` (store itu mencoba bicara ke Redis saat
 * inisialisasi dan mencetak error di lingkungan test tanpa Redis).
 *
 * Kunci = tag HMAC, bukan userId/IP mentah: snapshot Redis tidak boleh memuat
 * daftar akun yang sedang mencari atau alamat mereka (docs/28 Tier 0).
 */

import type { Request } from 'express';
import { clientIpTag } from './clientIp.js';
import { identityTag } from './redisIdentity.js';

export function searchRateKey(req: Request): string {
  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  return userId ? identityTag(userId) : clientIpTag(req);
}
