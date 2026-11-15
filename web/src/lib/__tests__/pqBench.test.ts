// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 8] Runner benchmark ML-DSA-65 + X-Wing.
 *
 * Selalu menjalankan 3 iterasi sebagai uji integritas harness; 20 iterasi hanya
 * jalan bila `NYX_BENCH=1`:
 *
 *   NYX_BENCH=1 pnpm --filter nyx-web run bench:pq
 *
 * Angka dicetak apa adanya; ambang gate ada di `PQ_BENCH_BUDGET`.
 */
import { describe, expect, it } from 'vitest';

import { PQ_BENCH_BUDGET, formatPqBenchmark, runPqBenchmark } from '../pqBench';

const ITERATIONS = process.env.NYX_BENCH === '1' ? 20 : 3;
/**
 * Budget p95 hanya ditegakkan di jalur bench eksplisit (`NYX_BENCH=1`, dipakai
 * `pnpm bench:pq` dan nightly). Di suite unit yang berjalan paralel, angka p95
 * mengukur kontensi CPU mesin, bukan ML-DSA: pada mesin 4 core terukur
 * 174–208 ms terhadap budget 100 ms tanpa ada perubahan kriptografi sama sekali,
 * sementara run yang sama sendirian lulus. Asersi bentuk/ukuran tetap berjalan
 * di kedua mode, jadi harness yang rusak tetap tertangkap.
 */
const ENFORCE_BUDGET = process.env.NYX_BENCH === '1';

describe(`pq bench: ${ITERATIONS} iterasi`, () => {
  it('mengukur ML-DSA-65 dan X-Wing beserta ukuran output', async () => {
    const result = await runPqBenchmark({ iterations: ITERATIONS });
    console.log(formatPqBenchmark(result));

    expect(result.iterations).toBe(ITERATIONS);
    expect(result.sizes.mlDsa).toEqual({ publicKey: 1952, secretKey: 4032, signature: 3309 });
    expect(result.sizes.xwing).toEqual({ publicKey: 1216, ciphertext: 1120, sharedSecret: 32 });

    if (ENFORCE_BUDGET) {
      expect(result.mlDsa.keygen.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.mlDsaKeygenP95Ms);
      expect(result.mlDsa.sign.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.mlDsaSignP95Ms);
      expect(result.mlDsa.verify.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.mlDsaVerifyP95Ms);
      expect(result.xwing.keypair.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.xwingKeypairP95Ms);
      expect(result.xwing.encaps.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.xwingEncapsP95Ms);
      expect(result.xwing.decaps.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.xwingDecapsP95Ms);
    }
    // Default 5 detik terlampaui di suite penuh (3 iterasi ML-DSA + X-Wing
    // berbagi CPU dengan 136 berkas tes lain); ini batas waktu, bukan gate.
  }, 120_000);
});
