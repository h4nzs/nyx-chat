// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/43 §43.10.2] Gate i18n: setiap namespace harus punya himpunan key yang
 * sama di keempat bahasa. `i18next` hanya menulis `missingKey` ke console —
 * tanpa gate ini, key yang ditambahkan ke `en` bisa hilang di `es`/`id`/`pt-BR`
 * sampai ada pengguna yang melihat teks mentah.
 *
 * Yang dibandingkan hanya struktur key (leaf), bukan terjemahan: nilai boleh
 * berbeda, termasuk plural/format, tetapi key tidak boleh.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve(process.cwd(), 'public/locales');
const LANGUAGES = ['en', 'es', 'id', 'pt-BR'] as const;
const BASE_LANGUAGE = 'en';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function localeDir(language: string): string {
  return path.join(LOCALES_DIR, language);
}

function namespaceFiles(language: string): string[] {
  return readdirSync(localeDir(language))
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function readNamespace(language: string, namespace: string): Json {
  return JSON.parse(
    readFileSync(path.join(localeDir(language), namespace), 'utf8'),
  ) as Json;
}

function leafKeys(value: Json, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function keysFor(language: string, namespace: string): string[] {
  return leafKeys(readNamespace(language, namespace)).sort();
}

describe('paritas key locale i18n', () => {
  it('keempat bahasa memakai himpunan namespace yang sama', () => {
    const expected = namespaceFiles(BASE_LANGUAGE);
    expect(expected.length).toBeGreaterThan(0);

    for (const language of LANGUAGES) {
      expect(namespaceFiles(language), `namespace ${language}`).toEqual(expected);
      for (const namespace of expected) {
        expect(
          statSync(path.join(localeDir(language), namespace)).isFile(),
          `${language}/${namespace} harus berupa file`,
        ).toBe(true);
      }
    }
  });

  it('setiap namespace punya key yang sama persis di en, es, id, dan pt-BR', () => {
    for (const namespace of namespaceFiles(BASE_LANGUAGE)) {
      const expected = keysFor(BASE_LANGUAGE, namespace);
      expect(expected.length, `${BASE_LANGUAGE}/${namespace} tidak boleh kosong`).toBeGreaterThan(0);

      for (const language of LANGUAGES) {
        if (language === BASE_LANGUAGE) continue;
        // Pesan eksplisit: diff Vitest pada array panjang sulit dibaca tanpa
        // nama bahasa + namespace.
        expect(
          keysFor(language, namespace),
          `key ${language}/${namespace} harus sama dengan ${BASE_LANGUAGE}/${namespace}`,
        ).toEqual(expected);
      }
    }
  });
});
