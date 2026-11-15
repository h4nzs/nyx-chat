// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 §35.11 residual] Pengukuran yang LEBIH DEKAT ke jalur nyata,
 * dipakai halaman `/bench/pq` di perangkat pengguna.
 *
 * Dua biaya yang diukur:
 *
 * 1. **Pipeline worker** — seal/open XChaCha20-Poly1305 lewat crypto worker
 *    yang sama dengan aplikasi (`crypto-worker-proxy`), beberapa permintaan
 *    in-flight sekaligus (default 4). Setiap angka adalah round-trip penuh
 *    `postMessage` → op worker → balasan, jadi termasuk antrean worker; itu
 *    yang benar-benar ditunggu UI saat mengirim/membaca pesan.
 *    Dua ukuran payload:
 *      - 256 B  : isi pesan biasa (kontrol; round-trip worker mendominasi)
 *      - 8152 B : plaintext SETELAH padding traffic-cover 8 KB
 *                 (`8192 - 24 nonce - 16 MAC`, lihat `crypto.worker.ts`
 *                 `PADDING_BLOCK_SIZE`), yaitu ukuran yang dibayar tiap pesan.
 *
 * 2. **IndexedDB** — biaya baris yang sungguh ditulis aplikasi:
 *    `messageKeys` (`{ messageId, key: Uint8Array(32) }`, satu put per pesan
 *    lewat `storeMessageKey`) dan state ratchet (~2 KB, ditimpa tiap langkah
 *    kirim/terima). Ditulis ke database TERPISAH `nyx-device-bench` yang
 *    dihapus lagi di akhir — tidak menyentuh data akun.
 *
 * Batasan yang ditampilkan apa adanya:
 * - Tidak mengukur `kdfChain`/langkah ratchet, serialisasi header, atau
 *   jaringan; yang diukur adalah AEAD + round-trip worker + biaya IndexedDB.
 * - State ratchet di sini adalah buffer sintetis 2 KB, bukan state sesi nyata
 *   (tidak ada sesi/akun yang dibuka di halaman publik ini).
 * - Angka IndexedDB bergantung pada implementasi browser; di perangkat nyata
 *   inilah yang menentukan apakah UI tersendat saat menyimpan.
 */

import Dexie, { type Table } from 'dexie';

import { workerXChaChaOpen, workerXChaChaSeal } from './crypto-worker-proxy';

export const PIPELINE_CONCURRENCY = 4;
/** Isi pesan biasa (byte). */
export const PIPELINE_MESSAGE_BYTES = 256;
/** Plaintext setelah padding traffic-cover 8 KB: 8192 - 24 (nonce) - 16 (MAC). */
export const PIPELINE_COVER_BYTES = 8192 - 24 - 16;

export const IDB_BENCH_DB = 'nyx-device-bench';
export const IDB_RATCHET_STATE_BYTES = 2048;

export interface BenchTiming {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PipelineRun {
  payloadBytes: number;
  /** Panjang envelope base64url (nonce+MAC+ciphertext) yang benar-benar dikirim. */
  ciphertextBytes: number;
  encrypt: BenchTiming;
  decrypt: BenchTiming;
}

export interface PipelineBenchResult {
  messages: number;
  concurrency: number;
  runs: PipelineRun[];
  totalMs: number;
  /** Seal+open per detik (semua ukuran payload). */
  operationsPerSecond: number;
}

export interface IndexedDbBenchResult {
  messages: number;
  stateBytes: number;
  write: BenchTiming;
  read: BenchTiming;
  ratchetWrite: BenchTiming;
  delete: BenchTiming;
  totalMs: number;
  /**
   * true = sudah dicek hilang, false = masih ada, null = browser tidak bisa
   * mengecek (`indexedDB.databases()` tidak tersedia). Penghapusan tetap
   * dijalankan apa pun hasilnya.
   */
  deleted: boolean | null;
}

interface BenchMessageKeyRow {
  messageId: string;
  key: Uint8Array;
}

interface BenchRatchetRow {
  conversationId: string;
  state: Uint8Array;
}

type BenchDb = Dexie & {
  messageKeys: Table<BenchMessageKeyRow, string>;
  ratchetSessions: Table<BenchRatchetRow, string>;
};

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarize(samples: number[]): BenchTiming {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
  return {
    meanMs: round3(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)),
    p50Ms: round3(at(0.5)),
    p95Ms: round3(at(0.95)),
  };
}

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

/** base64url tanpa padding — format kunci `xchacha_seal` (lihat worker). */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Plaintext ASCII deterministik dengan panjang byte tepat `bytes`. */
function payloadOfSize(bytes: number, seed: number): string {
  const raw = seededBytes(bytes, seed);
  for (let i = 0; i < raw.length; i += 1) raw[i] = 0x61 + (raw[i]! % 26);
  return new TextDecoder().decode(raw);
}

/**
 * Jalankan `count` tugas dengan paling banyak `concurrency` yang in-flight.
 * Meniru beberapa pesan yang dikirim/dibaca berurutan tanpa menunggu satu per
 * satu (worker tetap satu thread; ini mengukur antrean yang dilihat UI).
 */
async function runPool<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, count));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= count) return;
        results[index] = await task(index);
      }
    })
  );
  return results;
}

