/**
 * [R6 2026-10-15] Uji kebijakan otorisasi `POST /api/admin/cleanup`.
 *
 * Kenapa ini penting diuji tanpa Express/DB: endpoint itu **destruktif** (dulu
 * stub tak berbahaya, sekarang benar-benar menghancurkan akun dorman). Kesalahan
 * di sini bukan bug UI — ia menghapus data. Karena itu yang diuji adalah
 * keputusan murni: siapa boleh, siapa tidak, dan bentuk konfigurasi mana yang
 * harus DITOLAK walau operator mengira sudah benar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  authorizeAdminCleanup,
  parseAdminCleanupAllowlist,
  resolveAdminCleanupSecret,
  adminCleanupConfigWarnings,
} from '../src/utils/adminCleanupAuth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(here, p), 'utf8');

test('parseAdminCleanupAllowlist: CSV di-trim, di-dedup, case-fold, entri kosong dibuang', () => {
  assert.deepEqual(parseAdminCleanupAllowlist('10.0.0.1, 127.0.0.1 ,10.0.0.1,'), ['10.0.0.1', '127.0.0.1']);
  assert.deepEqual(parseAdminCleanupAllowlist('2001:DB8::1'), ['2001:db8::1']);
  assert.deepEqual(parseAdminCleanupAllowlist('   '), []);
  assert.deepEqual(parseAdminCleanupAllowlist(undefined), []);
  assert.deepEqual(parseAdminCleanupAllowlist(null), []);
});

test('resolveAdminCleanupSecret: rahasia khusus menang, fallback dipakai bila kosong', () => {
  assert.deepEqual(
    resolveAdminCleanupSecret({ cleanupSecret: 'khusus', chatSecret: 'umum' }),
    { secret: 'khusus', dedicated: true }
  );
  // Spasi dianggap tidak diset — supaya `ADMIN_CLEANUP_SECRET=" "` di .env tidak
  // menjadi kunci yang bisa ditebak.
  assert.deepEqual(
    resolveAdminCleanupSecret({ cleanupSecret: '   ', chatSecret: 'umum' }),
    { secret: 'umum', dedicated: false }
  );
  assert.deepEqual(resolveAdminCleanupSecret({}), { secret: null, dedicated: false });
});

test('authorizeAdminCleanup: kunci benar (rahasia khusus) diterima', () => {
  const decision = authorizeAdminCleanup(
    { providedKey: 'rahasia-panjang', clientIp: '127.0.0.1' },
    { cleanupSecret: 'rahasia-panjang', chatSecret: 'lain' }
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, 'ok');
  assert.equal(decision.dedicatedSecret, true);
});

test('authorizeAdminCleanup: kunci benar (fallback CHAT_SECRET) tetap diterima', () => {
  const decision = authorizeAdminCleanup(
    { providedKey: 'chat-secret' },
    { chatSecret: 'chat-secret' }
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.dedicatedSecret, false);
});

test('authorizeAdminCleanup: TANPA rahasia apa pun → selalu tolak (fail-closed)', () => {
  for (const providedKey of ['', 'apa-saja', undefined]) {
    const decision = authorizeAdminCleanup({ providedKey }, {});
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'secret-not-configured');
  }
});

test('authorizeAdminCleanup: kunci salah / bukan string ditolak', () => {
  assert.equal(
    authorizeAdminCleanup({ providedKey: 'salah' }, { cleanupSecret: 'benar' }).reason,
    'bad-key'
  );
  assert.equal(
    authorizeAdminCleanup({ providedKey: ['benar'] }, { cleanupSecret: 'benar' }).reason,
    'bad-key'
  );
  // Prefix yang benar tapi lebih pendek TIDAK boleh lolos (bukan perbandingan prefix).
  assert.equal(
    authorizeAdminCleanup({ providedKey: 'benar' }, { cleanupSecret: 'benar-panjang' }).reason,
    'bad-key'
  );
});

test('authorizeAdminCleanup: allow-list IP ditolak walau kuncinya benar', () => {
  const env = { cleanupSecret: 'k', ipAllowlist: '10.0.0.1, 192.168.1.5' };
  assert.equal(authorizeAdminCleanup({ providedKey: 'k', clientIp: '10.0.0.1' }, env).ok, true);
  assert.equal(
    authorizeAdminCleanup({ providedKey: 'k', clientIp: '203.0.113.9' }, env).reason,
    'ip-not-allowed'
  );
  // IP tidak diketahui + allow-list aktif → tolak (jangan perlakukan "kosong" sebagai boleh).
  assert.equal(authorizeAdminCleanup({ providedKey: 'k' }, env).reason, 'ip-not-allowed');
  // Allow-list kosong = tanpa batasan (perilaku lama, tidak breaking).
  assert.equal(
    authorizeAdminCleanup({ providedKey: 'k', clientIp: '203.0.113.9' }, { cleanupSecret: 'k', ipAllowlist: '' }).ok,
    true
  );
});

test('adminCleanupConfigWarnings: menyebut risiko yang nyata, diam saat konfigurasi lengkap', () => {
  const complete = adminCleanupConfigWarnings({
    cleanupSecret: 'khusus',
    chatSecret: 'umum',
    ipAllowlist: '10.0.0.1',
    nodeEnv: 'production',
  });
  assert.deepEqual(complete, []);

  const fallback = adminCleanupConfigWarnings({ chatSecret: 'umum', nodeEnv: 'production' });
  assert.equal(fallback.some((w) => w.includes('ADMIN_CLEANUP_SECRET tidak diset')), true);
  assert.equal(fallback.some((w) => w.includes('ADMIN_CLEANUP_IP_ALLOWLIST kosong')), true);

  const noSecret = adminCleanupConfigWarnings({ nodeEnv: 'production' });
  assert.equal(noSecret.length, 1);
  assert.match(noSecret[0], /SELALU menolak/);
});

test('R6: template env (root + server) mendokumentasikan kedua variabel pengaman', () => {
  // Operator hanya membaca `.env.example`; env yang tidak ada di sana akan
  // terlewat, dan endpoint destruktif ini diam-diam jatuh ke `CHAT_SECRET`.
  for (const p of ['../.env.example', '../../.env.example']) {
    const content = read(p);
    assert.match(content, /^ADMIN_CLEANUP_SECRET=/m, `${p} harus memuat ADMIN_CLEANUP_SECRET`);
    assert.match(content, /^ADMIN_CLEANUP_IP_ALLOWLIST=/m, `${p} harus memuat ADMIN_CLEANUP_IP_ALLOWLIST`);
  }
});
