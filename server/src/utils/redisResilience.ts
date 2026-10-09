// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

// Ketahanan Redis untuk jalur realtime. Dua kegagalan yang dulunya fatal:
//   1. checkRateLimit melempar saat Redis down → rejection lepas dari handler
//      socket async → unhandledRejection → crash proses. Kini FAIL-OPEN:
//      trafik jalan tanpa limit sementara Redis mati (limit HTTP di app.ts
//      tetap berdiri di jalur Express tersendiri).
//   2. Cache active-device 60s (isActiveDeviceAllowed) tidak tahu kalau
//      `active_device` baru saja di-overwrite oleh login di perangkat lain →
//      device BARU yang sah diblokir ≤60s. Kini login/logout mengirim sinyal
//      invalidasi lintas-proses via nyx:upstream:99 (opcode DISCONNECT →
//      handleDisconnect) agar instance mana pun menghapus cache user itu.
// Factory + dependency injection agar bisa di-unit-test dengan fake client
// (konvensi repo: test server tidak boleh butuh Postgres/Redis nyata).

import { sanitizeForLog } from './logger.js';
// [docs/28 Tier 1.5 / D14] key rate-limit memakai tag, bukan userId asli.
import { identityKey } from './redisIdentity.js';

/** Lua atomic: INCR + EXPIRE dalam satu perintah — mencegah key hidup
 *  selamanya bila proses mati di antara dua perintah (rate limit permanen). */
export const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/** Minimal structural client (cukup eval) — real RedisClientType memenuhinya. */
export interface EvalLikeClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
}

export type CheckRateLimit = (
  userId: string,
  event: string,
  limit: number,
  windowSeconds: number
) => Promise<boolean>;

/**
 * Bangun fungsi checkRateLimit di atas client Redis yang diberikan.
 * Semantik: hitungan <= limit → true (diizinkan); Redis gagal → true
 * (fail-open, dengan log) — jangan biarkan infrastruktur limit mematikan
 * seluruh trafik realtime.
 */
export function createCheckRateLimit(client: EvalLikeClient): CheckRateLimit {
  return async function checkRateLimit(userId, event, limit, windowSeconds) {
    const key = `${identityKey('rate_limit:socket', userId)}:${event}`;
    try {
      const result = await client.eval(RATE_LIMIT_LUA, {
        keys: [key],
        arguments: [String(windowSeconds)],
      });
      const current = Number(result);
      // Balasan tidak masuk akal (NaN/negatif) → anggap tak terukur, izinkan.
      if (!Number.isFinite(current) || current < 0) return true;
      return current <= limit;
    } catch (err) {
      console.error(
        `[RateLimit] Redis eval gagal (fail-open) untuk event ${sanitizeForLog(event)} / user ${sanitizeForLog(userId)}:`,
        err
      );
      return true;
    }
  };
}

/** Minimal publisher (cukup publish) — real RedisClientType memenuhinya. */
export interface PublishLikeClient {
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * Channel pub/sub khusus invalidasi cache active-device. Sengaja BUKAN opcode
 * 99 (DISCONNECT): jalur itu memicu handleDisconnect → broadcast presence
 * 'leave' palsu ke kontak. Channel ini hanya menghapus cache lokal di tiap
 * instance — tanpa efek samping presence.
 */
export const DEVICE_CACHE_INVALIDATE_CHANNEL = 'nyx:device-cache-invalidate';

/**
 * Sinyal invalidasi cache active-device untuk `userId` di SEMUA instance
 * server (cache lokal `isActiveDeviceAllowed` hidup 60s per proses). Dikirim
 * saat login/logout mengubah `active_device:<userId>` di Redis. Best-effort:
 * kegagalan publish tidak boleh menggagalkan login/logout.
 */
export async function invalidateActiveDeviceCache(
  userId: string,
  publisher: PublishLikeClient
): Promise<void> {
  try {
    await publisher.publish(DEVICE_CACHE_INVALIDATE_CHANNEL, JSON.stringify({ userId }));
  } catch (err) {
    console.error(
      `[RedisResilience] Gagal mengirim invalidasi active-device untuk ${sanitizeForLog(userId)}:`,
      err
    );
  }
}
