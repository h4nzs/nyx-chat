// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [plan kualitas §6.3] Gate changed-lines untuk coverage web.
//
// Kenapa bukan `diff-cover`: itu alat Python (butuh pip di runner) dan hanya
// membaca lcov. Di repo ini lcov sudah dihasilkan Vitest v8, sedangkan coverage
// server (Node native) tidak punya lcov sama sekali — jadi yang dibutuhkan
// hanyalah parser kecil, bukan dependensi baru yang harus dipin.
//
// Kenapa ada gate ini padahal ada threshold per-glob: coverage global bisa naik
// karena file yang sudah teruji, sementara baris BARU tidak diuji sama sekali.
// Gate ini menjawab pertanyaan yang sebenarnya: "baris yang saya ubah di PR ini
// ada yang mengeksekusinya atau tidak".
//
// Pemakaian:
//   node scripts/check-changed-lines.mjs \
//     --lcov web/coverage/lcov.info --base origin/main --threshold 70
//
// Opsi:
//   --lcov <path>      lcov.info (default: web/coverage/lcov.info)
//   --base <ref>       dasar pembanding (default: origin/main)
//   --path <prefix>    hanya berkas di bawah prefix ini (default: web/src/)
//   --threshold <n>    persen minimum baris berubah yang tercakup (default: 70)
//   --min-lines <n>    lewati bila baris berubah terukur < n (default: 1)
//   --diff-file <path> baca unified diff dari berkas, bukan `git diff`
//                      (dipakai untuk menguji skrip ini sendiri)
//
// Keluar 1 bila rasio < threshold. Baris yang berubah tetapi tidak terukur
// (berkas di luar `coverage.include`, mis. tipe/berkas yang diabaikan) tidak
// dihitung — gate ini mengukur yang memang bisa diukur, bukan menebak.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} membutuhkan nilai`);
  }
  return value;
}

const lcovPath = path.resolve(arg('lcov', 'web/coverage/lcov.info'));
const baseRef = arg('base', 'origin/main');
const pathPrefix = arg('path', 'web/src/').replace(/\\/g, '/');
const threshold = Number(arg('threshold', '70'));
const minLines = Number(arg('min-lines', '1'));
const diffFile = arg('diff-file', null);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error('check-changed-lines: --threshold harus angka 0–100');
  process.exit(2);
}
if (!Number.isFinite(minLines) || minLines < 0) {
  console.error('check-changed-lines: --min-lines harus angka ≥ 0');
  process.exit(2);
}

/**
 * Ambil teks diff. `git diff <base> HEAD` (dua titik) sengaja dipakai, bukan
 * `<base>...HEAD`: dua titik tidak butuh merge-base, jadi tetap bekerja pada
 * clone dangkal CI. Merge-base dicoba lebih dulu supaya pemakaian lokal pada
 * branch yang tertinggal tidak menghitung perubahan yang datang dari `main`.
 */
function readDiff() {
  if (diffFile) return readFileSync(path.resolve(diffFile), 'utf8');
  let from = baseRef;
  try {
    from = execFileSync('git', ['merge-base', baseRef, 'HEAD'], { encoding: 'utf8' }).trim() || baseRef;
  } catch {
    // Clone dangkal / ref tidak punya leluhur bersama: bandingkan langsung
    // terhadap commit dasar. Net perubahan PR tetap sama.
  }
  return execFileSync('git', ['diff', '--unified=0', '--no-color', from, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** `@@ -a,b +c,d @@` → nomor baris baru (sisi `+`) yang ditambahkan/diubah. */
function addedLinesByFile(diffText) {
  const files = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      // `/dev/null` = berkas dihapus; tidak ada baris baru untuk diukur.
      current = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, new Set());
      continue;
    }
    if (!line.startsWith('@@') || current === null) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const bucket = files.get(current);
    for (let offset = 0; offset < count; offset += 1) bucket.add(start + offset);
  }
  return files;
}

/** `SF:` → `DA:<line>,<hit>`; path lcov dibuat relatif terhadap repo. */
function readLcov(text) {
  const coverage = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const raw = line.slice(3).trim().replace(/\\/g, '/');
      current = raw.startsWith('/') ? path.relative(process.cwd(), raw).replace(/\\/g, '/') : raw;
      if (!coverage.has(current)) coverage.set(current, new Map());
      continue;
    }
    if (!line.startsWith('DA:') || current === null) continue;
    const [lineNo, hits] = line.slice(3).split(',');
    coverage.get(current).set(Number(lineNo), Number(hits));
  }
  return coverage;
}

let diffText;
try {
  diffText = readDiff();
} catch (error) {
  console.error(`check-changed-lines: gagal membaca diff git — ${error.message}`);
  process.exit(2);
}

const changed = addedLinesByFile(diffText);
const coverage = readLcov(readFileSync(lcovPath, 'utf8'));

const rows = [];
let totalMeasured = 0;
let totalCovered = 0;

for (const [file, lines] of changed) {
  if (!file.startsWith(pathPrefix)) continue;
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const hits = coverage.get(file);
  if (!hits) continue; // di luar `coverage.include` — bukan urusan gate ini
  let measured = 0;
  let covered = 0;
  for (const lineNo of lines) {
    const count = hits.get(lineNo);
    if (count === undefined) continue;
    measured += 1;
    if (count > 0) covered += 1;
  }
  if (measured === 0) continue;
  rows.push({ file, measured, covered, pct: Math.round((covered / measured) * 1000) / 10 });
  totalMeasured += measured;
  totalCovered += covered;
}

if (totalMeasured < minLines) {
  console.log(
    `check-changed-lines: tidak ada baris berubah yang terukur ` +
      `(terukur ${totalMeasured}, minimum ${minLines}) — gate dilewati.`
  );
  process.exit(0);
}

rows.sort((a, b) => a.pct - b.pct);
for (const row of rows) {
  const mark = row.pct < threshold ? '✗' : '✓';
  console.log(`${mark} ${String(row.pct).padStart(5)}%  ${row.covered}/${row.measured}\t${row.file}`);
}

const pct = Math.round((totalCovered / totalMeasured) * 1000) / 10;
const summary = `changed-lines web: ${totalCovered}/${totalMeasured} baris tercakup (${pct}%), ambang ${threshold}%`;
if (pct < threshold) {
  console.error(`✗ ${summary}`);
  process.exit(1);
}
console.log(`✓ ${summary}`);
