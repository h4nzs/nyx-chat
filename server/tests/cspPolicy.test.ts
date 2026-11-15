// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT F-10 residual, ditutup 2026-11-01] `script-src` ketat.
 *
 * Dua hal yang dulu dijaga hanya oleh komentar:
 *  1. header CSP di `server/src/app.ts` masih memuat `'unsafe-inline'` untuk
 *     `script-src` padahal `index.html` tidak punya satu pun `<script>` inline
 *     (loader hanya `<style>`, PWA memakai `registerSW.js` eksternal dari
 *     `injectRegister: 'script-defer'`);
 *  2. CSP aplikasi di nginx masih memuat wildcard `https://*.cloudflare.com`.
 *
 * Tes ini membaca sumbernya langsung supaya keduanya tidak kembali tanpa
 * keputusan sadar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

test("app.ts: script-src tanpa 'unsafe-inline', wasm-unsafe-eval tetap ada", () => {
  const src = read('../src/app.ts');
  const start = src.indexOf('scriptSrc: [');
  const end = src.indexOf('styleSrc: [');
  assert.ok(start >= 0 && end > start, 'blok scriptSrc tidak ditemukan');

  const block = src.slice(start, end);
  assert.doesNotMatch(block, /'unsafe-inline'/, "script-src tidak boleh memuat 'unsafe-inline'");
  assert.doesNotMatch(block, /\*\.cloudflare\.com/, 'wildcard Cloudflare tidak boleh kembali');
  assert.match(block, /'wasm-unsafe-eval'/, 'libsodium WASM tetap butuh wasm-unsafe-eval');
});

test('web/index.html: tidak ada <script> inline (prasyarat CSP ketat)', () => {
  const html = read('../../web/index.html');
  // `<script>` tanpa atribut `src` = inline script → akan diblokir tanpa
  // 'unsafe-inline'. Tag dengan src eksternal aman.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'script tanpa atribut src');
  assert.match(
    html,
    /<script type="module" src="\/src\/main\.tsx"><\/script>/,
    'entry point harus tetap berupa modul eksternal'
  );
});

test('nginx: CSP aplikasi tanpa wildcard Cloudflare di script-src', () => {
  const conf = read('../../ops/nginx/nyx.conf');
  const match = conf.match(/set \$app_csp "([^"]+)"/);
  assert.ok(match, 'direktif $app_csp tidak ditemukan');
  const csp = match![1]!;

  const scriptSrc = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('script-src'));
  assert.ok(scriptSrc, 'script-src tidak ditemukan di $app_csp');
  assert.doesNotMatch(scriptSrc!, /'unsafe-inline'/, "script-src tidak boleh 'unsafe-inline'");
  assert.doesNotMatch(scriptSrc!, /\*\.cloudflare\.com/, 'wildcard Cloudflare harus dibuang');
  assert.match(scriptSrc!, /'wasm-unsafe-eval'/);
});
