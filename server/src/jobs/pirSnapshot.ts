// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP5] Segarkan shard PIR secara berkala.
 *
 * Snapshot dibangun dari DB, ditandatangani per server, lalu dikirim ke setiap
 * sidecar lewat `/admin/rebuild` (hot-swap per shard; shard lama tetap melayani
 * sampai penggantinya tiba). Tanpa penyegaran, user yang mendaftar setelah
 * build terakhir tidak akan muncul di pencarian.
 *
 * Dua jadwal, satu kunci job:
 *   - `PIR_REFRESH_CRON` (04:15) — rebuild penuh harian, jaring pengaman.
 *   - `PIR_DIRTY_REFRESH_CRON` (tiap 3 menit) — rebuild hanya bila penanda
 *     generasi (`pir/dirty.ts`) menunjukkan ada penulisan baru.
 *
 * Batas yang disengaja:
 *   - Hanya jalan bila PIR aktif, konfigurasi dua server lengkap, dan
 *     `PIR_ADMIN_TOKEN` ada.
 *   - Satu putaran pada satu waktu; kegagalan dicatat, tidak pernah mematikan
 *     cron.
 */

import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { redisClient } from '../lib/redis.js';
import { isPirEnabled, loadPirConfig, type PirConfig } from '../pir/config.js';
import {
  markPirSnapshotBuilt,
  pirSnapshotBuiltGeneration,
  pirSnapshotGeneration,
  type PirDirtyRedis,
} from '../pir/dirty.js';
import { rebuildPirShards, type PirRebuildResult } from '../pir/rebuild.js';
import { runWithJobLock } from '../utils/jobLock.js';

/** Jam refresh harian; jaring pengaman bila penanda generasi hilang. */
export const PIR_REFRESH_CRON = '15 4 * * *';
/**
 * [staleness user baru] Interval rebuild untuk perubahan yang ditandai.
 * 3 menit: cukup cepat agar pendaftar langsung bisa dicari, cukup jarang agar
 * rebuild O(N) tidak berjalan terus-menerus saat ramai.
 */
export const PIR_DIRTY_REFRESH_CRON = '*/3 * * * *';

export interface PirRefreshDeps {
  collect?: () => Promise<import('../pir/snapshot.js').PirRecordSource[]>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  redis?: PirDirtyRedis;
  signingKeys?: Map<string, import('../pir/manifest.js').PirSigningKey>;
}

async function collectSources(): Promise<import('../pir/snapshot.js').PirRecordSource[]> {
  const users = await prisma.user.findMany({
    where: { oprfIndex: { not: null } },
    select: {
      id: true,
      encryptedProfile: true,
      isVerified: true,
      hasCompletedOnboarding: true,
      oprfIndex: true,
      devices: {
        orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { publicKey: true, pqPublicKey: true, signingKey: true },
      },
    },
  });
  return users.map((user) => ({
    id: user.id,
    encryptedProfile: user.encryptedProfile,
    isVerified: user.isVerified,
    hasCompletedOnboarding: user.hasCompletedOnboarding,
    oprfIndex: user.oprfIndex,
    device: user.devices[0] ?? null,
  }));
}

/**
 * Konfigurasi job. `null` = job mati. Konfigurasi PIR yang aktif tetapi tidak
 * punya `PIR_ADMIN_TOKEN` tetap melempar saat boot daripada diam-diam tidak
 * pernah menyegarkan shard.
 */
export function loadPirRefreshConfig(env: NodeJS.ProcessEnv = process.env): PirConfig | null {
  if (!isPirEnabled(env)) return null;
  // Token diperiksa SEBELUM parse penuh: tanpa token tidak ada yang bisa
  // dikirim, jadi konfigurasi setengah jadi tidak menggagalkan boot.
  if (!env.PIR_ADMIN_TOKEN?.trim()) {
    console.warn('[PIR] PIR_ADMIN_TOKEN kosong: refresh shard tidak akan dikirim ke sidecar');
    return null;
  }
  return loadPirConfig(env);
}

