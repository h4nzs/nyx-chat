// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Guard burst registrasi — diuji sebagai perilaku dengan
 * counter palsu (tanpa Redis/Postgres).
 *
 * Properti yang dikunci:
 *   1. Di bawah batas → diizinkan; melewati batas sumber/instalasi/ASN → 429
 *      dengan alasan yang tepat.
 *   2. Batas ASN **inklusif**: akun ke-100 dari satu ASN dalam satu jam ditahan
 *      (kriteria penerimaan §30.12).
 *   3. Heuristik sybil hanya **mewajibkan attestation**, tidak memblokir.
 *   4. Jaringan ber-NAT besar yang tersebar tidak memicu apa pun (false positive).
 *   5. Counter `NaN` (Redis error) = fail-open.
 *   6. Key counter tidak memuat IP / installation id / ASN mentah (docs/28).
 *   7. `enabled=false` → benar-benar no-op.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REGISTRATION_BURST_WINDOW_SECONDS,
  REGISTRATION_MAX_PER_ASN,
  REGISTRATION_MAX_PER_INSTALLATION,
  REGISTRATION_MAX_PER_SOURCE,
  REGISTRATION_SYBIL_BURST_MAX_PER_ASN,
  REGISTRATION_SYBIL_WINDOW_SECONDS,
  evaluateRegistrationBurst,
  makeRegistrationGuard,
  registrationAsnBurstKey,
  registrationAsnKey,
  registrationInstallationKey,
  registrationSourceKey,
} from '../src/utils/registrationGuard.js';

const base = { sourceCount: 1, installationCount: 1, asnCount: 1, asnBurstCount: 1 };

test('evaluateRegistrationBurst: batas sumber & instalasi', () => {
  assert.deepEqual(
    evaluateRegistrationBurst({ sourceCount: REGISTRATION_MAX_PER_SOURCE, installationCount: REGISTRATION_MAX_PER_INSTALLATION }),
    { allowed: true, requireAttestation: false }
  );

  const overSource = evaluateRegistrationBurst({ ...base, sourceCount: REGISTRATION_MAX_PER_SOURCE + 1 });
  assert.equal(overSource.allowed, false);
  assert.equal(overSource.reason, 'SOURCE');
  assert.equal(overSource.retryAfterSeconds, REGISTRATION_BURST_WINDOW_SECONDS);

  const overInstall = evaluateRegistrationBurst({ ...base, installationCount: REGISTRATION_MAX_PER_INSTALLATION + 1 });
  assert.equal(overInstall.allowed, false);
  assert.equal(overInstall.reason, 'INSTALLATION');

  // Tanpa installation id (null) tidak pernah memicu tingkat instalasi.
  assert.equal(evaluateRegistrationBurst({ sourceCount: 1, installationCount: null }).allowed, true);
});

test('evaluateRegistrationBurst: batas ASN inklusif (akun ke-100 ditahan)', () => {
  const below = evaluateRegistrationBurst({ ...base, asnCount: REGISTRATION_MAX_PER_ASN - 1 });
  assert.equal(below.allowed, true);

  const atLimit = evaluateRegistrationBurst({ ...base, asnCount: REGISTRATION_MAX_PER_ASN });
  assert.equal(atLimit.allowed, false, 'akun ke-100 dari satu ASN dalam 1 jam harus tertahan');
  assert.equal(atLimit.reason, 'ASN');
  assert.equal(atLimit.retryAfterSeconds, REGISTRATION_BURST_WINDOW_SECONDS);

  // ASN null (tabel tidak tersedia) → lapisan dilewati.
  assert.equal(evaluateRegistrationBurst({ ...base, asnCount: null }).allowed, true);
});

