// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [audit F-02/F-04] Kontrak `deploy.yml` diuji dari sumbernya.
 *
 * Dua kegagalan yang pernah terjadi dan mudah terulang karena tidak ada yang
 * membacanya:
 *   1. `NODE_ENV` tidak pernah `production` → cookie tanpa `Secure`, CSP dev,
 *      access log morgan mencetak URL+query.
 *   2. `prisma db push || true` → deploy hijau dengan skema DB lama (kolom
 *      wajib baru hilang, discovery grup mati setelah rilis).
 *
 * Test ini murni membaca berkas (tanpa DB/Redis), jadi aman di unit suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deploy = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('deploy: pm2 menjalankan API dengan NODE_ENV=production', () => {
  assert.match(
    deploy,
    /NODE_ENV=production pm2 start/,
    'tanpa NODE_ENV=production, cookie sesi kehilangan Secure dan CSP produksi tidak aktif'
  );
});

test('deploy: guard rahasia produksi berjalan sebelum pm2 delete', () => {
  const guard = deploy.indexOf('Verifikasi rahasia produksi');
  const del = deploy.indexOf('pm2 delete nyx-api');
  assert.ok(guard > 0, 'langkah verifikasi rahasia produksi hilang');
  assert.ok(del > guard, 'verifikasi harus SEBELUM proses lama dihapus, kalau tidak layanan mati saat guard gagal');
  assert.match(deploy, /JWT_SECRET kosong\/placeholder/, 'pesan kegagalan JWT_SECRET harus menyebut penyebabnya');
});

test('deploy: prisma db push tidak menelan kegagalan', () => {
  assert.doesNotMatch(deploy, /prisma db push \|\| true/, '`|| true` membuat deploy hijau dengan skema DB lama');
  assert.match(deploy, /if ! PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=.*prisma db push; then/, 'push harus fail-closed');
});

test('deploy: verifikasi kolom wajib setelah push', () => {
  assert.match(deploy, /nyx-verify-schema\.mjs/, 'verifikasi information_schema hilang');
  for (const needle of ['UserHiddenConversation', 'tokenHash', 'adminSecretHash', 'GroupMailboxItem']) {
    assert.ok(deploy.includes(needle), `verifikasi skema harus memeriksa ${needle}`);
  }
});

test('deploy: action pemegang kunci SSH tidak memakai ref bergerak', () => {
  assert.doesNotMatch(deploy, /uses:\s*'?appleboy\/(ssh|scp)-action@(master|main)/, 'pin ke SHA, bukan master');
  assert.match(deploy, /appleboy\/ssh-action@[0-9a-f]{40}/);
  assert.match(deploy, /appleboy\/scp-action@[0-9a-f]{40}/);
});

test('deploy: permission token minimum', () => {
  assert.match(deploy, /^permissions:\n  contents: read$/m, 'job deploy tidak butuh izin tulis GITHUB');
});
