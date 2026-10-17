#!/usr/bin/env node
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Alat bantu root attestation (tanpa dependensi).
 *
 * Attestation perangkat nyata (TPM/Windows Hello, Android Key Attestation,
 * packed YubiKey, `apple`) sering mengirim `x5c` hanya leaf + intermediate;
 * root-nya hidup di trust store vendor. Server butuh **sertifikat root**, bukan
 * cuma fingerprint, untuk membangun jalur (`ABUSE_ATTESTATION_ROOTS_FILE`).
 *
 * Perintah:
 *   node scripts/attestation-roots.mjs inspect <cert.pem|cert.der> [...]
 *   node scripts/attestation-roots.mjs bundle --out ops/attestation/roots.pem \
 *     <cert.pem|cert.der> [...]
 *
 * `inspect` mencetak subject + SHA-256 fingerprint (format yang dipakai
 * `ABUSE_ATTESTATION_ROOTS`). `bundle` menormalkan semua input menjadi satu
 * berkas PEM, membuang duplikat berdasarkan fingerprint, dan menolak sertifikat
 * yang bukan CA (root attestation harus `basicConstraints=CA:TRUE`).
 *
 * Sumber root (verifikasi sendiri sebelum dipin — alat ini TIDAK memutuskan
 * siapa yang layak dipercaya):
 *   - FIDO Metadata Service: https://mds3.fidoalliance.org/ (blob JWT; entri
 *     `metadataStatement.attestationRootCertificates`)
 *   - halaman attestation root vendor (Yubico, Apple, Google, Microsoft)
 *
 * Lihat ops/attestation/README.md untuk alur lengkap dan batas keamanannya.
 */

import { X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const USAGE = `Pemakaian:
  node scripts/attestation-roots.mjs inspect <cert.pem|cert.der> [...]
  node scripts/attestation-roots.mjs bundle --out <keluaran.pem> <cert.pem|cert.der> [...]`;

/** Baca satu berkas menjadi daftar sertifikat (PEM bisa memuat banyak). */
function readCerts(path) {
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (blocks && blocks.length > 0) {
    return blocks.map((block) => new X509Certificate(block));
  }
  try {
    return [new X509Certificate(raw)];
  } catch {
    throw new Error(`${path}: bukan sertifikat PEM/DER yang bisa dibaca`);
  }
}

const fingerprint = (cert) => cert.fingerprint256.trim().toUpperCase();

function collect(paths) {
  const byFingerprint = new Map();
  for (const path of paths) {
    for (const cert of readCerts(path)) {
      byFingerprint.set(fingerprint(cert), cert);
    }
  }
  if (byFingerprint.size === 0) throw new Error('tidak ada sertifikat yang terbaca');
  return [...byFingerprint.entries()];
}

function inspect(paths) {
  for (const [fp, cert] of collect(paths)) {
    console.log(`sha256: ${fp}`);
    console.log(`  subject: ${cert.subject.replace(/\n/g, ', ')}`);
    console.log(`  issuer:  ${cert.issuer.replace(/\n/g, ', ')}`);
    console.log(`  CA:      ${cert.ca}   valid: ${cert.validFrom} .. ${cert.validTo}`);
    if (!cert.ca) {
      console.warn('  ⚠️  bukan CA — jangan dipakai sebagai root attestation');
    }
  }
}

function bundle(paths, out) {
  const entries = collect(paths);
  const nonCa = entries.filter(([, cert]) => !cert.ca);
  if (nonCa.length > 0) {
    for (const [fp, cert] of nonCa) {
      console.error(`❌ bukan CA (basicConstraints): ${fp} — ${cert.subject.replace(/\n/g, ', ')}`);
    }
    throw new Error('root attestation harus CA; perbaiki daftar input sebelum menulis bundle');
  }
  const pem = entries.map(([, cert]) => cert.toString().trim()).join('\n') + '\n';
  writeFileSync(out, pem);
  console.log(`✅ ${entries.length} root ditulis ke ${out}`);
  for (const [fp] of entries) console.log(`   ${fp}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'inspect' && rest.length > 0) {
    inspect(rest);
  } else if (command === 'bundle') {
    const outIndex = rest.indexOf('--out');
    const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;
    const inputs = rest.filter((_, index) => index !== outIndex && index !== outIndex + 1);
    if (!out || inputs.length === 0) {
      console.error(USAGE);
      process.exit(2);
    }
    bundle(inputs, out);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
