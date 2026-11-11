#!/usr/bin/env node
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/42 WP8, gate performa] Bench jalur query XOR-PIR yang sebenarnya:
 * sidecar Rust + shard di disk + HTTP loopback, satu proses, tanpa Docker.
 *
 * Kenapa bukan Docker: yang diukur adalah jalur produksi (API → sidecar lewat
 * loopback). Di dalam container jalur itu melewati veth/bridge dan CPU dibatasi
 * cgroup, jadi angkanya mengukur Docker + host, bukan gate 10 ms.
 *
 * Pemakaian:
 *   node scripts/bench/pir-query.mjs                 # S=4096, R=2048, 1000 query
 *   NYX_PIR_BENCH_QUERIES=5000 node scripts/bench/pir-query.mjs
 *   NYX_PIR_BIN=/path/ke/pir-service node scripts/bench/pir-query.mjs
 *
 * Batas regresi (boleh dilonggarkan lewat env, jangan dihapus):
 *   p95 < 50 ms, <= 16 KB per pencarian, RSS <= 1,5x ukuran shard.
 * Angka gate riset (p95 <= 10 ms) tetap target; skrip ini mencetak hasil
 * terukur apa adanya, tidak mengklaim target tercapai.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.NYX_PIR_BIN || path.join(ROOT, 'server/pir-sidecar/target/release/pir-service');
const SLOTS = Number(process.env.NYX_PIR_BENCH_SLOTS || 4096);
const RECORD_BYTES = Number(process.env.NYX_PIR_BENCH_RECORD_BYTES || 2048);
const QUERIES = Number(process.env.NYX_PIR_BENCH_QUERIES || 1000);
const WARMUP = Number(process.env.NYX_PIR_BENCH_WARMUP || 50);
const PORT = Number(process.env.NYX_PIR_BENCH_PORT || 19570);
const MAX_P95_MS = Number(process.env.NYX_PIR_BENCH_MAX_P95_MS || 50);
const MAX_BYTES = Number(process.env.NYX_PIR_BENCH_MAX_BYTES || 16 * 1024);
// Batas regresi, bukan target riset. Baseline proses sidecar (~5 MiB) mendominasi
// shard 8 MiB sehingga rasio di bench default wajar ~1,6x; pada shard 32 MiB
// terukur 1,16x. Target desain 1,5x hanya bermakna saat baseline teramortisasi,
// dan itu dilaporkan terpisah di docs/42 alih-alih dipaksakan di sini.
const MAX_RSS_RATIO = Number(process.env.NYX_PIR_BENCH_MAX_RSS_RATIO || 2.0);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/** `pirDbRoot` versi Rust: sha256(u32 BE recordBytes, lalu setiap slot). */
function dbRoot(slots) {
  const hash = createHash('sha256');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(RECORD_BYTES, 0);
  hash.update(header);
  for (let offset = 0; offset < slots.length; offset += RECORD_BYTES) {
    hash.update(slots.subarray(offset, offset + RECORD_BYTES));
  }
  return hash.digest('hex');
}

function fraction(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function waitForPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('timeout', () => req.destroy());
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`sidecar tidak siap di :${port}`));
      else setTimeout(attempt, 100);
    };
    attempt();
  });
}