export async function runWorkerPipelineBench(
  input: { messages?: number; concurrency?: number } = {}
): Promise<PipelineBenchResult> {
  const messages = Math.max(1, Math.floor(input.messages ?? 12));
  const concurrency = Math.max(
    1,
    Math.min(Math.floor(input.concurrency ?? PIPELINE_CONCURRENCY), messages)
  );
  const keyB64 = toBase64Url(seededBytes(32, 0x5bd1e995));
  const sizes = [PIPELINE_MESSAGE_BYTES, PIPELINE_COVER_BYTES];
  const startedAt = nowMs();
  const runs: PipelineRun[] = [];

  for (const payloadBytes of sizes) {
    const plaintext = payloadOfSize(payloadBytes, 0x27d4eb2f ^ payloadBytes);
    const encryptTimes: number[] = [];
    const sealed = await runPool(messages, concurrency, async () => {
      const started = nowMs();
      const envelope = await workerXChaChaSeal(keyB64, plaintext);
      encryptTimes.push(nowMs() - started);
      return envelope;
    });

    const decryptTimes: number[] = [];
    await runPool(messages, concurrency, async (index) => {
      const envelope = sealed[index]!;
      const started = nowMs();
      const opened = await workerXChaChaOpen(keyB64, envelope);
      decryptTimes.push(nowMs() - started);
      if (opened !== plaintext) {
        throw new Error('pipeline bench: plaintext hasil dekripsi tidak cocok');
      }
    });

    runs.push({
      payloadBytes,
      ciphertextBytes: sealed[0]!.length,
      encrypt: summarize(encryptTimes),
      decrypt: summarize(decryptTimes),
    });
  }

  const totalMs = nowMs() - startedAt;
  return {
    messages,
    concurrency,
    runs,
    totalMs: round3(totalMs),
    operationsPerSecond: round3((messages * sizes.length * 2) / Math.max(totalMs / 1000, 0.001)),
  };
}

function openBenchDb(): BenchDb {
  const db = new Dexie(IDB_BENCH_DB) as BenchDb;
  db.version(1).stores({
    messageKeys: 'messageId',
    ratchetSessions: 'conversationId',
  });
  return db;
}

async function benchDbExists(): Promise<boolean | null> {
  if (typeof indexedDB === 'undefined') return null;
  if (typeof indexedDB.databases !== 'function') return null;
  return (await indexedDB.databases()).some((entry) => entry.name === IDB_BENCH_DB);
}

export async function runIndexedDbBench(
  input: { messages?: number } = {}
): Promise<IndexedDbBenchResult> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB tidak tersedia di browser ini');
  }
  const messages = Math.max(1, Math.floor(input.messages ?? 12));
  const key = seededBytes(32, 0xc2b2ae35);
  const state = seededBytes(IDB_RATCHET_STATE_BYTES, 0x165667b1);
  const db = openBenchDb();
  const startedAt = nowMs();
  let measured: Omit<IndexedDbBenchResult, 'deleted'> | null = null;

  try {
    // Bentuk baris disalin dari penulisnya: `storeMessageKey` menulis
    // { messageId, key } satu baris per pesan (keychainDb.ts).
    const writeTimes: number[] = [];
    for (let i = 0; i < messages; i += 1) {
      const started = nowMs();
      await db.messageKeys.put({ messageId: `bench-${i}`, key });
      writeTimes.push(nowMs() - started);
    }

    // `getMessageKey` membaca satu baris per pesan.
    const readTimes: number[] = [];
    for (let i = 0; i < messages; i += 1) {
      const started = nowMs();
      const row = await db.messageKeys.get(`bench-${i}`);
      readTimes.push(nowMs() - started);
      if (!row) throw new Error('indexeddb bench: baris yang baru ditulis tidak terbaca');
    }

    // State ratchet ditimpa pada kunci yang sama tiap langkah ratchet, jadi
    // yang diukur adalah biaya update 2 KB — bukan insert baris baru.
    const ratchetTimes: number[] = [];
    for (let i = 0; i < messages; i += 1) {
      const nextState = state.slice();
      nextState[0] = i & 0xff;
      const started = nowMs();
      await db.ratchetSessions.put({ conversationId: 'bench', state: nextState });
      ratchetTimes.push(nowMs() - started);
    }

    const deleteTimes: number[] = [];
    for (let i = 0; i < messages; i += 1) {
      const started = nowMs();
      await db.messageKeys.delete(`bench-${i}`);
      deleteTimes.push(nowMs() - started);
    }

    measured = {
      messages,
      stateBytes: state.length,
      write: summarize(writeTimes),
      read: summarize(readTimes),
      ratchetWrite: summarize(ratchetTimes),
      delete: summarize(deleteTimes),
      totalMs: round3(nowMs() - startedAt),
    };
  } finally {
    db.close();
    await Dexie.delete(IDB_BENCH_DB);
  }

  if (!measured) throw new Error('indexeddb bench: pengukuran tidak selesai');
  const stillExists = await benchDbExists();
  return { ...measured, deleted: stillExists === null ? null : !stillExists };
}

/** Runner lengkap untuk halaman: pipeline worker lalu IndexedDB. */
export async function runRealPathBench(input: { messages?: number } = {}): Promise<{
  pipeline: PipelineBenchResult;
  indexedDb: IndexedDbBenchResult;
}> {
  const messages = Math.max(1, Math.floor(input.messages ?? 12));
  const pipeline = await runWorkerPipelineBench({ messages });
  const indexedDb = await runIndexedDbBench({ messages });
  return { pipeline, indexedDb };
}
