// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const baselinePath = path.join(here, 'pq-only-baseline.json');
const exceptionsPath = path.join(here, 'pq-only-exceptions.json');
const EXCEPTION_TIERS = new Set(['legacy-v1-fallback', 'tier-b']);

const ROOTS = ['web/src', 'server/src', 'packages/shared/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'target', 'vendor']);
const SKIP_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

const PATTERNS = [
  ['crypto_box_seal', /crypto_box_seal\(/g],
  ['crypto_box_seal_open', /crypto_box_seal_open\(/g],
  ['crypto_box_keypair', /crypto_box_keypair/g],
  ['crypto_scalarmult_base', /crypto_scalarmult_base/g],
  ['crypto_scalarmult', /crypto_scalarmult\(/g],
  ['crypto_sign_ed25519_pk_to_curve25519', /crypto_sign_ed25519_pk_to_curve25519/g],
  ['crypto_sign_ed25519_sk_to_curve25519', /crypto_sign_ed25519_sk_to_curve25519/g],
  ['crypto_sign_seed_keypair', /crypto_sign_seed_keypair/g],
  ['crypto_sign_detached', /crypto_sign_detached/g],
  ['crypto_sign_verify_detached', /crypto_sign_verify_detached/g],
  ['RSABSSA', /RSABSSA/g],
  ['ECVRF', /ECVRF|ecvrf/g],
];

function collectFiles(relativeDir, out) {
  const absolute = path.join(repo, relativeDir);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute)) {
    if (SKIP_DIRS.has(entry)) continue;
    const childAbsolute = path.join(absolute, entry);
    const childRelative = `${relativeDir}/${entry}`;
    if (statSync(childAbsolute).isDirectory()) {
      collectFiles(childRelative, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
    out.push(childRelative);
  }
}

function scan() {
  const files = [];
  for (const root of ROOTS) collectFiles(root, files);

  const found = {};
  for (const relative of files) {
    const source = readFileSync(path.join(repo, relative), 'utf8');
    for (const [name, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      const matches = source.match(pattern);
      if (!matches || matches.length === 0) continue;
      found[relative] ??= {};
      found[relative][name] = matches.length;
    }
  }

  const sorted = {};
  for (const file of Object.keys(found).sort()) {
    const symbols = {};
    for (const name of Object.keys(found[file]).sort()) symbols[name] = found[file][name];
    sorted[file] = symbols;
  }
  return sorted;
}

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, 'utf8'));
}

function readExceptions() {
  return JSON.parse(readFileSync(exceptionsPath, 'utf8'));
}

function validateExceptions(baseline, exceptions) {
  const problems = [];
  for (const file of Object.keys(baseline)) {
    const entry = exceptions[file];
    if (!entry) {
      problems.push(`${file}: belum punya entri di pq-only-exceptions.json`);
      continue;
    }
    if (!EXCEPTION_TIERS.has(entry.tier)) {
      problems.push(`${file}: tier tidak dikenal (${entry.tier})`);
    }
    if (!entry.rationale || entry.rationale.trim() === '') {
      problems.push(`${file}: rationale kosong`);
    }
    if (!entry.removalGate || entry.removalGate.trim() === '') {
      problems.push(`${file}: removalGate kosong`);
    }
  }
  for (const file of Object.keys(exceptions)) {
    if (!baseline[file]) problems.push(`${file}: entri exception usang (tidak ada di baseline)`);
  }
  return problems;
}

function diff(expected, actual) {
  const problems = [];
  const files = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const file of [...files].sort()) {
    const exp = expected[file] ?? {};
    const act = actual[file] ?? {};
    const symbols = new Set([...Object.keys(exp), ...Object.keys(act)]);
    for (const symbol of [...symbols].sort()) {
      const before = exp[symbol] ?? 0;
      const after = act[symbol] ?? 0;
      if (after > before) {
        problems.push(`${file}: ${symbol} ${before} -> ${after} (klasik-only baru)`);
      } else if (after < before) {
        problems.push(`${file}: ${symbol} ${before} -> ${after} (baseline usang, jalankan --write)`);
      }
    }
  }
  return problems;
}

const mode = process.argv.includes('--write') ? 'write' : 'check';
const actual = scan();

if (mode === 'write') {
  writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Baseline PQ-only ditulis: ${path.relative(repo, baselinePath)} (${Object.keys(actual).length} berkas)`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('Baseline PQ-only tidak ada. Jalankan: node scripts/check-pq-only.mjs --write');
  process.exit(1);
}

const baseline = readBaseline();
const problems = diff(baseline, actual);
if (problems.length > 0) {
  console.error('Guard PQ-only gagal:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Tambahkan implementasi PQ pengganti, bukan baseline baru tanpa alasan.');
  process.exit(1);
}

if (!existsSync(exceptionsPath)) {
  console.error(`Manifest exception tidak ada: ${path.relative(repo, exceptionsPath)}`);
  process.exit(1);
}

const exceptions = readExceptions();
const exceptionProblems = validateExceptions(baseline, exceptions);
if (exceptionProblems.length > 0) {
  console.error('Guard PQ-only gagal (manifest exception):');
  for (const problem of exceptionProblems) console.error(`  - ${problem}`);
  process.exit(1);
}

const tiers = Object.values(exceptions).reduce((counts, entry) => {
  counts[entry.tier] = (counts[entry.tier] ?? 0) + 1;
  return counts;
}, {});
console.log(
  `Guard PQ-only lulus (${Object.keys(actual).length} berkas legacy/exception; ` +
    `Tier A baru: 0; Tier B: ${tiers['tier-b'] ?? 0}; legacy v1: ${tiers['legacy-v1-fallback'] ?? 0}).`
);