function request(agent, body) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/query?shard=0',
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ status: res.statusCode, bytes: body.length + Buffer.concat(chunks).length, length: Buffer.concat(chunks).length, elapsedMs });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function rssBytes(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function main() {
  const share = randomBytes(Math.ceil(SLOTS / 8));
  const workDir = mkdtempSync(path.join(tmpdir(), 'nyx-pir-bench-'));
  const shardDir = path.join(workDir, 'shards');
  mkdirSync(shardDir);
  const slots = randomBytes(SLOTS * RECORD_BYTES);
  writeFileSync(path.join(shardDir, 'shard-0.bin'), slots);
  writeFileSync(
    path.join(shardDir, 'shard-0.json'),
    JSON.stringify({
      manifest: {
        suite: 'xor-pir-v1',
        shard: 0,
        shardCount: 1,
        slotCount: SLOTS,
        recordBytes: RECORD_BYTES,
        epoch: 1,
        entryCount: 0,
        dbRoot: dbRoot(slots),
        operator: 'bench',
        keyId: '0'.repeat(64),
      },
      signature: 'bench-not-signed',
    }),
  );

  const child = spawn(BIN, [], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PIR_ROLE: 'a',
      PIR_BIND: `127.0.0.1:${PORT}`,
      PIR_SHARD_DIR: shardDir,
      PIR_ADMIN_TOKEN: '',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const cleanup = () => {
    child.kill('SIGTERM');
    rmSync(workDir, { recursive: true, force: true });
  };
  process.once('exit', cleanup);

  try {
    await waitForPort(PORT, Date.now() + 15_000);
  } catch (error) {
    fail(`${error.message}\n${stderr}`);
  }

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const latencies = [];
  let bytes = 0;
  let answered = 0;
  for (let i = 0; i < WARMUP + QUERIES; i += 1) {
    const response = await request(agent, share);
    if (response.status !== 200) fail(`query #${i} menjawab HTTP ${response.status} (harus 200)`);
    if (response.length !== RECORD_BYTES) fail(`panjang jawaban ${response.length} B, harus ${RECORD_BYTES} B`);
    if (i >= WARMUP) {
      latencies.push(response.elapsedMs);
      bytes += response.bytes;
      answered += 1;
    }
  }
  agent.destroy();

  latencies.sort((a, b) => a - b);
  const p50 = fraction(latencies, 50);
  const p95 = fraction(latencies, 95);
  const p99 = fraction(latencies, 99);
  const mean = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const bytesPerQuery = bytes / answered;
  const shardBytes = SLOTS * RECORD_BYTES;
  const rss = rssBytes(child.pid);
  const rssRatio = rss ? rss / shardBytes : null;

  console.log(`\nXOR-PIR bench — S=${SLOTS}, R=${RECORD_BYTES}, ${answered} query (+${WARMUP} warmup)`);
  console.log(`  p50 ${p50.toFixed(3)} ms  p95 ${p95.toFixed(3)} ms  p99 ${p99.toFixed(3)} ms  rata-rata ${mean.toFixed(3)} ms`);
  console.log(`  trafik ${bytesPerQuery.toFixed(0)} B/query (share ${share.length} B + jawaban ${RECORD_BYTES} B)`);
  console.log(`  RSS sidecar ${(rss / 1024 / 1024).toFixed(1)} MiB, shard ${(shardBytes / 1024 / 1024).toFixed(1)} MiB, rasio ${rssRatio?.toFixed(2) ?? 'n/a'}x`);
  console.log(`  batas regresi: p95 < ${MAX_P95_MS} ms, <= ${MAX_BYTES} B/query, RSS <= ${MAX_RSS_RATIO}x`);

  const problems = [];
  if (p95 >= MAX_P95_MS) problems.push(`p95 ${p95.toFixed(3)} ms >= ${MAX_P95_MS} ms`);
  if (bytesPerQuery > MAX_BYTES) problems.push(`${bytesPerQuery.toFixed(0)} B/query > ${MAX_BYTES} B`);
  if (rssRatio && rssRatio > MAX_RSS_RATIO) problems.push(`RSS ${rssRatio.toFixed(2)}x > ${MAX_RSS_RATIO}x`);
  if (problems.length > 0) fail(`di luar batas regresi: ${problems.join('; ')}`);
  console.log('✅ dalam batas regresi.\n');
  // Agen keep-alive menahan event loop; tanpa exit eksplisit proses menggantung
  // setelah hasil tercetak (terlihat sebagai `timeout` exit 124 di CI/terminal).
  process.exit(0);
}

main().catch((error) => fail(error.stack || String(error)));
