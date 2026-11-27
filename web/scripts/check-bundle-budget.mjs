#!/usr/bin/env node
// [docs/41 §8] Budget ukuran bundle produksi. Bukan runtime perf, tetapi
// kenaikan satu dependency besar langsung terlihat di sini tanpa menambah
// tooling. Jalankan setelah `vite build` (dist/ sudah ada).
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DIST_ASSETS = path.resolve(process.cwd(), 'dist/assets');
const LIMITS = {
  // Baseline 26 Nov 2026: 6,22 MB total, file terbesar 1,28 MB. Beri ruang
  // untuk perubahan normal, tetapi gagalkan lompatan dependency yang besar.
  totalJsBytes: 7 * 1024 * 1024,
  largestJsBytes: 1.5 * 1024 * 1024,
};

let files;
try {
  files = readdirSync(DIST_ASSETS).filter((file) => file.endsWith('.js'));
} catch {
  console.error(`[bundle-budget] ${DIST_ASSETS} tidak ada; jalankan \`vite build\` dulu.`);
  process.exit(1);
}

const sizes = files
  .map((file) => ({ file, bytes: statSync(path.join(DIST_ASSETS, file)).size }))
  .sort((left, right) => right.bytes - left.bytes);
const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
const largest = sizes[0];

const failures = [];
if (total > LIMITS.totalJsBytes) {
  failures.push(`total JS ${(total / 1048576).toFixed(2)} MB > ${(LIMITS.totalJsBytes / 1048576).toFixed(2)} MB`);
}
if (largest && largest.bytes > LIMITS.largestJsBytes) {
  failures.push(`file terbesar ${largest.file} ${(largest.bytes / 1048576).toFixed(2)} MB > ${(LIMITS.largestJsBytes / 1048576).toFixed(2)} MB`);
}

if (failures.length > 0) {
  console.error(`[bundle-budget] GAGAL: ${failures.join('; ')}`);
  process.exit(1);
}

console.log(
  `[bundle-budget] OK — total ${(total / 1048576).toFixed(2)} MB, ` +
    `terbesar ${largest ? `${largest.file} ${(largest.bytes / 1048576).toFixed(2)} MB` : 'n/a'}`,
);
