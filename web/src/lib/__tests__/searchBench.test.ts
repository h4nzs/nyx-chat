// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F §30.10 poin 4] Runner benchmark indeks pencarian.
 *
 * Selalu menjalankan benchmark kecil (500 pesan) sebagai uji integritas +
 * kewajaran harness. Benchmark 10k pesan (gate "pencarian < 100ms") hanya jalan
 * bila `NYX_BENCH=1`, supaya suite normal tetap cepat:
 *
 *   NYX_BENCH=1 pnpm --filter nyx-web run bench:search
 *
 * Angka dicetak apa adanya; ambang gate ada di `SEARCH_BENCH_BUDGET`.
 */
import { describe, expect, it } from 'vitest';

import {
  SEARCH_BENCH_BUDGET,
  formatSearchBenchmark,
  generateSearchFixture,
  runSearchBenchmark,
} from '../searchBench';

const BENCH = process.env.NYX_BENCH === '1';
const MESSAGE_COUNT = BENCH ? 10_000 : 500;

describe('searchBench: fixture', () => {
  it('deterministik dan berukuran sesuai permintaan', () => {
    const a = generateSearchFixture({ messageCount: 50 });
    const b = generateSearchFixture({ messageCount: 50 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(50);
    expect(new Set(a.map((m) => m.conversationId)).size).toBeGreaterThan(1);
  });

  it('memuat terma langka di sebagian kecil pesan saja', () => {
    const messages = generateSearchFixture({ messageCount: 500, rareTerm: 'needle' });
    const withRare = messages.filter((m) => m.text.includes('needle'));
    expect(withRare.length).toBeGreaterThan(0);
    expect(withRare.length).toBeLessThan(messages.length / 10);
  });
});

describe(`searchBench: indeks ${MESSAGE_COUNT} pesan`, () => {
  it('membangun indeks & mencari dalam anggaran gate docs/30 §30.10', () => {
    const result = runSearchBenchmark({ messageCount: MESSAGE_COUNT });
    console.log(formatSearchBenchmark(result));

    // Angka apa adanya sudah dicetak di atas; asersi ini gate-nya.
    expect(result.selectiveCandidates).toBeGreaterThan(0);
    expect(result.coldSearch.ms).toBeLessThan(SEARCH_BENCH_BUDGET.searchMs);
    expect(result.warmSearchMsPerQuery).toBeLessThan(SEARCH_BENCH_BUDGET.searchMs);
    expect(result.build.ms).toBeLessThan(SEARCH_BENCH_BUDGET.buildMs);
  });

  it('kandidat untuk query selektif jauh lebih sedikit daripada seluruh pesan', () => {
    const result = runSearchBenchmark({ messageCount: MESSAGE_COUNT });
    expect(result.selectiveCandidates).toBeLessThan(MESSAGE_COUNT / 10);
  });
});
