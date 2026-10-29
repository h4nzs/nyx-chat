// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit F-13] `.env.example` harus memuat env yang dibaca kode untuk fitur
 * keamanan/privasi. Drift di sini tidak membuat test lain merah, tetapi membuat
 * operator men-deploy tanpa nilai yang wajib — lalu fiturnya diam-diam mati
 * atau boot gagal tanpa petunjuk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

const REQUIRED = [
  'JWT_SECRET',
  'CSRF_SECRET',
  'COOKIE_DOMAIN',
  'NYX_AT_REST_PEPPER',
  // OHTTP (docs/37 §37.4 P7, docs/10 §10.18)
  'OHTTP_ENABLED',
  'OHTTP_PRIVATE_KEY',
  'OHTTP_PUBLIC_KEY',
  'OHTTP_TOKEN_MODE',
  'OHTTP_INTERNAL_TOKEN',
  'OHTTP_GATEWAY_TARGET',
  'OHTTP_GATEWAY_TRUSTED_HOSTS',
  // Privacy Pass (docs/37 §37.3.3)
  'PP_ISSUER_PRIVATE_JWK',
  'PP_SYNC_REQUIRED',
  // Credential (fail-closed allowlist; suite kosong di build ini)
  'CREDENTIAL_SUITE_ALLOWLIST',
  // Arsip riwayat perangkat hasil link (docs/40) — kill switch operator.
  'LINK_HISTORY_ENABLED',
  // KT + PIR
  'KT_QUERY_URL',
  'KT_SNAPSHOT_DIR',
  'PIR_ADMIN_TOKEN',
];

test('.env.example memuat env yang dipakai fitur keamanan', () => {
  const missing = REQUIRED.filter((name) => !new RegExp(`^${name}=`, 'm').test(example));
  assert.deepEqual(missing, [], `env belum terdokumentasi di .env.example: ${missing.join(', ')}`);
});

test('.env.example memakai placeholder, bukan nilai rahasia asli', () => {
  // Nilai yang boleh ada: kosong, URL lokal, angka, boolean, path, atau
  // placeholder eksplisit (mengandung YOUR / * / changeme). Yang ditolak adalah
  // nilai acak panjang yang tampak seperti kunci sungguhan.
  const looksReal = (value: string): boolean => {
    if (!value) return false;
    if (/YOUR|changeme|CHANGE_ME|\*|example|\.\.\./i.test(value)) return false;
    if (/^(https?:\/\/|redis:\/\/|wss?:\/\/|postgres(ql)?:\/\/|localhost|127\.0\.0\.1|[0-9]+$|true$|false$|\.?\/|\.nyx-app)/i.test(value)) return false;
    return /^[A-Za-z0-9+/_-]{32,}$/.test(value);
  };
  const suspicious = example
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .filter((line) => looksReal(line.slice(line.indexOf('=') + 1).trim()));
  assert.deepEqual(suspicious, [], `kemungkinan rahasia asli di .env.example: ${suspicious.join(', ')}`);
});
