// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4d] Benchmark PIR end-to-end.
 *
 * Setiap ukuran menjalankan sidecar asli dengan snapshot sintetis, lalu
 * mengukur jalur yang benar-benar dipakai produksi: startup/setup server,
 * ukuran hint/filter, setup klien WASM, query, HTTP respond, dan process.
 * Angka dicetak apa adanya; tidak ada klaim produksi dari hasil lokal.
 *
 *   pnpm --filter nyx-server run bench:pir
 *   PIR_BENCH_SIZES=1000,10000,100000 PIR_BENCH_ITERATIONS=5 pnpm --filter nyx-server run bench:pir
 */

import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPirSnapshot, type PirSnapshot } from '../src/pir/snapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SIDECAR_BIN =
  process.env.PIR_BENCH_BIN ??
  path.resolve(__dirname, '../pir-sidecar/target/release/pir-service');
const WASM_PATH = path.resolve(__dirname, '../../packages/pir-wasm/dist/pir-client.wasm');
const MASTER_SECRET = 'nyx-pir-bench-master-secret';
const EPOCH = 1;

interface PirParams {
  epoch: number;
  recordBytes: number;
  entryCount: number;
  suite: string;
  arity: number;
  seed: string;
  hint: string;
  filter: string;
}

interface WasmApi {
  memory: WebAssembly.Memory;
  pir_alloc: (len: number) => number;
  pir_free: (ptr: number, len: number) => void;
  pir_setup: (sp: number, hp: number, hl: number, fp: number, fl: number) => number;
  pir_query: (oprf: number) => number;
  pir_process: (oprf: number, response: number, responseLen: number) => number;
  pir_out_ptr: () => number;
  pir_out_len: () => number;
  pir_error_ptr: () => number;
  pir_error_len: () => number;
  pir_clear: () => void;
}

interface Stats {
  p50: number;
  p95: number;
}

interface BenchRow {
  entries: number;
  recordBytes: number;
  arity: number;
  snapshotMs: number;
  snapshotMb: number;
  startupSeconds: number;
  rssMb: number | null;
  hintMb: number;
  filterKb: number;
  paramsKb: number;
  paramsFetchMs: number;
  wasmSetup: Stats;
  query: Stats;
  respond: Stats;
  process: Stats;
  queryBytes: number;
  responseBytes: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${name} harus bilangan bulat`);
  return Number(raw);
}

function sizes(): number[] {
  const raw = process.env.PIR_BENCH_SIZES ?? '1000,10000';
  const parsed = raw.split(',').map((value) => {
    if (!/^[0-9]+$/.test(value.trim()) || Number(value) <= 0) {
      throw new Error('PIR_BENCH_SIZES harus daftar bilangan bulat positif');
    }
    return Number(value);
  });
  return [...new Set(parsed)];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
  return { p50: round(at(0.5)), p95: round(at(0.95)) };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function makeSources(entries: number, recordBytes: number) {
  const profileBytes = Math.max(8, recordBytes - 512);
  return Array.from({ length: entries }, (_, index) => ({
    id: `bench-${index}`,
    encryptedProfile: 'x'.repeat(profileBytes),
    isVerified: index % 2 === 0,
    hasCompletedOnboarding: true,
    // 8 byte counter + 24 byte tetap = 32 byte unik, hex 64 karakter.
    oprfIndex: index.toString(16).padStart(16, '0') + 'ab'.repeat(24),
    device: null,
  }));
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  getStderr: () => string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`sidecar keluar (exit ${child.exitCode}): ${getStderr()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch {
      // Belum listen; teruskan polling.
    }
    await sleep(50);
  }
  throw new Error(`sidecar tidak siap dalam ${timeoutMs} ms: ${getStderr()}`);
}

async function stopSidecar(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rssMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+([0-9]+)\s+kB$/m.exec(status);
    return match ? round(Number(match[1]) / 1024, 1) : null;
  } catch {
    return null;
  }
}

async function instantiateWasm(module: WebAssembly.Module): Promise<WasmApi> {
  const instance = await WebAssembly.instantiate(module, {});
  const api = instance.exports as unknown as Partial<WasmApi>;
  if (!(api.memory instanceof WebAssembly.Memory)) {
    throw new Error('WASM PIR tidak mengekspor memory');
  }
  if (typeof api.pir_setup !== 'function' || typeof api.pir_query !== 'function') {
    throw new Error('WASM PIR tidak mengekspor ABI yang diharapkan');
  }
  return api as WasmApi;
}

