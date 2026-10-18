// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Peringatan boot untuk bundle root attestation.
 *
 * Yang diuji di sini adalah bagian yang justru mahal bila salah: bundle yang
 * basi TIDAK menghasilkan error apa pun di runtime — satu-satunya jejaknya
 * adalah peringatan boot dan gauge. Karena itu tanggal `nextUpdate`, sha256 yang
 * tidak cocok, dan root kedaluwarsa diuji sebagai perilaku, bukan diasumsikan.
 *
 * Root fixture (`tests/fixtures/webauthn/root-ca.der`) dipakai apa adanya; tidak
 * ada sertifikat yang dibangkitkan di sini supaya tes tidak butuh `openssl`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attestationRootsWarnings,
  readAttestationRootsHealth,
  type AttestationRootsHealth,
} from '../src/utils/attestationRootsHealth.js';

const ROOT_DER = readFileSync(join('tests', 'fixtures', 'webauthn', 'root-ca.der'));
const ROOT_PEM = new X509Certificate(ROOT_DER).toString();
const ROOT_SHA256 = createHash('sha256').update(ROOT_PEM).digest('hex');
const ROOT_VALID_TO = new X509Certificate(ROOT_DER).validTo;

function withBundle(meta: unknown | null, run: (paths: { bundle: string; meta: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-roots-health-'));
  try {
    const bundle = join(dir, 'roots.pem');
    const metaPath = join(dir, 'roots.pem.meta.json');
    writeFileSync(bundle, ROOT_PEM);
    if (meta !== null) writeFileSync(metaPath, JSON.stringify(meta));
    run({ bundle, meta: metaPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const healthyMeta = (nextUpdate: string) => ({
  schema: 'nyx-attestation-roots/1',
  nextUpdate,
  bundle: { sha256: ROOT_SHA256, certs: 1 },
});

test('readAttestationRootsHealth: null bila operator tidak memakai berkas root', () => {
  assert.equal(readAttestationRootsHealth({}), null);
  assert.equal(readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS: 'AA:BB' }), null);
});

test('readAttestationRootsHealth: bundle + metadata sehat menghasilkan nol peringatan', () => {
  const nextUpdate = new Date(Date.now() + 180 * 86_400_000).toISOString();
  withBundle(healthyMeta(nextUpdate), ({ bundle, meta }) => {
    const health = readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS_FILE: bundle });
    assert.ok(health);
    assert.equal(health.metadataPath, meta);
    assert.equal(health.metadataPresent, true);
    assert.equal(health.certs, 1);
    assert.equal(health.bundleMatchesMetadata, true);
    assert.equal(health.expired.length, 0);
    assert.equal(health.expiringSoon.length, 0);
    assert.equal(health.nextUpdate, nextUpdate);
    assert.equal(health.nextUpdateEpochSeconds, Math.floor(new Date(nextUpdate).getTime() / 1000));

    assert.deepEqual(attestationRootsWarnings(health), []);
  });
});

test('readAttestationRootsHealth: metadata di jalur lain lewat ABUSE_ATTESTATION_ROOTS_META', () => {
  const nextUpdate = new Date(Date.now() + 90 * 86_400_000).toISOString();
  withBundle(healthyMeta(nextUpdate), ({ bundle, meta }) => {
    const renamed = `${meta}.custom`;
    writeFileSync(renamed, readFileSync(meta));
    const health = readAttestationRootsHealth({
      ABUSE_ATTESTATION_ROOTS_FILE: bundle,
      ABUSE_ATTESTATION_ROOTS_META: renamed,
    });
    assert.ok(health);
    assert.equal(health.metadataPath, renamed);
    assert.equal(health.certs, 1);
  });
});

test('peringatan: nextUpdate MDS sudah lewat', () => {
  const past = new Date(Date.now() - 21 * 86_400_000).toISOString();
  withBundle(healthyMeta(past), ({ bundle }) => {
    const health = readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS_FILE: bundle });
    assert.ok(health);
    const warnings = attestationRootsWarnings(health);
    const warning = warnings.find((w) => w.includes('melewati nextUpdate MDS'));
    assert.ok(warning, `peringatan nextUpdate tidak ada: ${warnings.join(' | ')}`);
    // Pesan harus menyebut perintah perbaikan, bukan sekadar "basi".
    assert.match(warning, /attestation-roots\.mjs refresh/);
    assert.match(warning, /21 hari lalu/);
  });
});

