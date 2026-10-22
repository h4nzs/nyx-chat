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

describe(`pq bench: ${ITERATIONS} iterasi`, () => {
  it('mengukur ML-DSA-65 dan X-Wing beserta ukuran output', async () => {
    const result = await runPqBenchmark({ iterations: ITERATIONS });
    console.log(formatPqBenchmark(result));

    expect(result.iterations).toBe(ITERATIONS);
    expect(result.sizes.mlDsa).toEqual({ publicKey: 1952, secretKey: 4032, signature: 3309 });
    expect(result.sizes.xwing).toEqual({ publicKey: 1216, ciphertext: 1120, sharedSecret: 32 });

    expect(result.mlDsa.keygen.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.mlDsaKeygenP95Ms);
    expect(result.mlDsa.sign.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.mlDsaSignP95Ms);
    expect(result.mlDsa.verify.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.mlDsaVerifyP95Ms);
    expect(result.xwing.keypair.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.xwingKeypairP95Ms);
    expect(result.xwing.encaps.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.xwingEncapsP95Ms);
    expect(result.xwing.decaps.p95Ms).toBeLessThan(PQ_BENCH_BUDGET.xwingDecapsP95Ms);
  });
});
