// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit F-08] Gate: pin dependensi transitif harus benar-benar berlaku.
 *
 * Kenapa ini ada: 31 pin keamanan dulu hidup di `resolutions` (`package.json`
 * root), dan **pnpm mengabaikan kunci itu**. Tidak ada satu pun yang berlaku,
 * tetapi keberadaannya membuat reviewer mengira sudah ditambal. Skrip ini
 * menolak kondisi itu kembali: `resolutions` tidak boleh ada, setiap
 * `overrides` harus muncul di `pnpm-lock.yaml` (pin yang tidak mengubah lock =
 * pin yang tidak berlaku), dan `allowBuilds` harus bernilai boolean.
 *
 * Jalankan: `node scripts/check-overrides.mjs`
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

const problems = [];

function read(relative) {
  return readFileSync(path.join(repo, relative), 'utf8');
}

// 1. `resolutions` = mekanisme yang diabaikan pnpm; jangan kembali.
let rootPkg;
try {
  rootPkg = JSON.parse(read('package.json'));
} catch (error) {
  console.error(`package.json tidak bisa dibaca: ${error.message}`);
  process.exit(1);
}
if (rootPkg.resolutions && Object.keys(rootPkg.resolutions).length > 0) {
  problems.push(
    'package.json masih memuat `resolutions` — pnpm 11 mengabaikannya; pindahkan ke `overrides:` di pnpm-workspace.yaml'
  );
}

// 2. Kumpulkan `overrides` (parser baris sederhana; tidak menambah dependensi).
const workspaceLines = read('pnpm-workspace.yaml').split('\n');
const overrides = [];
let section = null;
for (const line of workspaceLines) {
  if (/^overrides:\s*$/.test(line)) {
    section = 'overrides';
    continue;
  }
  if (/^\S/.test(line)) {
    section = line.startsWith('allowBuilds:') ? 'allowBuilds' : null;
    continue;
  }
  if (/^\s*#/.test(line)) continue;
  if (section === 'overrides') {
    const match = /^\s{2}'?([^':]+)'?(?:@[^:]*)?:\s*(.+)$/.exec(line);
    if (match) overrides.push({ name: match[1], range: match[2].trim().replace(/^'|'$/g, '') });
  } else if (section === 'allowBuilds') {
    const match = /^\s{2}'?([^':]+)'?:\s*(.*)$/.exec(line);
    if (match && match[2].trim() !== 'true' && match[2].trim() !== 'false') {
      problems.push(`allowBuilds.${match[1]} bukan boolean (${match[2].trim() || 'kosong'})`);
    }
  }
}

if (overrides.length === 0) problems.push('pnpm-workspace.yaml tidak punya satu pun entri `overrides:`');

// 3. Setiap override harus muncul di lockfile. Pin yang tidak muncul di lock
//    tidak mengubah resolusi apa pun — persis kegagalan yang diaudit.
const lock = read('pnpm-lock.yaml');
for (const { name } of overrides) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`^ {2}'?${escaped}@`, 'm');
  if (!entry.test(lock)) {
    problems.push(`override \`${name}\` tidak ada di pnpm-lock.yaml (pin tidak berlaku — hapus atau jalankan pnpm install)`);
  }
}

if (problems.length > 0) {
  console.error('Gate override pnpm gagal:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Gate override pnpm lulus (${overrides.length} override berlaku, tanpa \`resolutions\`, allowBuilds boolean).`
);