test('sybil: burst 10 menit mewajibkan attestation, bukan blokir', () => {
  const burst = evaluateRegistrationBurst({ ...base, asnCount: 40, asnBurstCount: REGISTRATION_SYBIL_BURST_MAX_PER_ASN });
  assert.deepEqual(burst, { allowed: true, requireAttestation: true });
  assert.equal(burst.allowed, true, 'heuristik tidak pernah memblokir');

  const calm = evaluateRegistrationBurst({ ...base, asnCount: 40, asnBurstCount: REGISTRATION_SYBIL_BURST_MAX_PER_ASN - 1 });
  assert.equal(calm.requireAttestation, false);

  // Blokir keras tetap menang atas sinyal sybil.
  const blocked = evaluateRegistrationBurst({ ...base, asnCount: REGISTRATION_MAX_PER_ASN, asnBurstCount: 999 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'ASN');
  assert.equal(blocked.requireAttestation, false);
});

test('NAT kantor besar: trafik tersebar tidak memicu blokir maupun attestation', () => {
  // 40 akun pagi ini dari satu jaringan kantor, tersebar sepanjang jam (burst
  // 10 menit hanya 8) dan masing-masing instalasi sendiri.
  const officeSpread = evaluateRegistrationBurst({
    sourceCount: 20, // tepat di batas per-IP (di atasnya ditahan lapisan lama)
    installationCount: 1,
    asnCount: 40,
    asnBurstCount: 8,
  });
  assert.deepEqual(officeSpread, { allowed: true, requireAttestation: false });

  // Batch sybil: 30 akun dalam 10 menit dari satu jaringan → attestation.
  const sybilBurst = evaluateRegistrationBurst({
    sourceCount: 5,
    installationCount: 1,
    asnCount: 40,
    asnBurstCount: 30,
  });
  assert.equal(sybilBurst.allowed, true);
  assert.equal(sybilBurst.requireAttestation, true);
});

test('evaluateRegistrationBurst: NaN (Redis error) fail-open', () => {
  assert.deepEqual(
    evaluateRegistrationBurst({ sourceCount: Number.NaN, installationCount: Number.NaN, asnCount: Number.NaN, asnBurstCount: Number.NaN }),
    { allowed: true, requireAttestation: false }
  );
});

test('key counter tidak memuat IP / installation id / ASN mentah', () => {
  const ip = '203.0.113.7';
  const iid = 'installation-raw-uuid-1234';
  const asn = '13335';

  const srcKey = registrationSourceKey(ip);
  assert.ok(srcKey.startsWith('regburst:src:'));
  assert.ok(!srcKey.includes(ip), 'IP mentah tidak boleh ada di key');

  const instKey = registrationInstallationKey(iid);
  assert.ok(instKey.startsWith('regburst:inst:'));
  assert.ok(!instKey.includes(iid), 'installation id mentah tidak boleh ada di key');

  const asnKey = registrationAsnKey(asn);
  const asnBurstKey = registrationAsnBurstKey(asn);
  assert.ok(asnKey.startsWith('regburst:asn:'));
  assert.ok(asnBurstKey.startsWith('regburst:asnfast:'));
  assert.ok(!asnKey.includes(asn), 'nomor ASN mentah tidak boleh ada di key');

  // Deterministik → counter tetap idempoten.
  assert.equal(registrationAsnKey(asn), asnKey);
  assert.notEqual(registrationSourceKey('203.0.113.8'), srcKey);
});

test('makeRegistrationGuard: menyentuh keempat counter dengan TTL jendelanya', async () => {
  const calls: Array<{ key: string; ttl: number }> = [];
  const incr = async (key: string, ttl: number) => {
    calls.push({ key, ttl });
    return 1;
  };
  const guard = makeRegistrationGuard(incr, true);

  const verdict = await guard({ ip: '198.51.100.1', installationId: 'iid-1', asn: '64500' });
  assert.deepEqual(verdict, { requireAttestation: false });
  assert.equal(calls.length, 4);
  const ttlOf = (prefix: string) => calls.find((c) => c.key.startsWith(prefix))?.ttl;
  assert.equal(ttlOf('regburst:src:'), REGISTRATION_BURST_WINDOW_SECONDS);
  assert.equal(ttlOf('regburst:inst:'), REGISTRATION_BURST_WINDOW_SECONDS);
  assert.equal(ttlOf('regburst:asn:'), REGISTRATION_BURST_WINDOW_SECONDS);
  assert.equal(ttlOf('regburst:asnfast:'), REGISTRATION_SYBIL_WINDOW_SECONDS);
});

test('makeRegistrationGuard: melewati batas ASN → 429 dengan alasan jaringan', async () => {
  const guard = makeRegistrationGuard(async (key) => (key.startsWith('regburst:asn:') ? REGISTRATION_MAX_PER_ASN : 1), true);
  await assert.rejects(
    () => guard({ ip: '198.51.100.1', installationId: 'iid-1', asn: '64500' }),
    (err: unknown) => {
      const e = err as { status?: number; message?: string };
      assert.equal(e.status, 429);
      assert.match(String(e.message), /REGISTRATION_BURST_LIMIT/);
      assert.match(String(e.message), /network operator/);
      return true;
    }
  );
});

test('makeRegistrationGuard: tanpa ASN tidak menyentuh counter ASN', async () => {
  const keys: string[] = [];
  const guard = makeRegistrationGuard(async (key) => {
    keys.push(key);
    return 1;
  }, true);

  await guard({ ip: '198.51.100.1', installationId: 'iid-1', asn: null });
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => !k.startsWith('regburst:asn')));
});

test('makeRegistrationGuard: enabled=false tidak menyentuh counter sama sekali', async () => {
  let touched = 0;
  const guard = makeRegistrationGuard(async () => {
    touched++;
    return 999;
  }, false);
  const verdict = await guard({ ip: '198.51.100.1', installationId: 'iid-1', asn: '13335' });
  assert.deepEqual(verdict, { requireAttestation: false });
  assert.equal(touched, 0);
});
