// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4d] Penanda "snapshot PIR basi".
 *
 * Snapshot PIR adalah ARTEFAK hasil build (`pir/snapshot.ts`), bukan view atas
 * DB: baris yang ditulis setelah build terakhir tidak terlihat oleh pencarian
 * sampai snapshot dibangun ulang. Dulu satu-satunya pemicu adalah cron harian
 * 04:15 (`PIR_REFRESH_CRON`), jadi user yang mendaftar (atau mengganti nama,
 * verifikasi, menambah perangkat) tidak ketemu hingga ~24 jam — dan saat
 * `VITE_PIR_ENABLED=1` klien tidak punya fallback (miss = `[]`).
 *
 * Menandai lewat **generasi** (bukan "1") membuat rebuild tidak menghilangkan
 * perubahan yang terjadi saat rebuild berjalan: job membaca generasi G,
 * membangun, lalu mencatat bahwa G sudah tercakup. Bila ada penulisan baru di
 * tengah build, generasi naik ke G+1 dan tick berikutnya membangun lagi.
 *
 * Biaya penanda = satu `INCR`; **tidak** memicu rebuild per pendaftaran (itu
 * akan O(N) per signup: sidecar hanya punya `/admin/rebuild` yang mengganti
 * seluruh index). Rebuild terjadi sekali per jendela lewat job interval.
 *
 * Kegagalan Redis TIDAK boleh menggagalkan registrasi/login/profil — semua
 * fungsi di sini menelan error dan mencatatnya. Cron harian tetap jadi jaring
 * pengaman bila penanda hilang.
 */

import { redisClient } from '../lib/redis.js';
import { isPirEnabled } from './config.js';

/** Naik setiap ada baris `User`/`Device` yang berubah bentuk di snapshot. */
export const PIR_SNAPSHOT_GEN_KEY = 'pir:snapshot:gen';
/** Generasi terakhir yang sudah masuk snapshot aktif. */
export const PIR_SNAPSHOT_BUILT_KEY = 'pir:snapshot:built';

/** Bagian klien Redis yang dipakai; cukup sempit agar bisa di-fake di test. */
export interface PirDirtyRedis {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface PirDirtyDeps {
  redis?: PirDirtyRedis;
  env?: NodeJS.ProcessEnv;
}

function parseGeneration(raw: string | null): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Tandai snapshot basi. `reason` hanya untuk log (tanpa identitas pengguna).
 * Mengembalikan `true` bila penanda tercatat.
 */
export async function markPirSnapshotDirty(
  reason: string,
  deps: PirDirtyDeps = {},
): Promise<boolean> {
  const redis = deps.redis ?? redisClient;
  if (!isPirEnabled(deps.env ?? process.env)) return false;
  try {
    await redis.incr(PIR_SNAPSHOT_GEN_KEY);
    return true;
  } catch (error) {
    console.warn(
      `[PIR] gagal menandai snapshot basi (${reason}):`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Generasi perubahan terakhir (0 = belum pernah ditandai). */
export async function pirSnapshotGeneration(
  redis: PirDirtyRedis = redisClient,
): Promise<number> {
  return parseGeneration(await redis.get(PIR_SNAPSHOT_GEN_KEY));
}

/** Generasi yang sudah tercakup snapshot aktif. */
export async function pirSnapshotBuiltGeneration(
  redis: PirDirtyRedis = redisClient,
): Promise<number> {
  return parseGeneration(await redis.get(PIR_SNAPSHOT_BUILT_KEY));
}

/**
 * Catat bahwa generasi `generation` sudah masuk snapshot. Dipanggil HANYA
 * setelah sidecar menerima rebuild; kegagalan di sini berarti build berikutnya
 * mengulang pekerjaan (aman, hanya lebih mahal).
 */
export async function markPirSnapshotBuilt(
  redis: PirDirtyRedis = redisClient,
  generation?: number,
): Promise<void> {
  const value = generation ?? (await pirSnapshotGeneration(redis));
  if (value <= 0) return;
  await redis.set(PIR_SNAPSHOT_BUILT_KEY, String(value));
}
