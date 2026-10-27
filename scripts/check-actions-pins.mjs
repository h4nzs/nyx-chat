// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit F-15] Tolak action GitHub yang di-pin ke ref bergerak.
 *
 * `uses: owner/action@master` berarti kode yang dijalankan bisa berubah kapan
 * saja tanpa perubahan di repo — termasuk di job deploy yang memegang kunci SSH
 * ke VPS. Skrip ini menolak `@master`, `@main`, `@HEAD`, `@latest`, `@dev`.
 *
 * Pin ke SHA (40 heksadesimal) adalah bentuk terkuat dan yang dipakai untuk
 * action yang menyentuh deploy/rahasia. Pin ke tag (`@v4`) tidak ditolak di
 * sini, tetapi dicatat di output supaya tetap terlihat — tag juga bisa
 * dipindahkan pemiliknya.
 *
 * Jalankan: `node scripts/check-actions-pins.mjs`
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const workflowsDir = path.join(repo, '.github', 'workflows');

const FLOATING = new Set(['master', 'main', 'HEAD', 'latest', 'dev', 'develop', 'canary', 'next']);
const SHA = /^[0-9a-f]{40}$/i;

const problems = [];
let shaPinned = 0;
let tagPinned = 0;

for (const file of readdirSync(workflowsDir)) {
  if (!/\.ya?ml$/.test(file)) continue;
  const lines = readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = /^\s*-?\s*uses:\s*'?"?([^'"\s#]+)'?"?/.exec(line);
    if (!match) return;
    const ref = match[1];
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;

    const at = ref.lastIndexOf('@');
    const where = `${file}:${index + 1}`;
    if (at === -1) {
      problems.push(`${where}: \`${ref}\` tanpa ref (pakai SHA atau tag)`);
      return;
    }
    const pin = ref.slice(at + 1);
    if (FLOATING.has(pin)) {
      problems.push(`${where}: \`${ref}\` memakai ref bergerak — pin ke SHA (dan tulis tag-nya di komentar)`);
    } else if (SHA.test(pin)) {
      shaPinned += 1;
    } else {
      tagPinned += 1;
    }
  });
}

if (problems.length > 0) {
  console.error('Gate pin action gagal:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Gate pin action lulus (${shaPinned} action di-pin ke SHA, ${tagPinned} ke tag — tag boleh bergerak, prioritaskan SHA untuk job yang memegang rahasia).`
);
