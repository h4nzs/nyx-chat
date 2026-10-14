// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D gate (5)] Runner benchmark ratchet SPQR.
 *
 * Selalu menjalankan benchmark kecil (40 langkah) sebagai uji integritas harness;
 * benchmark 500 langkah hanya jalan bila `NYX_BENCH=1`:
 *
 *   NYX_BENCH=1 pnpm --filter nyx-web run bench:spqr
 *
 * Angka dicetak apa adanya; ambang gate ada di `SPQR_BENCH_BUDGET`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { instantiateSpqrRatchet } from '../spqrRatchet';
import { SPQR_BENCH_BUDGET, formatSpqrBenchmark, runSpqrBenchmark } from '../spqrBench';

const WASM_PATH = resolve(process.cwd(), '../packages/spqr-wasm/dist/spqr.wasm');
const HAS_WASM = existsSync(WASM_PATH);
const BENCH = process.env.NYX_BENCH === '1';
const STEPS = BENCH ? 500 : 40;

const instantiate = (bytes: Uint8Array<ArrayBuffer>, randomBytes: (length: number) => Uint8Array) =>
  instantiateSpqrRatchet(bytes, { randomBytes });

const withSkip = HAS_WASM ? describe : describe.skip;

withSkip(`spqr bench: ${STEPS} langkah/arah`, () => {
  const wasmBytes = HAS_WASM ? new Uint8Array(readFileSync(WASM_PATH)) : new Uint8Array();

  it('mengukur ukuran pesan & CPU per langkah ratchet', () => {
    const result = runSpqrBenchmark({ wasmBytes, instantiate, steps: STEPS });
    console.log(formatSpqrBenchmark(result));

    // Gate docs/30 §30.8 (5): angka dilaporkan di atas; asersi ini penjaga wajar
    // supaya regresi ukuran/CPU terlihat sebagai test yang gagal, bukan cuma log.
    expect(result.steadyMessage.msgBytes).toBeGreaterThan(0);
    expect(result.steadyMessage.keyBytes).toBe(32);
    // State ratchet harus tetap kecil: ia disimpan di keychain & ikut dibackup.
    expect(result.steadyMessage.stateBytes).toBeLessThan(64 * 1024);
    expect(result.send.p95Ms).toBeLessThan(SPQR_BENCH_BUDGET.sendMsPerStep);
    expect(result.recv.p95Ms).toBeLessThan(SPQR_BENCH_BUDGET.recvMsPerStep);
  });

  it('dua arah tetap sepakat selama benchmark (bukan cuma mengukur waktu)', () => {
    // Harness sudah melempar bila panjang key tidak cocok; test ini memastikan
    // jalur itu benar-benar dieksekusi (bukan bench yang dilewati).
    const result = runSpqrBenchmark({ wasmBytes, instantiate, steps: 5 });
    expect(result.steps).toBe(5);
    expect(result.bytesPerStep.msg).toBeGreaterThan(0);
  });
});
