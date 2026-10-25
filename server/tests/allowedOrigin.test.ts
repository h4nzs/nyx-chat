// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [AUDIT 2026-10-24] Allowlist origin bersama (REST + gateway socket.io).
 *
 * Sebelum ini daftar yang sama ditulis dua kali; uji ini mengunci perilakunya
 * supaya penggabungan tidak diam-diam melonggarkan atau mempersempit CORS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin } from '../src/utils/allowedOrigin.js';

const prod = { corsOrigin: 'https://app.example.com', isProd: true };
const dev = { corsOrigin: 'https://app.example.com', isProd: false };

test('origin produksi NYX selalu diterima', () => {
  for (const origin of [
    'https://nyx-app.my.id',
    'https://api.nyx-app.my.id',
    'https://app.nyx-app.my.id',
    'https://rt.nyx-app.my.id',
    'https://storage.nyx-app.my.id',
  ]) {
    assert.equal(isAllowedOrigin(origin, prod), true, origin);
  }
});

test('CORS_ORIGIN tambahan diterima, origin asing ditolak', () => {
  assert.equal(isAllowedOrigin('https://app.example.com', prod), true);
  assert.equal(isAllowedOrigin('https://evil.example.org', prod), false);
});

test('localhost hanya diizinkan di luar production', () => {
  assert.equal(isAllowedOrigin('http://localhost:5173', prod), false);
  assert.equal(isAllowedOrigin('http://localhost:5173', dev), true);
  assert.equal(isAllowedOrigin('http://localhost:4173', dev), true);
});

test('wildcard pada CORS_ORIGIN hanya cocok untuk domain itu', () => {
  const opts = { corsOrigin: 'https://*.example.com', isProd: true };
  assert.equal(isAllowedOrigin('https://chat.example.com', opts), true);
  assert.equal(isAllowedOrigin('https://example.com', opts), false);
  assert.equal(isAllowedOrigin('https://chat.example.com.evil.io', opts), false);
});

test('origin kosong (tanpa header Origin) diterima', () => {
  assert.equal(isAllowedOrigin('', prod), true);
});

test('entri kosong di CORS_ORIGIN tidak menjadi wildcard', () => {
  const opts = { corsOrigin: ['', ''], isProd: true };
  assert.equal(isAllowedOrigin('https://evil.example.org', opts), false);
});