function put(api: WasmApi, bytes: Uint8Array): number {
  const ptr = api.pir_alloc(bytes.length);
  if (ptr === 0) throw new Error(`WASM pir_alloc(${bytes.length}) gagal`);
  new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

function wasmError(api: WasmApi, code: number): Error {
  const ptr = api.pir_error_ptr();
  const len = api.pir_error_len();
  const message = len > 0 ? new TextDecoder().decode(new Uint8Array(api.memory.buffer, ptr, len)) : '';
  return new Error(message || `WASM PIR error ${code}`);
}

function readOut(api: WasmApi): Uint8Array<ArrayBuffer> {
  const ptr = api.pir_out_ptr();
  const len = api.pir_out_len();
  return new Uint8Array(api.memory.buffer, ptr, len).slice();
}

function setupClient(api: WasmApi, seed: Uint8Array, hint: Uint8Array, filter: Uint8Array): void {
  const seedPtr = put(api, seed);
  const hintPtr = put(api, hint);
  const filterPtr = put(api, filter);
  try {
    const code = api.pir_setup(seedPtr, hintPtr, hint.length, filterPtr, filter.length);
    if (code !== 0) throw wasmError(api, code);
  } finally {
    api.pir_free(seedPtr, seed.length);
    api.pir_free(hintPtr, hint.length);
    api.pir_free(filterPtr, filter.length);
  }
}

function clientQuery(api: WasmApi, oprf: Uint8Array): Uint8Array<ArrayBuffer> {
  const ptr = put(api, oprf);
  try {
    const code = api.pir_query(ptr);
    if (code !== 0) throw wasmError(api, code);
    return readOut(api);
  } finally {
    api.pir_free(ptr, oprf.length);
  }
}

function clientProcess(api: WasmApi, oprf: Uint8Array, response: Uint8Array): Uint8Array<ArrayBuffer> {
  const oprfPtr = put(api, oprf);
  const responsePtr = put(api, response);
  try {
    const code = api.pir_process(oprfPtr, responsePtr, response.length);
    if (code !== 0) throw wasmError(api, code);
    return readOut(api);
  } finally {
    api.pir_free(oprfPtr, oprf.length);
    api.pir_free(responsePtr, response.length);
  }
}

async function runSize(
  module: WebAssembly.Module,
  entries: number,
  recordBytes: number,
  arity: number,
  iterations: number,
): Promise<BenchRow> {
  const snapshotStarted = performance.now();
  const snapshot: PirSnapshot = buildPirSnapshot(makeSources(entries, recordBytes), recordBytes, EPOCH);
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const tempDir = await mkdtemp(path.join(tmpdir(), 'nyx-pir-bench-'));
  const snapshotPath = path.join(tempDir, 'snapshot.json');
  await writeFile(snapshotPath, snapshotBytes, { mode: 0o600 });
  const snapshotMs = performance.now() - snapshotStarted;
  const snapshotMb = round(snapshotBytes.length / 1024 / 1024, 2);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = '';
  const child = spawn(SIDECAR_BIN, [], {
    env: {
      ...process.env,
      PIR_BIND: `127.0.0.1:${port}`,
      PIR_MASTER_SECRET: MASTER_SECRET,
      PIR_SNAPSHOT_PATH: snapshotPath,
      PIR_MAX_ENTRIES: String(entries),
      PIR_ARITY: String(arity),
      RUST_LOG: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  const startupAt = performance.now();

  try {
    await waitForHealth(baseUrl, child, () => stderr, envInt('PIR_BENCH_STARTUP_TIMEOUT_MS', 30 * 60_000));
    const startupSeconds = round((performance.now() - startupAt) / 1000, 1);
    const rss = rssMb(child.pid);

    const paramsAt = performance.now();
    const response = await fetch(`${baseUrl}/params`);
    if (!response.ok) throw new Error(`GET /params: ${response.status}`);
    const rawParams = await response.text();
    const params = JSON.parse(rawParams) as PirParams;
    const paramsFetchMs = round(performance.now() - paramsAt, 1);
    if (params.suite !== 'chalametpir-v1') throw new Error(`suite tak dikenal: ${params.suite}`);
    if (params.entryCount !== entries) throw new Error(`entryCount ${params.entryCount} != ${entries}`);
    if (params.recordBytes !== recordBytes) throw new Error(`recordBytes ${params.recordBytes} != ${recordBytes}`);
    if (params.arity !== arity) throw new Error(`arity ${params.arity} != ${arity}`);

    const seed = Buffer.from(params.seed, 'base64url');
    const hint = Buffer.from(params.hint, 'base64url');
    const filter = Buffer.from(params.filter, 'base64url');
    if (seed.length !== 32) throw new Error(`seed ${seed.length} byte, harus 32`);

    const setupApi = await instantiateWasm(module);
    const setupSamples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      setupApi.pir_clear();
      const started = performance.now();
      setupClient(setupApi, seed, hint, filter);
      setupSamples.push(performance.now() - started);
    }
    setupApi.pir_clear();

    const client = await instantiateWasm(module);
    setupClient(client, seed, hint, filter);
    const querySamples: number[] = [];
    const respondSamples: number[] = [];
    const processSamples: number[] = [];
    let queryBytes = 0;
    let responseBytes = 0;

    for (let i = 0; i < iterations; i += 1) {
      const entry = snapshot.entries[i % snapshot.entries.length];
      if (!entry) throw new Error('snapshot entry hilang');
      const oprf = Buffer.from(entry.oprf, 'base64url');
      const expected = Buffer.from(entry.value, 'base64url');

      const queryAt = performance.now();
      const query = clientQuery(client, oprf);
      querySamples.push(performance.now() - queryAt);

      const respondAt = performance.now();
      const res = await fetch(`${baseUrl}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: query,
      });
      const body = new Uint8Array(await res.arrayBuffer());
      respondSamples.push(performance.now() - respondAt);
      if (!res.ok) {
        throw new Error(`POST /query: ${res.status} ${Buffer.from(body).toString('utf8')}`);
      }

      const processAt = performance.now();
      const value = clientProcess(client, oprf, body);
      processSamples.push(performance.now() - processAt);
      if (!Buffer.from(value).equals(expected)) {
        throw new Error(`record PIR tidak cocok untuk index ${i % snapshot.entries.length}`);
      }

      queryBytes ||= query.length;
      responseBytes ||= body.length;
    }
    client.pir_clear();

    return {
      entries,
      recordBytes,
      arity,
      snapshotMs: round(snapshotMs, 1),
      snapshotMb,
      startupSeconds,
      rssMb: rss,
      hintMb: round(hint.length / 1024 / 1024, 2),
      filterKb: round(filter.length / 1024, 1),
      paramsKb: round(Buffer.byteLength(rawParams) / 1024, 1),
      paramsFetchMs,
      wasmSetup: stats(setupSamples),
      query: stats(querySamples),
      respond: stats(respondSamples),
      process: stats(processSamples),
      queryBytes,
      responseBytes,
    };
  } finally {
    await stopSidecar(child);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function pair(value: Stats): string {
  return `${value.p50.toFixed(2)}/${value.p95.toFixed(2)}`;
}

function printTables(rows: BenchRow[]): void {
  console.log(
    '| N | record B | arity | snapshot ms | snapshot MB | startup s | RSS MB | hint MB | filter KB | params KB | params fetch ms |',
  );
  console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    console.log(
      `| ${row.entries} | ${row.recordBytes} | ${row.arity} | ${row.snapshotMs.toFixed(1)} | ${row.snapshotMb.toFixed(2)} | ${row.startupSeconds.toFixed(1)} | ${row.rssMb ?? '-'} | ${row.hintMb.toFixed(2)} | ${row.filterKb.toFixed(1)} | ${row.paramsKb.toFixed(1)} | ${row.paramsFetchMs.toFixed(1)} |`,
    );
  }

  console.log('');
  console.log(
    '| N | WASM setup p50/p95 ms | query p50/p95 ms | query KB | HTTP respond p50/p95 ms | response KB | process p50/p95 µs |',
  );
  console.log('|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    console.log(
      `| ${row.entries} | ${pair(row.wasmSetup)} | ${pair(row.query)} | ${(row.queryBytes / 1024).toFixed(1)} | ${pair(row.respond)} | ${(row.responseBytes / 1024).toFixed(1)} | ${(row.process.p50 * 1000).toFixed(0)}/${(row.process.p95 * 1000).toFixed(0)} |`,
    );
  }
}

async function main(): Promise<void> {
  const wasmBytes = new Uint8Array(await readFile(WASM_PATH));
  const module = await WebAssembly.compile(wasmBytes);
  const recordBytes = envInt('PIR_BENCH_RECORD_BYTES', 2048);
  const arity = envInt('PIR_BENCH_ARITY', 3);
  const iterations = envInt('PIR_BENCH_ITERATIONS', 10);
  if (recordBytes < 256 || recordBytes > 16 * 1024) throw new Error('PIR_BENCH_RECORD_BYTES harus 256..16384');
  if (arity !== 3 && arity !== 4) throw new Error('PIR_BENCH_ARITY harus 3 atau 4');
  if (iterations < 1) throw new Error('PIR_BENCH_ITERATIONS harus > 0');

  const cpu = (await readFile('/proc/cpuinfo', 'utf8').catch(() => ''))
    .match(/^model name\s*:\s*(.+)$/m)?.[1]
    ?.trim() ?? cpus()[0]?.model ?? 'unknown';
  const wasmSha = createHash('sha256').update(wasmBytes).digest('hex');
  console.error(`PIR bench: host="${cpu}" cores=${cpus().length} wasm=${wasmSha} (${wasmBytes.length} B)`);

  const rows: BenchRow[] = [];
  for (const entries of sizes()) {
    console.error(`PIR bench: N=${entries}, record=${recordBytes} B, arity=${arity}, iterations=${iterations}`);
    rows.push(await runSize(module, entries, recordBytes, arity, iterations));
  }

  printTables(rows);
  if (process.env.PIR_BENCH_JSON === '1') console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
  console.error('PIR bench gagal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