test('peringatan: nextUpdate tinggal beberapa hari', () => {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  withBundle(healthyMeta(soon), ({ bundle }) => {
    const health = readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS_FILE: bundle });
    assert.ok(health);
    assert.ok(attestationRootsWarnings(health).some((w) => w.includes('nextUpdate MDS tinggal 5 hari')));
  });
});

test('peringatan: metadata tidak ada', () => {
  withBundle(null, ({ bundle }) => {
    const health = readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS_FILE: bundle });
    assert.ok(health);
    assert.equal(health.metadataPresent, false);
    assert.equal(health.certs, 1);
    assert.ok(attestationRootsWarnings(health).some((w) => w.includes('Metadata bundle root tidak ada')));
  });
});

test('peringatan: bundle diganti manual (sha256 tidak cocok dengan metadata)', () => {
  withBundle(
    { schema: 'nyx-attestation-roots/1', nextUpdate: new Date(Date.now() + 60 * 86_400_000).toISOString(), bundle: { sha256: 'deadbeef' } },
    ({ bundle }) => {
      const health = readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS_FILE: bundle });
      assert.ok(health);
      assert.equal(health.bundleMatchesMetadata, false);
      assert.ok(attestationRootsWarnings(health).some((w) => w.includes('berbeda dari sha256 di metadata')));
    }
  );
});

test('peringatan: root kedaluwarsa dan yang akan kedaluwarsa', () => {
  const health: AttestationRootsHealth = {
    bundlePath: '/srv/nyx/roots.pem',
    metadataPath: '/srv/nyx/roots.pem.meta.json',
    metadataPresent: true,
    certs: 2,
    expired: [{ fingerprint: 'AA', subject: 'CN=Old Root', validTo: ROOT_VALID_TO }],
    expiringSoon: [{ fingerprint: 'BB', subject: 'CN=Almost Gone', validTo: ROOT_VALID_TO }],
    nextUpdate: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    nextUpdateEpochSeconds: Math.floor((Date.now() + 90 * 86_400_000) / 1000),
    bundleSha256: 'x',
    bundleMatchesMetadata: true,
    errors: [],
  };
  const warnings = attestationRootsWarnings(health);
  assert.ok(warnings.some((w) => w.includes('1 sertifikat KEDALUWARSA')), warnings.join(' | '));
  assert.ok(warnings.some((w) => w.includes('kedaluwarsa dalam 30 hari')), warnings.join(' | '));
});

test('readAttestationRootsHealth: berkas tidak ada dilaporkan sebagai error, bukan lempar', () => {
  const health = readAttestationRootsHealth({
    ABUSE_ATTESTATION_ROOTS_FILE: join(tmpdir(), 'nyx-roots-tidak-ada.pem'),
  });
  assert.ok(health);
  assert.equal(health.certs, 0);
  assert.ok(health.errors[0]?.includes('tidak bisa dibaca'));
  assert.ok(attestationRootsWarnings(health).length > 0);
});

test('readAttestationRootsHealth: metadata rusak dilaporkan, bundle tetap dibaca', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-roots-health-'));
  try {
    const bundle = join(dir, 'roots.pem');
    writeFileSync(bundle, ROOT_PEM);
    writeFileSync(`${bundle}.meta.json`, '{bukan json');
    const health = readAttestationRootsHealth({ ABUSE_ATTESTATION_ROOTS_FILE: bundle });
    assert.ok(health);
    assert.equal(health.certs, 1);
    assert.equal(health.metadataPresent, true);
    assert.ok(health.errors.some((error) => error.includes('bukan JSON yang sah')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
