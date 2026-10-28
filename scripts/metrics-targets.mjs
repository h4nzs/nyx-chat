#!/usr/bin/env node
// Generate file_sd Prometheus untuk exporter per-worker `nyx-api`.
// Dipakai deploy setelah pm2 start; jumlah worker default mengikuti CPU host
// (pm2 `-i max`). METRICS_PORT=0 menulis daftar kosong supaya tidak ada target
// yang terus `down`.

import { availableParallelism, cpus } from 'node:os';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg (name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : fallback;
}

const base = Number.parseInt(arg('base', '9464'), 10);
const workers = Number.parseInt(
  arg('workers', String(availableParallelism?.() ?? cpus().length)),
  10,
);
const host = arg('host', '127.0.0.1');
const out = arg('out', '');

if (!out) {
  console.error('usage: metrics-targets.mjs --out <file> [--base 9464] [--workers N] [--host 127.0.0.1]');
  process.exit(1);
}
if (!Number.isInteger(base) || base < 0 || base > 65535) {
  console.error(`METRICS_PORT tidak sah: ${arg('base', '9464')}`);
  process.exit(1);
}
if (!Number.isInteger(workers) || workers < 1 || workers > 256) {
  console.error(`jumlah worker tidak sah: ${arg('workers', '')}`);
  process.exit(1);
}
if (base !== 0 && base + (workers - 1) * 10 > 65535) {
  console.error(`port ${base}..${base + (workers - 1) * 10} di luar batas`);
  process.exit(1);
}

// Stride 10 keeps API workers clear of sidecar (9465) and KT v2 (9468-9469).
const groups = base === 0
  ? []
  : [{ targets: Array.from({ length: workers }, (_, index) => `${host}:${base + index * 10}`) }];

await mkdir(path.dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
await writeFile(tmp, `${JSON.stringify(groups, null, 2)}\n`, { mode: 0o644 });
await rename(tmp, out);
console.log(`[metrics-targets] ${groups.length ? groups[0].targets.length : 0} target → ${out}`);
