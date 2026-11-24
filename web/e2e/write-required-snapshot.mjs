// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/41 §6.5] Tulis snapshot judul tes untuk gate E2E.
//
// Snapshot dibuat dari `playwright test --list --reporter=json` (tidak
// menjalankan tes, jadi tidak butuh Postgres/Redis/sidecar). Setelah menambah,
// menghapus, atau mengganti nama tes, jalankan:
//
//   pnpm --filter nyx-web run test:e2e:snapshot
//
// Skrip ini membuat report --list untuk setiap project lalu menulis
// `e2e/required-tests.snapshot.json`. Gate `verify-required-tests.mjs` menolak
// report yang himpunannya berbeda, sehingga perubahan judul tes tidak bisa lolos
// sebagai "jumlahnya tetap".
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { flattenTests } from './verify-required-tests.mjs';

const PROJECTS = ['chromium', 'chrome'];
const out = path.resolve(process.argv[2] ?? 'e2e/required-tests.snapshot.json');

function listTests(project) {
  const stdout = execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'playwright', 'test', '--list', '--reporter=json', `--project=${project}`],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  // `--reporter=json` tanpa outputFile menulis report ke stdout. Ambil dari '{'
  // pertama supaya baris pembuka (mis. peringatan pnpm) tidak merusak parse.
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error(`report JSON ${project} tidak ditemukan di stdout`);
  return JSON.parse(stdout.slice(start));
}

const projects = {};
for (const project of PROJECTS) {
  const report = listTests(project);
  projects[project] = [
    ...new Set(
      flattenTests(report)
        .filter((t) => t.projectName === project)
        .map((t) => `${t.file}::${t.title}`)
    ),
  ].sort();
  console.log(`snapshot: ${project} → ${projects[project].length} tes`);
}

writeFileSync(
  out,
  `${JSON.stringify(
    {
      version: 1,
      note: 'Himpunan file::title yang dijaga gate E2E. Perbarui dengan pnpm --filter nyx-web run test:e2e:snapshot; jangan edit manual.',
      projects,
    },
    null,
    2
  )}\n`
);
console.log(`snapshot ditulis: ${out}`);
