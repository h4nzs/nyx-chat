/**
 * [2026-10-15] Kontrak "oxlint satu-satunya linter".
 *
 * ESLint dihapus karena tidak pernah bisa dijalankan di repo ini
 * (`typescript-eslint` menolak TypeScript 7), sehingga selama ini ada **dua
 * sumber kebenaran**: aturan di `eslint.config.js` yang tidak pernah dieksekusi
 * dan `oxlint` yang benar-benar menahan regresi. Setelah pembersihan, ESLint
 * tidak boleh kembali tanpa keputusan eksplisit — dan tanpa uji ini "kembali"
 * bisa terjadi dalam bentuk yang paling mudah lolos: satu devDependency
 * ditambahkan, atau direktif `eslint-disable` baru yang tidak menahan apa pun
 * (persis jebakan yang pernah terjadi di `server/src/utils/logger.ts`).
 *
 * Uji ini membaca manifest + sumber (tanpa menjalankan lint), jadi ia gagal
 * cepat dan dengan pesan yang menunjuk berkasnya.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

/** Manifest yang harus bebas dari paket ESLint (root + semua paket workspace). */
const MANIFESTS = [
  'package.json',
  'web/package.json',
  'server/package.json',
  'packages/shared/package.json',
  'marketing/package.json',
];

/** Direktori sumber yang tidak boleh lagi memuat direktif `eslint-` apa pun. */
const SOURCE_DIRS = [
  'web/src',
  'server/src',
  'packages/shared/src',
  'marketing/src',
];

const ESLINT_PACKAGE = /^(@eslint\/|eslint$|eslint-|typescript-eslint$|astro-eslint-parser$|globals$)/;

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repo, relativePath), 'utf8')) as Record<string, unknown>;
}

test('oxlint satu-satunya linter: tidak ada manifest yang memuat paket ESLint', () => {
  const offenders: string[] = [];
  for (const manifest of MANIFESTS) {
    const pkg = readJson(manifest);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = (pkg[section] ?? {}) as Record<string, string>;
      for (const name of Object.keys(deps)) {
        if (ESLINT_PACKAGE.test(name)) offenders.push(`${manifest} → ${section}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'paket ESLint tidak boleh kembali; linter repo ini oxlint (`.oxlintrc.json`)');
});

test('oxlint satu-satunya linter: config ESLint terhapus, script `lint` memakai oxlint', () => {
  for (const dir of ['web', 'server', 'marketing', 'packages/shared']) {
    for (const legacy of ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintignore']) {
      assert.equal(
        existsSync(path.join(repo, dir, legacy)),
        false,
        `${dir}/${legacy} harus tetap terhapus (ESLint tidak pernah jalan di TS 7; lihat AGENTS.md)`
      );
    }
  }

  // `lint` per paket harus oxlint — bukan eslint/tsc yang menyamar sebagai lint.
  for (const dir of ['web', 'server', 'marketing', 'packages/shared']) {
    const pkg = readJson(`${dir}/package.json`);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    assert.equal(scripts.lint, 'oxlint src', `${dir}/package.json → scripts.lint harus "oxlint src"`);
  }

  // Root hanya meneruskan ke paket (`pnpm -r … run lint`); yang penting ia tidak
  // memanggil linter lain.
  const rootScripts = (readJson('package.json').scripts ?? {}) as Record<string, string>;
  assert.match(rootScripts.lint ?? '', /run lint/, 'root `lint` harus meneruskan ke paket');
  assert.doesNotMatch(rootScripts.lint ?? '', /eslint/, 'root `lint` tidak boleh memanggil ESLint');
});

test('oxlint satu-satunya linter: tidak ada direktif `eslint-disable` yang menggantung', () => {
  // Hanya `eslint-disable` yang dicari (bukan `oxlint-disable`): sintaks oxlint
  // tetap sah dan memang dipakai di `server/src/utils/logger.ts`.
  const offenders: string[] = [];

  const walk = (absolute: string, relative: string) => {
    for (const entry of readdirSync(absolute)) {
      const childAbsolute = path.join(absolute, entry);
      const childRelative = `${relative}/${entry}`;
      if (statSync(childAbsolute).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        walk(childAbsolute, childRelative);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue;

      const source = readFileSync(childAbsolute, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/eslint-disable/.test(line)) offenders.push(`${childRelative}:${index + 1}`);
      });
    }
  };

  for (const dir of SOURCE_DIRS) {
    const absolute = path.join(repo, dir);
    if (existsSync(absolute)) walk(absolute, dir);
  }

  assert.deepEqual(
    offenders,
    [],
    'direktif `eslint-disable` tidak lagi diproses sebagai konfigurasi yang sah; ' +
    'pakai `// oxlint-disable-next-line <rule>` tepat di atas baris kode'
  );
});

test('oxlint satu-satunya linter: .gitignore tidak lagi menyebut cache ESLint', () => {
  for (const ignore of ['web/.gitignore', 'marketing/.gitignore', '.gitignore']) {
    if (!existsSync(path.join(repo, ignore))) continue;
    const content = readFileSync(path.join(repo, ignore), 'utf8');
    assert.doesNotMatch(content, /eslintcache/, `${ignore} masih menyebut .eslintcache (oxlint tidak menulis cache itu)`);
  }
});
