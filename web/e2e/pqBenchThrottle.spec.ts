// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/35 Fase 8 residual] Proxy perangkat rendah untuk benchmark PQ.
//
// `bench:pq` mengukur di CPU desktop apa adanya. Pengguna low-end tidak bisa
// dihadirkan di CI, tetapi Chrome DevTools Protocol bisa memperlambat CPU main
// thread secara deterministik (`Emulation.setCPUThrottlingRate`). ML-DSA (noble,
// JS) dan X-Wing (libsodium WASM) keduanya berjalan di main thread di harness
// ini, jadi throttle 4x/6x adalah pendekatan yang jujur untuk "HP kelas bawah"
// — bukan pengganti pengukuran baterai/perangkat nyata.
//
// Opt-in (tidak jalan di suite biasa):
//   pnpm --filter nyx-web run bench:pq:throttle
//
// Angka dicetak apa adanya; anggaran desktop (`PQ_BENCH_BUDGET`) TIDAK dipakai
// sebagai gate karena memang bukan target perangkat rendah.
import { test, expect } from '@playwright/test';

const RATES = [1, 4, 6];
const ITERATIONS = 5;

test.describe('PQ bench — CPU throttling', () => {
  test.setTimeout(300_000);

  test('ML-DSA-65 + X-Wing di 1x/4x/6x CPU', async ({ page, context }) => {
    test.skip(
      process.env.NYX_PQ_THROTTLE !== '1',
      'opt-in: jalankan pnpm --filter nyx-web run bench:pq:throttle'
    );

    await page.goto('/');
    const cdp = await context.newCDPSession(page);

    for (const rate of RATES) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const result = await page.evaluate(async (iterations) => {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const { runPqBenchmark, formatPqBenchmark } = await import('/src/lib/pqBench.ts');
        const bench = await runPqBenchmark({ iterations });
        return {
          text: formatPqBenchmark(bench),
          sizes: bench.sizes,
          p95: {
            keygen: bench.mlDsa.keygen.p95Ms,
            sign: bench.mlDsa.sign.p95Ms,
            verify: bench.mlDsa.verify.p95Ms,
            xwingEncaps: bench.xwing.encaps.p95Ms,
          },
        };
      }, ITERATIONS);

      console.log(`[pq-bench ${rate}x]\n${result.text}`);
      // Ukuran output tidak boleh berubah karena throttle — kalau berubah,
      // yang diukur bukan primitif yang sama.
      expect(result.sizes.mlDsa).toEqual({ publicKey: 1952, secretKey: 4032, signature: 3309 });
      expect(result.sizes.xwing).toEqual({ publicKey: 1216, ciphertext: 1120, sharedSecret: 32 });
      // Batas kewarasan: throttle 6x pada mesin ini tetap jauh di bawah 5 dtk.
      // Ambang ini menangkap hang/regresi, bukan menjadi anggaran produk.
      for (const value of Object.values(result.p95)) {
        expect(value).toBeLessThan(5000);
      }
    }

    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
