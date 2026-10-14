// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.8 WS-D gate (5)] Harness benchmark ratchet SPQR: **ukuran pesan
 * dan CPU per langkah ratchet** harus diukur dan dicatat, bukan diasumsikan.
 *
 * Yang diukur adalah lapisan ABI (`packages/spqr-wasm/dist/spqr.wasm`) apa
 * adanya: `send` = satu langkah ratchet penuh (ML-KEM Braid + chain simetris),
 * `recv` = membuka satu pesan peer. Modul WASM-nya sendiri yang mengalokasikan
 * memori Rust-nya; di sini kita mengukur biaya dari sisi JS (termasuk salinan
 * scratch buffer), karena itulah yang dibayar aplikasi.
 *
 * **Batasannya jujur:** ini bukan benchmark enkripsi XChaCha (itu di
 * `backupBench`) dan bukan benchmark transport. Fixture entropi deterministik
 * (xorshift32, tanpa `Math.random`) supaya dua eksekusi bisa dibandingkan.
 */

import type { SpqrRatchet } from './spqrRatchet';

export interface SpqrStepTiming {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface SpqrBenchResult {
  wasmBytes: number;
  steps: number;
  /** Pesan pertama (masih negosiasi versi). */
  firstMessage: { msgBytes: number; stateBytes: number };
  /** Pesan mapan (setelah negosiasi selesai). */
  steadyMessage: { msgBytes: number; stateBytes: number; keyBytes: number };
  send: SpqrStepTiming;
  recv: SpqrStepTiming;
  /** Rata-rata byte per langkah (pesan + state yang harus disimpan). */
  bytesPerStep: { msg: number; state: number };
  /** Puncak heap selama pengukuran (informasi, bukan gate). */
  peakHeapBytes: number;
}

/** Ambang longgar untuk mesin dev (VPS 4c lebih lambat; angka sebenarnya dicetak). */
export const SPQR_BENCH_BUDGET = {
  sendMsPerStep: 25,
  recvMsPerStep: 25,
} as const;

/** PRNG deterministik (xorshift32) — sama semangatnya dengan fixture bench lain. */
export function seededRandomBytes(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0 || 0x12345678;
  return (length: number) =>
    Uint8Array.from({ length }, () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state & 0xff;
    });
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function peakHeap(): number {
  const memoryUsage = (globalThis as {
    process?: { memoryUsage?: () => { heapUsed: number } };
  }).process?.memoryUsage;
  return memoryUsage ? memoryUsage().heapUsed : 0;
}

function summarize(samples: number[]): SpqrStepTiming {
  if (samples.length === 0) return { meanMs: 0, p50Ms: 0, p95Ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const at = (fraction: number) => {
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[index] ?? 0;
  };
  return { meanMs: mean, p50Ms: at(0.5), p95Ms: at(0.95) };
}

export interface SpqrBenchOptions {
  /** Isi `packages/spqr-wasm/dist/spqr.wasm`. */
  wasmBytes: Uint8Array<ArrayBuffer>;
  /**
   * Pabrik instance (disuntik supaya harness tidak menyentuh `WebAssembly`
   * global secara implisit dan tetap bisa dipakai dari test mana pun).
   */
  instantiate: (bytes: Uint8Array<ArrayBuffer>, randomBytes: (length: number) => Uint8Array) => SpqrRatchet;
  /** Jumlah langkah ratchet per arah. Default 200. */
  steps?: number;
  authKey?: Uint8Array;
}

/**
 * Menjalankan dua instance (Alice/Bob) yang bertukar pesan `steps` kali ke arah
 * Alice→Bob dan `steps` kali Bob→Alice, sambil mencatat waktu tiap operasi.
 */
export function runSpqrBenchmark(options: SpqrBenchOptions): SpqrBenchResult {
  const { wasmBytes, instantiate, steps = 200 } = options;
  const authKey = options.authKey ?? new Uint8Array(32).fill(0x7c);

  const alice = instantiate(wasmBytes, seededRandomBytes(0xa11ce));
  const bob = instantiate(wasmBytes, seededRandomBytes(0xb0b));

  let aliceState = alice.initialState({ authKey, direction: 'A2B' });
  let bobState = bob.initialState({ authKey, direction: 'B2A' });

  const first = alice.send(aliceState);
  aliceState = first.state;
  const firstRecv = bob.recv(bobState, first.msg);
  bobState = firstRecv.state;

  const steadyProbe = alice.send(aliceState);
  const steadyMessage = {
    msgBytes: steadyProbe.msg.length,
    stateBytes: steadyProbe.state.length,
    keyBytes: steadyProbe.key?.length ?? 0,
  };
  aliceState = steadyProbe.state;

  let peakHeapBytes = peakHeap();
  const sendSamples: number[] = [];
  const recvSamples: number[] = [];
  let msgBytes = 0;
  let stateBytes = 0;

  // Satu arah per iterasi: Alice→Bob lalu Bob→Alice, jadi kedua sisi terukur.
  for (let i = 0; i < steps; i++) {
    const sendStart = nowMs();
    const sent = alice.send(aliceState);
    sendSamples.push(nowMs() - sendStart);
    aliceState = sent.state;

    const recvStart = nowMs();
    const received = bob.recv(bobState, sent.msg);
    recvSamples.push(nowMs() - recvStart);
    bobState = received.state;

    if (sent.key && received.key && sent.key.length !== received.key.length) {
      throw new Error(`spqr bench: panjang key tidak cocok pada langkah ${i}`);
    }
    // Yang benar-benar dibayar aplikasi: pesan di wire + state yang disimpan.
    msgBytes += sent.msg.length;
    stateBytes += sent.state.length;
    peakHeapBytes = Math.max(peakHeapBytes, peakHeap());
  }

  return {
    wasmBytes: wasmBytes.length,
    steps,
    firstMessage: { msgBytes: first.msg.length, stateBytes: first.state.length },
    steadyMessage,
    send: summarize(sendSamples),
    recv: summarize(recvSamples),
    bytesPerStep: {
      msg: msgBytes / Math.max(1, steps),
      state: stateBytes / Math.max(1, steps),
    },
    peakHeapBytes,
  };
}

/** Laporan yang bisa ditempel apa adanya ke `docs/30`/`docs/33`. */
export function formatSpqrBenchmark(result: SpqrBenchResult): string {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
  const ms = (value: number) => `${value.toFixed(3)} ms`;
  return [
    '',
    `SPQR benchmark — ${result.steps} langkah/arah, modul WASM ${kb(result.wasmBytes)}`,
    `  pesan pertama   : msg ${result.firstMessage.msgBytes} B, state ${kb(result.firstMessage.stateBytes)}`,
    `  pesan mapan     : msg ${result.steadyMessage.msgBytes} B, state ${kb(result.steadyMessage.stateBytes)}, key ${result.steadyMessage.keyBytes} B`,
    `  send            : p50 ${ms(result.send.p50Ms)}, p95 ${ms(result.send.p95Ms)}, mean ${ms(result.send.meanMs)}`,
    `  recv            : p50 ${ms(result.recv.p50Ms)}, p95 ${ms(result.recv.p95Ms)}, mean ${ms(result.recv.meanMs)}`,
    `  byte per langkah: msg (wire) ${result.bytesPerStep.msg.toFixed(1)} B, state ${kb(result.bytesPerStep.state)}`,
    `  puncak heap     : ${(result.peakHeapBytes / (1024 * 1024)).toFixed(1)} MiB`,
    '',
  ].join('\n');
}
