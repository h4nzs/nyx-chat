/**
 * [R11 2026-10-15] Uji isyarat keadaan guard anti-abuse saat boot.
 *
 * Yang sedang dilindungi di sini bukan fitur, melainkan **cara kehilangan
 * perlindungan tanpa disadari**: `ABUSE_REGISTRATION_GUARD`/
 * `ABUSE_REQUIRE_ATTESTATION` default-nya `off`, jadi deployment produksi yang
 * lupa menyalakannya tidak menghasilkan satu pun error. Test ini mengunci
 * kombinasi env → gauge + peringatan, termasuk nilai env yang TIDAK dikenali
 * (harus diperlakukan `off`, bukan diam-diam "on").
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { abuseGuardStates, startupWarnings } from '../src/utils/startupSignals.js';

test('abuseGuardStates: on → 1, off/kosong/nilai tak dikenal → 0', () => {
  const on = abuseGuardStates({ ABUSE_REGISTRATION_GUARD: 'on', ABUSE_REQUIRE_ATTESTATION: 'on' });
  assert.deepEqual(on, [
    { guard: 'registration', enabled: 1, mode: 'on' },
    { guard: 'attestation', enabled: 1, mode: 'on' },
  ]);

  const off = abuseGuardStates({});
  assert.deepEqual(off, [
    { guard: 'registration', enabled: 0, mode: 'off' },
    { guard: 'attestation', enabled: 0, mode: 'off' },
  ]);

  // Nilai tak dikenal jangan "kebetulan" dianggap menyala.
  const bogus = abuseGuardStates({ ABUSE_REGISTRATION_GUARD: 'YES-REALLY' });
  assert.equal(bogus[0]?.enabled, 0);
});

test('abuseGuardStates: mode shadow dihitung 0 (mengukur, tapi TIDAK menahan)', () => {
  const states = abuseGuardStates({ ABUSE_REGISTRATION_GUARD: 'shadow' });
  assert.deepEqual(states[0], { guard: 'registration', enabled: 0, mode: 'shadow' });
});

test('abuseGuardStates: nilai env berspasi/kapital dinormalkan', () => {
  const states = abuseGuardStates({ ABUSE_REGISTRATION_GUARD: ' ON ', ABUSE_REQUIRE_ATTESTATION: 'ON' });
  assert.equal(states[0]?.enabled, 1);
  assert.equal(states[1]?.enabled, 1);
});

test('startupWarnings: di production, guard off & attestation off diperingatkan', () => {
  const warnings = startupWarnings({ NODE_ENV: 'production', CHAT_SECRET: 'x' });
  assert.equal(warnings.some((w) => w.includes('ABUSE_REGISTRATION_GUARD tidak menyala di production')), true);
  assert.equal(warnings.some((w) => w.includes('ABUSE_REQUIRE_ATTESTATION tidak menyala di production')), true);
});

test('startupWarnings: shadow diperingatkan sebagai belum menahan siapa pun', () => {
  const warnings = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'shadow',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    CHAT_SECRET: 'x',
  });
  assert.equal(warnings.some((w) => w.includes('shadow: guard hanya MENGUKUR')), true);
  assert.equal(warnings.some((w) => w.includes('ABUSE_REQUIRE_ATTESTATION tidak menyala')), false);
});

test('startupWarnings: nilai env tak dikenal dilaporkan sebagai env cacat', () => {
  const warnings = startupWarnings({ ABUSE_REGISTRATION_GUARD: 'aktif' });
  assert.equal(warnings.some((w) => w.includes('bukan nilai yang dikenali')), true);
});

test('startupWarnings: di dev tidak berisik soal guard, tapi tetap soal rahasia cleanup', () => {
  const warnings = startupWarnings({ NODE_ENV: 'development' });
  assert.equal(warnings.some((w) => w.includes('tidak menyala di production')), false);
  // Rahasia cleanup kosong = endpoint selalu 403 → itu masalah di environment
  // mana pun, jadi peringatannya tidak digerbang NODE_ENV.
  assert.equal(warnings.some((w) => w.includes('SELALU menolak')), true);
});

test('startupWarnings: konfigurasi lengkap → tanpa peringatan', () => {
  const warnings = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'on',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'off',
    ABUSE_ATTESTATION_ROOTS_FILE: '/etc/nyx/attestation-roots.pem',
    ADMIN_CLEANUP_SECRET: 'khusus',
    ADMIN_CLEANUP_IP_ALLOWLIST: '10.0.0.1',
    CHAT_SECRET: 'umum',
  });
  assert.deepEqual(warnings, []);
});

test('startupWarnings: attestation ketat tanpa root dipin diperingatkan (perangkat nyata akan ditolak)', () => {
  const warnings = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'on',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'off',
    ADMIN_CLEANUP_SECRET: 'khusus',
    ADMIN_CLEANUP_IP_ALLOWLIST: '10.0.0.1',
    CHAT_SECRET: 'umum',
  });
  assert.equal(warnings.some((w) => w.includes('belum ada root yang dipin')), true);

  // Fingerprint saja tetap dianggap "ada pin" (cukup untuk root yang ikut di
  // x5c / sertifikat self-signed yang dipin persis); keterbatasannya untuk
  // jalur tanpa root dijelaskan di ops/attestation/README.md, bukan diperingatkan
  // sebagai konfigurasi kosong.
  const fpOnly = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'on',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'off',
    ABUSE_ATTESTATION_ROOTS: 'AA:BB:CC:DD',
    ADMIN_CLEANUP_SECRET: 'khusus',
    ADMIN_CLEANUP_IP_ALLOWLIST: '10.0.0.1',
    CHAT_SECRET: 'umum',
  });
  assert.equal(fpOnly.some((w) => w.includes('belum ada root yang dipin')), false);
});

test('startupWarnings: ALLOW_NONE diperingatkan sebagai gerbang tanpa bukti perangkat', () => {
  const warnings = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'on',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'off',
    ABUSE_ATTESTATION_ALLOW_NONE: 'on',
    ABUSE_ATTESTATION_ROOTS_FILE: '/etc/nyx/attestation-roots.pem',
    ADMIN_CLEANUP_SECRET: 'khusus',
    ADMIN_CLEANUP_IP_ALLOWLIST: '10.0.0.1',
    CHAT_SECRET: 'umum',
  });

  assert.equal(warnings.some((w) => w.includes('ABUSE_ATTESTATION_ALLOW_NONE=on')), true);
  // Peringatan ini tidak boleh menutupi/memicu peringatan rantai: root sudah dipin
  // dan verifikasi rantai tetap menyala, yang dilonggarkan hanya tier `none`.
  assert.equal(warnings.some((w) => w.includes('belum ada root yang dipin')), false);
  assert.equal(warnings.some((w) => w.includes('DIMATIKAN')), false);
});

test('startupWarnings: ALLOW_UNATTESTED diperingatkan (akun tanpa bukti, sandbox tetap aktif)', () => {
  const warnings = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'on',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'off',
    ABUSE_ATTESTATION_ALLOW_UNATTESTED: 'on',
    ABUSE_ATTESTATION_ROOTS_FILE: '/etc/nyx/attestation-roots.pem',
    ADMIN_CLEANUP_SECRET: 'khusus',
    ADMIN_CLEANUP_IP_ALLOWLIST: '10.0.0.1',
    CHAT_SECRET: 'umum',
  });

  assert.equal(warnings.some((w) => w.includes('ABUSE_ATTESTATION_ALLOW_UNATTESTED=on')), true);
  assert.equal(warnings.some((w) => w.includes('isVerified=false')), true);
});

test('startupWarnings: verifikasi rantai yang dimatikan diperingatkan sebagai lubang keamanan', () => {
  const warnings = startupWarnings({
    NODE_ENV: 'production',
    ABUSE_REGISTRATION_GUARD: 'on',
    ABUSE_REQUIRE_ATTESTATION: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'on',
    ADMIN_CLEANUP_SECRET: 'khusus',
    ADMIN_CLEANUP_IP_ALLOWLIST: '10.0.0.1',
    CHAT_SECRET: 'umum',
  });
  assert.equal(warnings.some((w) => w.includes('verifikasi rantai attestation DIMATIKAN')), true);
  assert.equal(warnings.some((w) => w.includes('belum ada root yang dipin')), false);
});
