#!/usr/bin/env node
// Gate anti-drift untuk STATUS.md.
//
// STATUS.md hanya boleh berisi fakta yang bisa dibuktikan dari kode. Skrip ini
// memeriksa empat hal dan gagal (exit 1) bila salah satunya tidak cocok:
//
//   1. versi app = `package.json`;
//   2. daftar kapabilitas relay = `SERVER_CAPABILITIES` di `packages/shared`;
//   3. setiap rute privasi benar-benar dipasang di `server/src/app.ts`;
//   4. setiap saklar privasi benar-benar ada di kode (dan sebaliknya untuk
//      daftar saklar yang dikenal, supaya saklar baru tidak lolos tanpa dicatat).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const status = read('STATUS.md');
const lines = status.split('\n');

/** Baris di bawah `## <title>` sampai heading berikutnya. */
function section(title) {
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) {
    problems.push(`STATUS.md: bagian "## ${title}" tidak ada`);
    return [];
  }
  const out = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) break;
    out.push(lines[index]);
  }
  return out;
}

const bullets = (title) =>
  section(title)
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
    .filter(Boolean);

// 1. Versi -------------------------------------------------------------------
const versionLine = section('Versi')
  .map((line) => line.match(/^-\s+app:\s*(\S+)/))
  .find(Boolean);
const packageVersion = JSON.parse(read('package.json')).version;
if (!versionLine) {
  problems.push('STATUS.md: baris "- app: <versi>" tidak ditemukan');
} else if (versionLine[1] !== packageVersion) {
  problems.push(`STATUS.md: versi app ${versionLine[1]} ≠ package.json ${packageVersion}`);
}

// 2. Kapabilitas relay -------------------------------------------------------
const transport = read('packages/shared/src/transport.ts');
const clientCapabilities = new Map();
for (const match of transport.matchAll(/^\s{2}([A-Z0-9_]+):\s*'([a-z0-9-]+)',/gm)) {
  clientCapabilities.set(match[1], match[2]);
}
const serverBlock = transport.match(/SERVER_CAPABILITIES: readonly string\[\]\s*=\s*\[([\s\S]*?)\];/);
const serverCapabilities = serverBlock
  ? [...serverBlock[1].matchAll(/CLIENT_CAPABILITIES\.([A-Z0-9_]+)/g)].map((match) => {
      const resolved = clientCapabilities.get(match[1]);
      if (!resolved) problems.push(`transport.ts: ${match[1]} tidak ada di CLIENT_CAPABILITIES`);
      return resolved;
    })
  : [];

if (serverCapabilities.length === 0) {
  problems.push('packages/shared/src/transport.ts: SERVER_CAPABILITIES tidak terbaca');
}
const documentedCapabilities = bullets('Kapabilitas relay (SERVER_CAPABILITIES)');
for (const capability of serverCapabilities) {
  if (capability && !documentedCapabilities.includes(capability)) {
    problems.push(`STATUS.md: kapabilitas "${capability}" ada di kode tetapi tidak dicatat`);
  }
}
for (const documented of documentedCapabilities) {
  if (!serverCapabilities.includes(documented)) {
    problems.push(`STATUS.md: kapabilitas "${documented}" tidak ada di SERVER_CAPABILITIES`);
  }
}

// 3. Rute privasi ------------------------------------------------------------
const appSource = read('server/src/app.ts');
for (const route of bullets('Rute privasi (dipasang di server/src/app.ts)')) {
  if (!appSource.includes(`"${route}"`) && !appSource.includes(`'${route}'`)) {
    problems.push(`STATUS.md: rute "${route}" tidak dipasang di server/src/app.ts`);
  }
}

// 4. Saklar privasi ----------------------------------------------------------
const documentedFlags = [...status.matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|/gm)].map((match) => match[1]);
const PRIVACY_SWITCHES = [
  'PIR_ENABLED',
  'OHTTP_ENABLED',
  'KT_QUERY_URL',
  'KT_V2_SERVER_URL',
  'KT_V2_BACKFILL_ON_LOGIN',
  'VITE_OHTTP_ENABLED',
  'VITE_PIR_ENABLED',
  'VITE_PIR_OPRF_ENABLED',
  'VITE_SPQR_FORCE_V1',
  'VITE_SPQR_FORCE_V2',
];

/** Isi semua berkas sumber (tanpa test/dist) sebagai satu string. */
function sourceBlob(directories) {
  const chunks = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__' || entry === 'vendor') continue;
      const full = path.join(directory, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) {
        chunks.push(readFileSync(full, 'utf8'));
      }
    }
  };
  for (const directory of directories) walk(path.join(root, directory));
  return chunks.join('\n');
}

const sources = sourceBlob(['server/src', 'web/src']);
// Aksesnya bisa `process.env.X`, `import.meta.env.X`, atau lewat parameter
// `env` yang diinjeksi untuk test (`env.X`) — yang penting properti itu dibaca.
const present = (flag) => new RegExp(`\\.${flag}\\b`).test(sources);

for (const flag of documentedFlags) {
  if (!present(flag)) {
    problems.push(`STATUS.md: saklar "${flag}" tidak dipakai di kode (salah nama atau sudah dihapus)`);
  }
}
for (const flag of PRIVACY_SWITCHES) {
  if (present(flag) && !documentedFlags.includes(flag)) {
    problems.push(`STATUS.md: saklar privasi "${flag}" ada di kode tetapi tidak dicatat`);
  }
}

// Hasil ----------------------------------------------------------------------
if (problems.length > 0) {
  console.error('❌ STATUS.md tidak cocok dengan kode:');
  for (const problem of problems) console.error(`   - ${problem}`);
  console.error('\nPerbaiki STATUS.md (atau kode) dalam commit yang sama.');
  process.exit(1);
}
console.log(
  `✅ STATUS.md cocok: versi ${packageVersion}, ${serverCapabilities.length} kapabilitas, ` +
    `${bullets('Rute privasi (dipasang di server/src/app.ts)').length} rute, ${documentedFlags.length} saklar privasi.`
);
