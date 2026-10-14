// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-C fase 5 / docs/31 §31.6d] Runner harness benchmark backup.
 *
 * Selalu menjalankan benchmark kecil (200 pesan) sebagai uji integritas +
 * kewarasan harness. Benchmark 10k pesan hanya jalan bila `NYX_BENCH=1`, supaya
 * suite normal tetap cepat:
 *
 *   NYX_BENCH=1 pnpm --filter nyx-web run bench:backup
 *
 * Angka (waktu + puncak heap/rss) dicetak apa adanya; ambang gate ada di
 * `BACKUP_BENCH_BUDGET`. I/O IndexedDB tidak diukur di sini — lihat
 * `docs/31` §31.6d.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';

import {
  BACKUP_BENCH_BUDGET,
  formatBackupBenchmark,
  generateBackupFixture,
  runBackupBenchmark,
  type BenchSodium,
} from '../backupBench';

const BENCH = process.env.NYX_BENCH === '1';
const MESSAGE_COUNT = BENCH ? 10_000 : 200;

beforeAll(async () => {
  await sodium.ready;
});

describe('backupBench: fixture', () => {
  it('deterministik dan berukuran sesuai permintaan', () => {
    const a = generateBackupFixture({ messageCount: 5 });
    const b = generateBackupFixture({ messageCount: 5 });

    expect(JSON.stringify(a.messages)).toEqual(JSON.stringify(b.messages));
    expect(a.messages!).toHaveLength(5);
    expect(a.messageKeys!).toHaveLength(5);
    expect(a.contacts!).toHaveLength(5);
    expect(a.conversations!).toHaveLength(20);
    // Nilai biner tetap typed array (bukan objek berkunci angka).
    const firstKey = a.messageKeys![0] as { key: Uint8Array };
    expect(ArrayBuffer.isView(firstKey.key)).toBe(true);
    expect(firstKey.key).toHaveLength(32);
  });
});

describe('backupBench: laporan', () => {
  it('formatBackupBenchmark memuat jumlah pesan, ukuran arsip, dan integritas', () => {
    const text = formatBackupBenchmark({
      messageCount: 10_000,
      totalRecords: 20_000,
      archiveBytes: 4 * 1024 * 1024,
      frameCount: 40,
      export: { ms: 1234, peakHeapBytes: 8 * 1024 * 1024, peakRssBytes: 64 * 1024 * 1024 },
      restore: { ms: 2345, peakHeapBytes: 9 * 1024 * 1024, peakRssBytes: 65 * 1024 * 1024 },
      integrity: { restoredRecords: 20_000, matches: true },
    });

    expect(text).toContain('10,000 pesan');
    expect(text).toContain('20,000 catatan');
    expect(text).toContain('4.00 MB');
    expect(text).toContain('OK');
  });
});

describe('backupBench: export/import', () => {
  it(`roundtrip ${MESSAGE_COUNT} pesan (waktu + puncak memori)`, async () => {
    const result = await runBackupBenchmark({
      messageCount: MESSAGE_COUNT,
      sodium: sodium as unknown as BenchSodium,
      chunkBytes: 64 * 1024,
    });

    // Selalu cetak supaya angka terlihat di output CI/lokal.
    console.log('\n' + formatBackupBenchmark(result));

    // Integritas dulu: benchmark cepat tapi kehilangan data tidak bermakna.
    expect(result.integrity.matches).toBe(true);
    expect(result.integrity.restoredRecords).toBe(result.totalRecords);
    expect(result.archiveBytes).toBeGreaterThan(0);
    expect(result.frameCount).toBeGreaterThan(0);

    // Gate (longgar; mesin CI/VPS bisa berbeda — angka sebenarnya di atas).
    expect(result.export.ms).toBeLessThanOrEqual(BACKUP_BENCH_BUDGET.exportMs);
    expect(result.restore.ms).toBeLessThanOrEqual(BACKUP_BENCH_BUDGET.restoreMs);
    expect(result.archiveBytes).toBeLessThanOrEqual(BACKUP_BENCH_BUDGET.archiveBytes);
  }, BENCH ? 600_000 : 60_000);
});
