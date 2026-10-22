// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 8] Benchmark primitif PQ yang dipakai jalur aplikasi:
 * ML-DSA-65 (tanda tangan) dan X-Wing (KEM).
 *
 * Yang diukur adalah biaya dari sisi JS apa adanya — termasuk ekspansi FIPS 204
 * di noble dan panggilan libsodium WASM — karena itulah yang dibayar worker.
 * Fixture entropi deterministik (xorshift32, tanpa `Math.random`) supaya dua
 * eksekusi bisa dibandingkan. Angka dicetak apa adanya; ambang gate ada di
 * `PQ_BENCH_BUDGET`.
 *
 * **Batasannya jujur:** ini bukan benchmark worker penuh (tidak mengukur
 * serialisasi pesan/IndexedDB) dan bukan benchmark baterai perangkat rendah.
 * Ukuran pesan dilaporkan dari panjang output nyata primitif.
 */

import {
  mlDsaKeygen,
  mlDsaSign,
  mlDsaVerify,
  PQ_V2_DOMAINS,
} from '@nyx/shared';
import { getSodium } from './sodiumInitializer';

export interface PqTiming {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PqBenchResult {
  iterations: number;
  mlDsa: {
    keygen: PqTiming;
    sign: PqTiming;
    verify: PqTiming;
  };
  xwing: {
    keypair: PqTiming;
    encaps: PqTiming;
    decaps: PqTiming;
  };
  sizes: {
    mlDsa: { publicKey: number; secretKey: number; signature: number };
    xwing: { publicKey: number; ciphertext: number; sharedSecret: number };
  };
}

export const PQ_BENCH_BUDGET = {
  mlDsaKeygenP95Ms: 100,
  mlDsaSignP95Ms: 100,
  mlDsaVerifyP95Ms: 50,
  xwingKeypairP95Ms: 50,
  xwingEncapsP95Ms: 50,
  xwingDecapsP95Ms: 50,
} as const;

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

function seededBytes(length: number, seed: number): Uint8Array {
  let state = seed >>> 0 || 0x9e3779b9;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarize(samples: number[]): PqTiming {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
  return {
    meanMs: round3(samples.reduce((a, b) => a + b, 0) / samples.length),
    p50Ms: round3(at(0.5)),
    p95Ms: round3(at(0.95)),
  };
}

function measure(iterations: number, operation: () => void): PqTiming {
  operation();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const startedAt = nowMs();
    operation();
    samples.push(nowMs() - startedAt);
  }
  return summarize(samples);
}

export async function runPqBenchmark(input: { iterations?: number } = {}): Promise<PqBenchResult> {
  const iterations = Math.max(1, Math.floor(input.iterations ?? 5));
  const sodium = await getSodium();
  const message = new TextEncoder().encode('nyx pq benchmark message');
  const mlDsaSeed = seededBytes(32, 0x51ed270b);
  const xwingSeed = seededBytes(32, 0x1b873593);
  const xwingEseed = seededBytes(64, 0x85ebca6b);

  const mlDsaKp = mlDsaKeygen(mlDsaSeed);
  const signature = mlDsaSign(message, mlDsaKp.secretKey, PQ_V2_DOMAINS.GROUP);
  const xwingKp = sodium.crypto_kem_xwing_seed_keypair(xwingSeed);
  const encapsulated = sodium.crypto_kem_xwing_enc_deterministic(xwingKp.publicKey, xwingEseed);

  const mlDsa = {
    keygen: measure(iterations, () => {
      mlDsaKeygen(mlDsaSeed);
    }),
    sign: measure(iterations, () => {
      mlDsaSign(message, mlDsaKp.secretKey, PQ_V2_DOMAINS.GROUP);
    }),
    verify: measure(iterations, () => {
      if (!mlDsaVerify(signature, message, mlDsaKp.publicKey, PQ_V2_DOMAINS.GROUP)) {
        throw new Error('pq bench: verifikasi ML-DSA gagal');
      }
    }),
  };

  const xwing = {
    keypair: measure(iterations, () => {
      sodium.crypto_kem_xwing_seed_keypair(xwingSeed);
    }),
    encaps: measure(iterations, () => {
      sodium.crypto_kem_xwing_enc_deterministic(xwingKp.publicKey, xwingEseed);
    }),
    decaps: measure(iterations, () => {
      const shared = sodium.crypto_kem_xwing_dec(encapsulated.ciphertext, xwingKp.privateKey);
      if (sodium.to_hex(shared) !== sodium.to_hex(encapsulated.sharedSecret)) {
        throw new Error('pq bench: shared secret X-Wing tidak cocok');
      }
    }),
  };

  return {
    iterations,
    mlDsa,
    xwing,
    sizes: {
      mlDsa: {
        publicKey: mlDsaKp.publicKey.length,
        secretKey: mlDsaKp.secretKey.length,
        signature: signature.length,
      },
      xwing: {
        publicKey: xwingKp.publicKey.length,
        ciphertext: encapsulated.ciphertext.length,
        sharedSecret: encapsulated.sharedSecret.length,
      },
    },
  };
}

export function formatPqBenchmark(result: PqBenchResult): string {
  const t = (label: string, timing: PqTiming) =>
    `${label} mean=${timing.meanMs.toFixed(2)}ms p50=${timing.p50Ms.toFixed(2)}ms p95=${timing.p95Ms.toFixed(2)}ms`;
  return [
    `PQ bench: ${result.iterations} iterasi`,
    t('ML-DSA-65 keygen', result.mlDsa.keygen),
    t('ML-DSA-65 sign  ', result.mlDsa.sign),
    t('ML-DSA-65 verify', result.mlDsa.verify),
    t('X-Wing keypair   ', result.xwing.keypair),
    t('X-Wing encaps    ', result.xwing.encaps),
    t('X-Wing decaps    ', result.xwing.decaps),
    `Ukuran ML-DSA-65: pk=${result.sizes.mlDsa.publicKey} sk=${result.sizes.mlDsa.secretKey} sig=${result.sizes.mlDsa.signature} byte`,
    `Ukuran X-Wing: pk=${result.sizes.xwing.publicKey} ct=${result.sizes.xwing.ciphertext} ss=${result.sizes.xwing.sharedSecret} byte`,
  ].join('\n');
}