export async function refreshPirSnapshot(
  config: PirConfig,
  deps: PirRefreshDeps = {},
): Promise<PirRebuildResult> {
  return rebuildPirShards(config, {
    collect: deps.collect ?? collectSources,
    signingKeys: deps.signingKeys,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
}

export type PirDirtyOutcome = 'rebuilt' | 'clean' | 'unknown';

/**
 * Rebuild HANYA bila generasi penanda lebih baru dari yang sudah tercakup.
 *
 * Generasi dibaca SEBELUM build: bila ada pendaftaran saat rebuild berjalan,
 * `gen` sudah lebih besar dari generasi yang dicatat, sehingga tick berikutnya
 * membangun lagi (tidak ada perubahan yang hilang).
 */
export async function refreshPirSnapshotIfDirty(
  config: PirConfig,
  deps: PirRefreshDeps = {},
): Promise<{ status: PirDirtyOutcome; epoch?: number; entries?: number }> {
  const redis = deps.redis ?? (redisClient as unknown as PirDirtyRedis);
  let generation: number;
  let built: number;
  try {
    generation = await pirSnapshotGeneration(redis);
    if (generation <= 0) return { status: 'clean' };
    built = await pirSnapshotBuiltGeneration(redis);
  } catch (error) {
    // Redis tidak terbaca: jangan rebuild buta tiap tick — cron harian tetap jalan.
    console.warn(
      '[PIR] status penanda tidak terbaca, rebuild interval dilewati:',
      error instanceof Error ? error.message : error,
    );
    return { status: 'unknown' };
  }
  if (built >= generation) return { status: 'clean' };

  const result = await refreshPirSnapshot(config, deps);
  try {
    await markPirSnapshotBuilt(redis, generation);
  } catch (error) {
    console.warn(
      '[PIR] gagal mencatat generasi yang sudah dibangun:',
      error instanceof Error ? error.message : error,
    );
  }
  return { status: 'rebuilt', epoch: result.epoch, entries: result.entries };
}

export function startPirSnapshotRefresher(
  env: NodeJS.ProcessEnv = process.env,
  deps: PirRefreshDeps = {},
): boolean {
  const config = loadPirRefreshConfig(env);
  if (!config) {
    console.log('[PIR] snapshot refresher nonaktif (PIR_ENABLED/PIR_ADMIN_TOKEN belum diatur)');
    return false;
  }
  if (!config.shardDir) {
    console.warn(
      '[PIR] PIR_SHARD_DIR kosong: sidecar yang restart harus menerima rebuild ulang',
    );
  }

  let running = false;
  /** Satu putaran pada satu waktu; kunci Redis menjaga N worker pm2. */
  const schedule = (cronExpr: string, run: () => Promise<void>) => {
    // [audit F-07] `running` hanya menjaga proses ini; kunci Redis menjaga N
    // worker pm2. TTL 2 jam supaya kunci tidak kedaluwarsa di tengah rebuild.
    cron.schedule(cronExpr, () => runWithJobLock('pir-snapshot', 7200, async () => {
      if (running) {
        console.warn('[PIR] refresh dilewati: putaran sebelumnya masih berjalan');
        return;
      }
      running = true;
      try {
        await run();
      } catch (error) {
        console.error('[PIR] refresh gagal:', error instanceof Error ? error.message : error);
      } finally {
        running = false;
      }
    }));
  };

  schedule(PIR_REFRESH_CRON, async () => {
    const result = await refreshPirSnapshot(config, deps);
    console.log(
      `[PIR] shard diperbarui: epoch=${result.epoch} entries=${result.entries} shards=${result.shards} persisted=${result.persisted}`,
    );
  });

  schedule(PIR_DIRTY_REFRESH_CRON, async () => {
    const result = await refreshPirSnapshotIfDirty(config, deps);
    if (result.status === 'rebuilt') {
      console.log(
        `[PIR] shard diperbarui (perubahan baru): epoch=${result.epoch} entries=${result.entries}`,
      );
    }
  });

  console.log(
    `[PIR] shard refresher aktif (harian ${PIR_REFRESH_CRON}, perubahan ${PIR_DIRTY_REFRESH_CRON})`,
  );
  return true;
}
