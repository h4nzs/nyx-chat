// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { purgeSealedUserRows } from '../utils/routingIdentity.js';
import { runCleanup } from './cleanup.js';
import { runWithJobLock } from '../utils/jobLock.js';
// [docs/30 WS-G] Metrik event-only untuk sweeper: durasi, hasil, jumlah baris
// yang dibersihkan per jenis (tanpa identitas apa pun).
import {
  incCounter,
  observeHistogram,
  setGauge,
  nowSeconds,
  SWEEPER_DURATION,
  SWEEPER_LAST_RUN,
  SWEEPER_DELETED,
} from '../utils/metrics.js';

/**
 * Satu putaran pembersihan harian. Dipisahkan dari penjadwalan supaya jalur
 * manual (`POST /api/admin/cleanup`) menjalankan **kode yang sama** — bukan
 * salinan yang bisa menyimpang.
 */
export async function sweepOnce(now: Date = new Date()): Promise<{ result: 'ok' | 'error' }> {
  const startedAt = Date.now();
  let result: 'ok' | 'error' = 'ok';
  try {
    // Semua logika ada di `jobs/cleanup.ts` (satu implementasi, teruji perilaku);
    // di sini hanya pengikatan ke Prisma nyata, metrik, dan log.
    const report = await runCleanup(prisma, {
      now,
      purgeUser: (userId) => purgeSealedUserRows(prisma, userId),
      log: (message) => console.log(message),
    });

    const perStep: Array<[string, number]> = [
      ['refresh_token', report.refreshTokens],
      ['session_key', report.sessionKeys],
      ['account', report.accounts],
      ['subscription', report.subscriptions],
      ['story', report.stories],
    ];
    for (const [kind, count] of perStep) {
      if (count > 0) incCounter(SWEEPER_DELETED, { kind }, count);
    }

    if (report.errors.length > 0) {
      // Kegagalan sebagian tetap dilaporkan sebagai error supaya alert sweeper
      // menyala (lag sweeper yang tak terukur = jalur tercepat ke disk penuh).
      result = 'error';
      console.error('[Cron] Pembersihan selesai dengan kegagalan sebagian:', report.errors.join(' | '));
    }
    return { result };
  } catch (error) {
    result = 'error';
    console.error('[Cron] Gagal melakukan pembersihan database:', error);
    return { result };
  } finally {
    // Dicatat di finally supaya putaran yang GAGAL pun terlihat.
    observeHistogram(SWEEPER_DURATION, (Date.now() - startedAt) / 1000, { result });
    setGauge(SWEEPER_LAST_RUN, nowSeconds(), { result });
  }
}

// Jadwalkan untuk jalan setiap jam 00:00 (server time) tiap hari
export const startSystemSweeper = () => {
  console.log('🧹 System Sweeper Job scheduled (Daily at 00:00)...');

  // [audit F-07] Satu worker saja per hari; `sweepOnce` tetap dipakai jalur
  // manual (`POST /api/admin/cleanup`) yang sengaja TIDAK dikunci.
  cron.schedule('0 0 * * *', () => runWithJobLock('system-sweeper', 3600, async () => {
    console.log('[Cron] Memulai pembersihan database harian...');
    await sweepOnce();
  }));
};
