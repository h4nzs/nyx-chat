#!/usr/bin/env node
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/41 §9.6] Gerbang audit produksi.
 *
 * `pnpm audit --prod` saja gagal juga untuk advisory yang **belum punya rilis
 * perbaikan** — tidak ada yang bisa dipasang, jadi job merah tanpa tindakan
 * yang mungkin. Skrip ini tetap menolak semua kerentanan, kecuali yang terdaftar
 * di `scripts/audit-exceptions.json` dengan alasan tertulis DAN tanggal
 * kedaluwarsa. Pengecualian yang sudah tidak dipakai lagi (advisory hilang dari
 * hasil audit) juga menggagalkan gate, supaya daftar ini tidak menumpuk.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXCEPTIONS_PATH = new URL('./audit-exceptions.json', import.meta.url);
const today = new Date().toISOString().slice(0, 10);

/** `pnpm audit` keluar dengan kode != 0 saat ada temuan; JSON-nya tetap dibaca. */
function readAuditJson() {
  try {
    return execFileSync('pnpm', ['audit', '--prod', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    if (!stdout.trim()) throw new Error(`pnpm audit gagal tanpa output: ${error?.message ?? error}`);
    return stdout;
  }
}

const exceptions = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
const audit = JSON.parse(readAuditJson());
const advisories = Object.values(audit.advisories ?? {});

const problems = [];
const accepted = [];

for (const advisory of advisories) {
  const id = advisory.github_advisory_id ?? String(advisory.id);
  const name = advisory.module_name ?? '(tidak diketahui)';
  const exception = exceptions[id];
  if (!exception) {
    problems.push(
      `${name}: ${id} (${advisory.severity}, rentan ${advisory.vulnerable_versions}) belum diperbaiki dan tidak terdaftar sebagai pengecualian`,
    );
    continue;
  }
  if (exception.package !== name) {
    problems.push(`${name}: pengecualian ${id} terdaftar untuk paket "${exception.package}"`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires ?? '') || exception.expires < today) {
    problems.push(`${name}: pengecualian ${id} kedaluwarsa (${exception.expires ?? 'tanpa tanggal'})`);
    continue;
  }
  if (String(exception.rationale ?? '').trim().length < 40) {
    problems.push(`${name}: pengecualian ${id} tanpa alasan tertulis yang memadai`);
    continue;
  }
  accepted.push(`${name} ${id} (${advisory.severity}) — ditoleransi s/d ${exception.expires}`);
}

for (const id of Object.keys(exceptions)) {
  const stillReported = advisories.some((advisory) => (advisory.github_advisory_id ?? String(advisory.id)) === id);
  if (!stillReported) {
    problems.push(`pengecualian ${id} tidak lagi diperlukan (advisory tidak muncul di audit) — hapus dari scripts/audit-exceptions.json`);
  }
}

for (const line of accepted) console.log(`[audit] diterima: ${line}`);

if (problems.length > 0) {
  console.error(`[audit] ${problems.length} masalah pada dependency produksi:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[audit] bersih: 0 kerentanan produksi tanpa pengecualian aktif (${accepted.length} pengecualian)`);
