// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Kesehatan bundle root attestation saat boot.
 *
 * Kenapa perlu: bundle root adalah daftar anchor yang bisa **basi tanpa satu
 * pun error**. Tiga bentuk pembusukan, semuanya diam:
 *
 *   1. `nextUpdate` FIDO MDS sudah lewat → daftar root yang dianggap sah
 *      mungkin tidak lagi lengkap, tetapi pendaftaran tetap 200 sampai ada
 *      perangkat baru yang root-nya belum ada (ditolak `root_not_trusted`);
 *   2. root kedaluwarsa masih di bundle → sertifikat itu tidak bisa
 *      memverifikasi tanda tangan baru, jadi anchor yang "ada" tetap gagal;
 *   3. bundle diganti manual tanpa metadata → tanggal `nextUpdate` dan pin
 *      rantai MDS tidak lagi menggambarkan isi berkas.
 *
 * Modul ini membaca keduanya (bundle PEM + `<bundle>.meta.json` yang ditulis
 * `scripts/attestation-roots.mjs refresh`), mengembalikan keadaan terstruktur,
 * dan menghasilkan peringatan. Ia **tidak melempar**: boot tidak boleh gagal
 * hanya karena berkas audit hilang — verifikasi rantai yang sebenarnya tetap
 * memakai `loadAttestationRootCerts()` dan sudah fail-closed di sana.
 *
 * Peringatan yang dihasilkan dipakai `index.ts` (console.warn) dan gauge
 * `nyx_attestation_roots_*` (alert `NyxAttestationRootExpired` /
 * `NyxAttestationRootBundleStale`). Logikanya murni supaya bisa diuji tanpa
 * menjalankan server.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const DAY_MS = 86_400_000;
/** Ambang "segera kedaluwarsa": cukup lebar untuk satu siklus deploy. */
const EXPIRING_SOON_DAYS = 30;

export interface AttestationRootsEnv {
  ABUSE_ATTESTATION_ROOTS_FILE?: string | undefined;
  /**
   * Jalur metadata, default `<ABUSE_ATTESTATION_ROOTS_FILE>.meta.json` — nama
   * yang sama dengan keluaran `refresh --out <bundle>`. Dipisah supaya operator
   * bisa menaruh bundle tanpa metadata (mis. hasil `bundle` manual) dan tetap
   * mendapat peringatan yang jelas, bukan serialisasi tanggal karangan.
   */
  ABUSE_ATTESTATION_ROOTS_META?: string | undefined;
}

export interface AttestationRootEntry {
  fingerprint: string;
  subject: string;
  validTo: string;
}

export interface AttestationRootsHealth {
  bundlePath: string;
  metadataPath: string;
  metadataPresent: boolean;
  /** Jumlah root yang terbaca dari bundle (0 bila berkas kosong/tidak ada). */
  certs: number;
  expired: AttestationRootEntry[];
  expiringSoon: AttestationRootEntry[];
  /** `nextUpdate` MDS apa adanya dari metadata (string ISO), bila ada. */
  nextUpdate: string | null;
  /** Nilai yang sama sebagai detik epoch; `null` bila tidak ada/tidak valid. */
  nextUpdateEpochSeconds: number | null;
  bundleSha256: string | null;
  /** `null` = metadata tidak mencatat sha (atau tidak ada metadata). */
  bundleMatchesMetadata: boolean | null;
  errors: string[];
}

interface BundleMetadata {
  schema?: unknown;
  nextUpdate?: unknown;
  bundle?: { sha256?: unknown; certs?: unknown } | undefined;
}

function resolveMetadataPath(bundlePath: string, env: AttestationRootsEnv): string {
  const explicit = (env.ABUSE_ATTESTATION_ROOTS_META ?? '').trim();
  return explicit.length > 0 ? explicit : `${bundlePath}.meta.json`;
}

function toEntry(cert: X509Certificate): AttestationRootEntry {
  return {
    fingerprint: cert.fingerprint256.trim().toUpperCase(),
    subject: cert.subject.replace(/\n/g, ', '),
    validTo: cert.validTo,
  };
}

/**
 * Baca bundle + metadata. Mengembalikan `null` bila operator memang tidak
 * memakai berkas root (baik fingerprint `ABUSE_ATTESTATION_ROOTS` saja maupun
 * attestation mati) — dalam keadaan itu tidak ada yang perlu diperingatkan.
 */
