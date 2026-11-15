// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.2] Coverage server **tanpa** menduplikasi daftar tes.
//
// `package.json` sudah memuat ~99 berkas tes di script `test`, dan daftar kedua
// di sini akan cepat menyimpang (itu juga alasan daftar tes tidak memakai glob:
// berkas yang lupa terdaftar tidak akan pernah jalan). Jadi skrip ini membaca
// script `test` lalu menjalankannya dengan flag coverage Node.
//
// Kenapa bukan `NODE_OPTIONS=--experimental-test-coverage pnpm test` seperti
// yang sempat direncanakan: Node menolaknya ("--experimental-test-coverage is
// not allowed in NODE_OPTIONS"), jadi flag harus diteruskan langsung ke proses
// node.
//
// Kenapa `node --import tsx`, bukan binary `tsx`: binary itu hanya ada di PATH
// saat dipanggil lewat `pnpm run`, sehingga `node scripts/test-coverage.mjs`
// gagal dengan `spawnSync tsx ENOENT`. Memanggil `process.execPath` dengan
// loader yang sama membuat skrip ini bisa dijalankan dari mana saja.
// `--enable-source-maps` dipakai supaya angka coverage menunjuk `.ts` asli.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = new URL('../package.json', import.meta.url);
const { scripts } = JSON.parse(readFileSync(manifest, 'utf8'));
const testScript = String(scripts?.test ?? '');
const [runner, ...testArgs] = testScript.split(/\s+/).filter(Boolean);

if (runner === undefined || testArgs.length === 0) {
  console.error('test:coverage: script "test" di server/package.json tidak bisa dibaca');
  process.exit(1);
}

/**
 * Ambang batas dari baseline 3 Nov 2026 (lines 77,3% · branches 84,7% ·
 * functions 79,4%). Diturunkan beberapa poin supaya tidak flake karena mesin CI
 * yang lebih lambat, tetapi tetap menangkap penurunan nyata: tanpa angka ini
 * "coverage" hanya laporan yang tidak pernah bisa menggagalkan apa pun.
 * Naikkan bertahap, jangan turunkan tanpa alasan yang dicatat.
 */
const COVERAGE_THRESHOLDS = [
  '--test-coverage-lines=72',
  '--test-coverage-branches=78',
  '--test-coverage-functions=74',
];

const result = spawnSync(
  process.execPath,
  ['--enable-source-maps', '--experimental-test-coverage', ...COVERAGE_THRESHOLDS, '--import', 'tsx', ...testArgs],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error('test:coverage gagal menjalankan test runner:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
