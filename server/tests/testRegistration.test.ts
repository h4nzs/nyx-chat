// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Test registrasi file test [backlog audit].
 *
 * Script `test` di package.json mendaftar file test EKSPLISIT (konvensi repo:
 * node:test via tsx). Konsekuensinya: file tests/*.test.ts baru yang lupa
 * didaftarkan akan DIAM-DIAM TIDAK PERNAH DIJALANKAN — CI tetap hijau padahal
 * ada test yang tidak tereksekusi. Test ini mengunci paritas dua arah:
 *   - setiap file tests/*.test.ts di disk harus tercantum di minimal satu
 *     script package.json yang memuat daftar `tests/`
 *   - setiap entri `tests/…` di script tersebut harus punya file di disk
 *
 * Jika test ini gagal setelah Anda menambah file test baru: daftarkan file-nya
 * di server/package.json (script `test` atau script test lain yang Anda pakai).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, '../package.json'), 'utf8')
) as { scripts: Record<string, string> };

/** Entri `tests/….ts` di SEMUA script package.json (union, termasuk test:ci dsb.). */
function listedTestFiles(): string[] {
  const tokens = new Set<string>();
  for (const script of Object.values(pkg.scripts)) {
    for (const token of script.split(/\s+/)) {
      if (token.startsWith('tests/')) tokens.add(token);
    }
  }
  return [...tokens].sort();
}

/** File test yang benar-benar ada di tests/. */
function actualTestFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/${f}`)
    .sort();
}

test('setiap file tests/*.test.ts di disk terdaftar di package.json', () => {
  const listed = new Set(listedTestFiles());
  const missing = actualTestFiles().filter((f) => !listed.has(f));
  assert.deepEqual(
    missing,
    [],
    'file test ada di disk tapi TIDAK terdaftar — CI tidak akan pernah menjalankannya. ' +
      'Tambahkan ke script `test` (atau script test lain) di server/package.json.'
  );
});

test('tidak ada entri basi tests/… di script package.json', () => {
  const actual = new Set(actualTestFiles());
  const stale = listedTestFiles().filter((f) => !actual.has(f));
  assert.deepEqual(
    stale,
    [],
    'script package.json mendaftar file test yang sudah tidak ada di disk — hapus entrinya.'
  );
});

test('script test dijalankan via tsx dan entri tests/ menunjuk file yang ada', () => {
  assert.match(pkg.scripts.test, /\btsx\b.*--test/, 'script `test` harus via `tsx --test`');
  // Entri harus file (bukan folder/glob): konvensi repo adalah daftar eksplisit.
  for (const entry of listedTestFiles()) {
    assert.ok(
      existsSync(path.join(here, path.basename(entry))),
      `entri ${entry} harus menunjuk file .ts yang ada di tests/`
    );
  }
});