export function readAttestationRootsHealth(
  env: AttestationRootsEnv,
  now: Date = new Date()
): AttestationRootsHealth | null {
  const bundlePath = (env.ABUSE_ATTESTATION_ROOTS_FILE ?? '').trim();
  if (bundlePath.length === 0) return null;

  const metadataPath = resolveMetadataPath(bundlePath, env);
  const health: AttestationRootsHealth = {
    bundlePath,
    metadataPath,
    metadataPresent: false,
    certs: 0,
    expired: [],
    expiringSoon: [],
    nextUpdate: null,
    nextUpdateEpochSeconds: null,
    bundleSha256: null,
    bundleMatchesMetadata: null,
    errors: [],
  };

  let pem = '';
  try {
    pem = readFileSync(bundlePath, 'utf8');
  } catch (error) {
    health.errors.push(
      `bundle root tidak bisa dibaca (${bundlePath}): ${(error as Error).message}`
    );
    return health;
  }

  health.bundleSha256 = createHash('sha256').update(pem).digest('hex');
  const blocks = pem.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) {
    health.errors.push(
      `bundle root tidak memuat sertifikat PEM (${bundlePath}); pendaftaran dengan attestation rantai akan gagal 500 sampai berkas diperbaiki.`
    );
    return health;
  }

  for (const block of blocks) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch (error) {
      health.errors.push(`sertifikat di bundle tidak bisa dibaca: ${(error as Error).message}`);
      continue;
    }
    health.certs += 1;
    const validTo = new Date(cert.validTo);
    if (Number.isNaN(validTo.getTime())) continue;
    const remainingMs = validTo.getTime() - now.getTime();
    if (remainingMs <= 0) {
      health.expired.push(toEntry(cert));
    } else if (remainingMs <= EXPIRING_SOON_DAYS * DAY_MS) {
      health.expiringSoon.push(toEntry(cert));
    }
  }

  let rawMetadata: string;
  try {
    rawMetadata = readFileSync(metadataPath, 'utf8');
  } catch {
    return health;
  }
  health.metadataPresent = true;

  let metadata: BundleMetadata;
  try {
    metadata = JSON.parse(rawMetadata) as BundleMetadata;
  } catch {
    health.errors.push(`metadata bundle bukan JSON yang sah (${metadataPath}); tanggal nextUpdate tidak bisa diperiksa.`);
    return health;
  }

  if (typeof metadata.nextUpdate === 'string' && metadata.nextUpdate.length > 0) {
    const parsed = new Date(metadata.nextUpdate);
    if (Number.isNaN(parsed.getTime())) {
      health.errors.push(`nextUpdate di metadata tidak bisa dibaca sebagai tanggal: ${metadata.nextUpdate}`);
    } else {
      health.nextUpdate = metadata.nextUpdate;
      health.nextUpdateEpochSeconds = Math.floor(parsed.getTime() / 1000);
    }
  }

  const recordedSha = typeof metadata.bundle?.sha256 === 'string' ? metadata.bundle.sha256 : null;
  if (recordedSha) health.bundleMatchesMetadata = recordedSha === health.bundleSha256;

  return health;
}

/**
 * Peringatan boot, urut dari yang paling mendesak. Dikembalikan sebagai string
 * supaya isinya bisa diuji persis dan dipanggil dari `index.ts` tanpa efek
 * samping tambahan.
 */
export function attestationRootsWarnings(
  health: AttestationRootsHealth,
  now: Date = new Date()
): string[] {
  const warnings: string[] = [...health.errors];

  if (health.expired.length > 0) {
    const sample = health.expired[0];
    warnings.push(
      `Bundle root attestation memuat ${health.expired.length} sertifikat KEDALUWARSA (mis. ${sample?.subject ?? '?'} — valid sampai ${sample?.validTo ?? '?'}). Sertifikat itu tidak bisa memverifikasi rantai baru: jalankan \`node scripts/attestation-roots.mjs refresh --out ${health.bundlePath}\` lalu restart nyx-api.`
    );
  }
  if (health.expiringSoon.length > 0) {
    const sample = health.expiringSoon[0];
    warnings.push(
      `Bundle root attestation memuat ${health.expiringSoon.length} sertifikat yang kedaluwarsa dalam ${EXPIRING_SOON_DAYS} hari (paling cepat ${sample?.validTo ?? '?'}). Segarkan bundle sebelum tanggal itu — root kedaluwarsa menyebabkan penolakan attestation tanpa error server.`
    );
  }

  if (!health.metadataPresent) {
    warnings.push(
      `Metadata bundle root tidak ada (${health.metadataPath}): tanggal nextUpdate MDS TIDAK bisa diperiksa, jadi bundle bisa basi berbulan-bulan tanpa terlihat. Jalankan \`node scripts/attestation-roots.mjs refresh\`.`
    );
  } else if (health.nextUpdateEpochSeconds !== null) {
    // `Math.round`, bukan `floor`: pesan ini dibaca manusia ("21 hari lalu"),
    // dan `floor` pada selisih negatif membulatkan MENJAUH dari nol sehingga
    // tanggal yang baru lewat beberapa detik dilaporkan "1 hari lalu".
    const days = Math.round((health.nextUpdateEpochSeconds * 1000 - now.getTime()) / DAY_MS);
    if (days < 0) {
      warnings.push(
        `Bundle root attestation melewati nextUpdate MDS (${health.nextUpdate}, ${Math.abs(days)} hari lalu). Daftar root mungkin tidak lagi lengkap: jalankan \`node scripts/attestation-roots.mjs refresh --out ${health.bundlePath}\` — perangkat baru bisa ditolak reason=root_not_trusted.`
      );
    } else if (days <= EXPIRING_SOON_DAYS) {
      warnings.push(
        `nextUpdate MDS tinggal ${days} hari lagi (${health.nextUpdate}). Jadwalkan \`node scripts/attestation-roots.mjs refresh --out ${health.bundlePath}\` sebelum tanggal itu.`
      );
    }
  } else if (health.metadataPresent && health.nextUpdate === null) {
    warnings.push(
      `Metadata bundle (${health.metadataPath}) tidak memuat nextUpdate MDS: bundle disegarkan tanpa sumber MDS atau metadata lama. Jalankan \`refresh\` agar tanggal kedaluwarsa daftar root bisa dipantau.`
    );
  }

  if (health.bundleMatchesMetadata === false) {
    warnings.push(
      `Isi bundle root berbeda dari sha256 di metadata (${health.bundlePath}): nextUpdate dan pin rantai MDS di metadata TIDAK menggambarkan berkas ini. Jalankan \`refresh\` ulang, jangan mengganti bundle secara manual.`
    );
  }

  return warnings;
}
