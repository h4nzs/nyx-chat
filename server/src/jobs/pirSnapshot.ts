// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4d] Segarkan snapshot PIR secara berkala.
 *
 * Snapshot dibangun offline; tanpa penyegaran, user yang mendaftar setelah
 * snapshot terakhir tidak akan pernah muncul di pencarian PIR. Job ini
 * membangun ulang snapshot dari DB lalu meminta sidecar mengganti index aktif
 * lewat `/admin/rebuild` (hot-swap; index lama tetap melayani sampai selesai).
 *
 * Batas yang disengaja:
 *   - Hanya jalan bila PIR aktif, URL sidecar valid, dan `PIR_ADMIN_TOKEN` ada.
 *   - `PIR_SNAPSHOT_PATH` ditulis atomik agar restart sidecar memuat snapshot
 *     terbaru; tanpa path, refresh hanya hidup di memori sidecar.
 *   - Satu putaran pada satu waktu; kegagalan dicatat, tidak pernah mematikan
 *     cron.
 */

import cron from 'node-cron';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { loadPirConfig } from '../pir/config.js';
import {
  buildPirSnapshot,
  parsePirRecordBytes,
  type PirRecordSource,
} from '../pir/snapshot.js';

/** Jam refresh harian; staleness user baru dibatasi maksimal ~24 jam. */
export const PIR_REFRESH_CRON = '15 4 * * *';
const REFRESH_TIMEOUT_MS = 60 * 60_000;

export interface PirRefreshConfig {
  serviceUrl: string;
  adminToken: string;
  recordBytes: number;
  snapshotPath: string | null;
}

export interface PirRefreshResult {
  epoch: number;
  entries: number;
  persisted: boolean;
}

export interface PirRefreshDeps {
  collect?: () => Promise<PirRecordSource[]>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function loadPirRefreshConfig(env: NodeJS.ProcessEnv = process.env): PirRefreshConfig | null {
  const config = loadPirConfig(env);
  const adminToken = env.PIR_ADMIN_TOKEN?.trim();
  if (!config || !adminToken) return null;
  return {
    serviceUrl: config.serviceUrl,
    adminToken,
    recordBytes: parsePirRecordBytes(env.PIR_RECORD_BYTES),
    snapshotPath: env.PIR_SNAPSHOT_PATH?.trim() || null,
  };
}

async function collectSources(): Promise<PirRecordSource[]> {
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

export async function refreshPirSnapshot(
  config: PirRefreshConfig,
  deps: PirRefreshDeps = {},
): Promise<PirRefreshResult> {
  const collect = deps.collect ?? collectSources;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  const snapshot = buildPirSnapshot(await collect(), config.recordBytes, now());
  const body = JSON.stringify(snapshot);

  if (config.snapshotPath) {
    const output = path.resolve(config.snapshotPath);
    await mkdir(path.dirname(output), { recursive: true });
    const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, output);
  }

  const response = await fetchImpl(`${config.serviceUrl}/admin/rebuild`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nyx-pir-internal': config.adminToken,
    },
    body,
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`PIR refresh HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  return {
    epoch: snapshot.epoch,
    entries: snapshot.entries.length,
    persisted: Boolean(config.snapshotPath),
  };
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
  if (!config.snapshotPath) {
    console.warn(
      '[PIR] PIR_SNAPSHOT_PATH kosong: refresh hanya di memori sidecar dan hilang saat restart',
    );
  }

  let running = false;
  cron.schedule(PIR_REFRESH_CRON, async () => {
    if (running) {
      console.warn('[PIR] refresh dilewati: putaran sebelumnya masih berjalan');
      return;
    }
    running = true;
    try {
      const result = await refreshPirSnapshot(config, deps);
      console.log(
        `[PIR] snapshot diperbarui: epoch=${result.epoch} entries=${result.entries} persisted=${result.persisted}`,
      );
    } catch (error) {
      console.error('[PIR] refresh gagal:', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  });
  console.log(`[PIR] snapshot refresher aktif (${PIR_REFRESH_CRON})`);
  return true;
}
