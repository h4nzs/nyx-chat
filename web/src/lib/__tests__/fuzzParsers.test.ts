// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G(5)] Runner fuzz parser. Default-nya pendek (muat di CI/dev);
 * perpanjang lewat env tanpa mengubah kode:
 *
 *   NYX_FUZZ_ITERS=200000  npx vitest run src/lib/__tests__/fuzzParsers.test.ts
 *   NYX_FUZZ_SECONDS=3600  npx vitest run src/lib/__tests__/fuzzParsers.test.ts   # gate ≥1 jam
 *
 * (nya juga lewat `pnpm --filter nyx-web run fuzz:parsers` / `fuzz:parsers:nightly`.)
 *
 * Test ini gagal bila ada satu temuan, dan mencetak angka terukur
 * (iterasi/detik) supaya klaim "fuzz jalan" bisa diverifikasi, bukan diasumsikan.
 */

import { describe, expect, it } from 'vitest';

import { formatFuzzReport, runParserFuzz, type FuzzTarget } from '../fuzzParsers';

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

const ITERATIONS = envInt('NYX_FUZZ_ITERS') ?? 3000;
const SECONDS = envInt('NYX_FUZZ_SECONDS') ?? 0;

describe('fuzz parser input tak terpercaya (WS-G(5))', () => {
  it('tidak menemukan crash pada kampanye pendek', () => {
    const report = runParserFuzz({ iterations: ITERATIONS, seconds: SECONDS });
    console.log(formatFuzzReport(report));
    expect(report.totalCrashes, formatFuzzReport(report)).toBe(0);
    expect(report.targets.length).toBeGreaterThanOrEqual(5);
    for (const target of report.targets) {
      expect(target.iterations, `${target.name} harus benar-benar dijalankan`).toBeGreaterThan(0);
    }
  }, 900_000);

  it('deterministik: seed sama → hasil identik (temuan bisa direproduksi)', () => {
    const first = runParserFuzz({ seed: 0x1234abcd, iterations: 300 });
    const second = runParserFuzz({ seed: 0x1234abcd, iterations: 300 });
    expect(second.totalCrashes).toBe(first.totalCrashes);
    expect(second.targets.map((t) => t.iterations)).toEqual(first.targets.map((t) => t.iterations));
  });

  it('self-test: target yang sengaja rusak MEMANG dilaporkan sebagai temuan', () => {
    // Tanpa ini, harness yang tidak pernah menyala akan terlihat "lulus".
    const broken: FuzzTarget = {
      name: 'broken-target',
      run: () => {
        throw new TypeError('bug yang disengaja');
      },
    };
    const report = runParserFuzz({ iterations: 50 }, [broken]);
    expect(report.totalCrashes).toBe(1);
    const crash = report.targets[0]!.crashes[0]!;
    expect(crash.errorName).toBe('TypeError');
    expect(crash.errorMessage).toBe('bug yang disengaja');
    // Laporan repro harus lengkap: seed + iterasi + input (hex & panjang).
    expect(typeof crash.inputHex).toBe('string');
    expect(Number.isInteger(crash.inputLength)).toBe(true);
    expect(crash.inputLength).toBeGreaterThanOrEqual(0);
    expect(crash.iteration).toBe(0);
    expect(Number.isInteger(crash.seed)).toBe(true);
  });

  it('seed berbeda tetap tidak menemukan crash (bukan kebetulan satu jalur)', () => {
    for (const seed of [1, 0xdeadbeef, 0x7fffffff]) {
      const report = runParserFuzz({ seed, iterations: 400 });
      expect(report.totalCrashes, `seed 0x${seed.toString(16)}: ${formatFuzzReport(report)}`).toBe(0);
    }
  });
});
