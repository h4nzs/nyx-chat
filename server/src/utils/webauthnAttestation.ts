// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Attestation WebAuthn untuk **akun baru**.
 *
 * PoW + Turnstile membuktikan biaya komputasi, bukan perangkat. Attestation
 * menambahkan bukti bahwa kredensial dibuat oleh authenticator nyata (biasanya
 * platform: Secure Enclave / TPM / Titan), sehingga satu mesin tidak bisa
 * membuat ratusan akun tanpa biaya perangkat keras.
 *
 * Yang diverifikasi (dua lapis, tidak ada yang dilewati):
 *
 *   1. **Pustaka** `@simplewebauthn/server` memverifikasi struktur, challenge,
 *      origin, RP ID, flag user-presence/user-verification, algoritma COSE, dan
 *      **statement attestation** sesuai `fmt` (packed/tpm/apple/android-key/
 *      fido-u2f/self) — termasuk aturan bentuk sertifikat attestation
 *      (OU/O/C/CN, `basicConstraints`, versi).
 *   2. **Verifikasi rantai kami** (`verifyAttestationChain`, X.509 lewat
 *      `node:crypto`): rantai `x5c` harus tersambung tanda tangan sungguhan,
 *      masih berlaku, dan leaf bukan CA; lalu harus **berakhir di anchor yang
 *      dipercaya** — root yang dipin (ikut di `x5c` maupun tidak; bentuk nyata
 *      TPM/Apple/YubiKey berhenti di intermediate) atau, tanpa pin sama sekali,
 *      puncak self-signed dari rantai minimal dua sertifikat. **Kenapa wajib:**
 *      tanpa ini, sertifikat self-signed buatan penyerang naik ke tier
 *      "hardware" — `x5c` yang ada isinya saja tidak membuktikan perangkat apa
 *      pun.
 *   3. **Kebijakan NYX** (fungsi murni `evaluateAttestationPolicy`) menentukan
 *      apakah bukti itu cukup: format harus termasuk allowlist (default:
 *      format perangkat keras), rantai wajib terverifikasi, attestation
 *      "self" hanya bukti kepemilikan kunci (bukan perangkat), `fmt: 'tpm'`
 *      wajib ber-EKU AIK TPM, AAGUID tidak diblokir, dan authenticator tidak
 *      disinkronkan (`multiDevice`) karena akun NYX bersifat satu perangkat.
 *
 * `none` attestation (yang mengaku "tidak ada") **selalu ditolak** sebagai
 * bukti perangkat keras — itu inti dari lapisan ini.
 *
 * Challenge disimpan sekali-pakai di Redis (`attestation:chal:*`) dan
 * dihapus saat dikonsumsi, sehingga bukti tidak bisa diputar ulang untuk
 * membuat akun kedua.
 */

import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { decodeAttestationObject } from '@simplewebauthn/server/helpers';

/** Umur challenge attestation (detik). */
export const ATTESTATION_CHALLENGE_TTL_SECONDS = 600;

/**
 * EKU `id-tcg-kp-AIKCertificate` (2.23.133.8.3) — penanda bahwa sertifikat
 * attestation adalah AIK TPM. Tanpa EKU ini, `fmt: 'tpm'` tidak masuk akal:
 * pustaka memverifikasi tanda tangannya, tapi tidak memeriksa **siapa** penanda
 * tangannya. Kripto benar tanpa jaminan perangkat = tidak ada bukti perangkat.
 */
export const TPM_AIK_EKU_OID = '2.23.133.8.3';

/** Format attestation yang membawa bukti perangkat keras (bukan `none`). */
export const HARDWARE_ATTESTATION_FORMATS = ['packed', 'tpm', 'android-key', 'apple', 'fido-u2f'] as const;

export type AttestationTier = 'hardware' | 'self' | 'none' | 'unsupported';

export interface AttestationPolicy {
  /** Format yang boleh membuktikan perangkat keras. */
  allowedFormats: string[];
  /**
   * Wajibkan rantai `x5c` benar-benar bisa dipercaya: tersambung tanda tangan,
   * masih berlaku, leaf bukan CA, dan berakhir di anchor yang dipin
   * (`trustedAttestationRootCerts`/`trustedAttestationRoots`) — atau, bila
   * operator belum memin apa pun, puncak self-signed dari rantai minimal dua
   * sertifikat. Default **on**.
   *
   * Kenapa ini bukan kemewahan: tanpa pemeriksaan ini, siapa pun bisa membuat
   * sertifikat self-signed sendiri dan masuk tier "hardware" — `x5c` yang ada
   * isinya saja tidak membuktikan perangkat apa pun.
   */
  requireVerifiedChain: boolean;
  /**
   * Fingerprint SHA-256 (format `AA:BB:…`) root attestation yang dipercaya
   * operator. Kosong = cukup rantai internal yang konsisten (perilaku default:
   * NYX belum mem-vendor root FIDO/TPM, jadi root uji/pabrikan tidak dipin).
   */
  trustedAttestationRoots: string[];
  /**
   * Sertifikat root (DER) yang dipercaya, untuk **membangun jalur** `x5c` yang
   * tidak menyertakan root. Ini bentuk umum attestation nyata: TPM/Windows
   * Hello, Android Key Attestation, packed YubiKey, dan `apple` sering mengirim
   * `x5c = leaf + intermediate` saja, dengan root hidup di trust store vendor.
   *
   * Fingerprint saja tidak cukup di sini: untuk memverifikasi tanda tangan
   * sertifikat puncak kita butuh **kunci publik** root-nya, bukan hanya namanya.
   * `ABUSE_ATTESTATION_ROOTS_FILE` memuat sertifikat PEM yang mengisi daftar ini.
   */
  trustedAttestationRootCerts: Uint8Array[];
  /** Wajibkan EKU AIK TPM pada `fmt: 'tpm'` (default on). */
  requireTpmAikEku: boolean;
  /**
   * Izinkan attestation "self" (x5c tidak ada, tanda tangan memakai kunci
   * kredensial itu sendiri). Default **off**: ia membuktikan kepemilikan kunci,
   * bukan keberadaan perangkat.
   */
  allowSelfAttestation: boolean;
  /**
   * Izinkan attestation `none` (tidak ada bukti apa pun). Default **off** dan
   * hanya untuk pengujian/lingkungan tertutup: menerimanya berarti lapisan ini
   * tidak memberi jaminan perangkat sama sekali.
   */
  allowNoneAttestation: boolean;
  /** AAGUID yang diblokir (mis. authenticator yang bocor/dikompromikan). */
  blockedAaguids: string[];
  requireUserVerification: boolean;
  requireSingleDevice: boolean;
}

export const DEFAULT_ATTESTATION_POLICY: AttestationPolicy = {
  allowedFormats: [...HARDWARE_ATTESTATION_FORMATS],
  requireVerifiedChain: true,
  trustedAttestationRoots: [],
  trustedAttestationRootCerts: [],
  requireTpmAikEku: true,
  allowSelfAttestation: false,
  allowNoneAttestation: false,
  blockedAaguids: [],
  requireUserVerification: true,
  requireSingleDevice: true,
};

const listFromEnv = (raw: string | undefined, fallback: string[]): string[] => {
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
};

interface CachedRootFile {
  mtimeMs: number;
  size: number;
  certs: Uint8Array[];
}

const rootFileCache = new Map<string, CachedRootFile>();

/**
 * Baca bundle root attestation dari berkas PEM (satu atau beberapa sertifikat).
 *
 * Hasil di-cache per path + mtime supaya tidak di-parse ulang di setiap
 * pendaftaran; mengganti berkas (deploy root baru) otomatis terbaca lagi.
 * Berkas yang tidak ada / tidak berisi sertifikat **melempar** — lebih baik
 * pendaftaran gagal dengan 500 yang terlihat daripada kebijakan diam-diam
 * kehilangan anchor dan menerima rantai yang tidak dipercaya.
 */
export function loadAttestationRootCerts(file: string): Uint8Array[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch {
    throw new Error(`ABUSE_ATTESTATION_ROOTS_FILE tidak bisa dibaca: ${file}`);
  }
  const cached = rootFileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.certs;

  const pem = readFileSync(file, 'utf8');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    throw new Error(`ABUSE_ATTESTATION_ROOTS_FILE tidak memuat sertifikat PEM: ${file}`);
  }
  const certs = blocks.map((block) => new Uint8Array(new X509Certificate(block).raw));
  rootFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, certs });
  return certs;
}

/** Kebijakan dari env (operator bisa melonggarkan tanpa deploy kode). */
export function attestationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AttestationPolicy {
  const rootsFile = (env.ABUSE_ATTESTATION_ROOTS_FILE ?? '').trim();
  return {
    allowedFormats: listFromEnv(env.ABUSE_ATTESTATION_FORMATS, [...HARDWARE_ATTESTATION_FORMATS]),
    requireVerifiedChain: env.ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN !== 'on',
    trustedAttestationRoots: listFromEnv(env.ABUSE_ATTESTATION_ROOTS, []),
    trustedAttestationRootCerts: rootsFile ? loadAttestationRootCerts(rootsFile) : [],
    requireTpmAikEku: env.ABUSE_ATTESTATION_ALLOW_NO_AIK_EKU !== 'on',
    allowSelfAttestation: env.ABUSE_ATTESTATION_ALLOW_SELF === 'on',
    allowNoneAttestation: env.ABUSE_ATTESTATION_ALLOW_NONE === 'on',
    blockedAaguids: listFromEnv(env.ABUSE_ATTESTATION_BLOCKED_AAGUIDS, []),
    requireUserVerification: env.ABUSE_ATTESTATION_ALLOW_NO_UV !== 'on',
    requireSingleDevice: env.ABUSE_ATTESTATION_ALLOW_SYNCED !== 'on',
  };
}

export interface AttestationEvidence {
  fmt: string;
  aaguid: string;
  credentialDeviceType: string;
  userVerified: boolean;
  /** True bila `attStmt.x5c` ada — tanda tangan dibuat oleh sertifikat, bukan kunci kredensial. */
  hasCertificateChain: boolean;
  /** Hasil pemeriksaan rantai; `null` bila tidak ada `x5c` yang bisa dibaca. */
  certificateChain: AttestationChainEvidence | null;
}

export interface AttestationVerdict {
  accepted: boolean;
  tier: AttestationTier;
  reason?: string;
}

/** Klasifikasi bukti tanpa efek samping (mudah diuji & dipakai ulang). */
export function classifyAttestationTier(evidence: Pick<AttestationEvidence, 'fmt' | 'hasCertificateChain'>): AttestationTier {
  if (evidence.fmt === 'none') return 'none';
  if (evidence.hasCertificateChain) return 'hardware';
  return 'self';
}

/**
 * Kebijakan murni. Urutan alasan sengaja: format → tier (perangkat keras) →
 * AAGUID → user verification → single device, sehingga pesan penolakan paling
 * informatif muncul lebih dulu.
 */
export function evaluateAttestationPolicy(
  evidence: AttestationEvidence,
  policy: AttestationPolicy = DEFAULT_ATTESTATION_POLICY
): AttestationVerdict {
  const tier = classifyAttestationTier(evidence);

  // `none` diperiksa lebih dulu supaya alasannya jelas ("bukan bukti perangkat"),
  // bukan tersamar sebagai "format tidak diizinkan".
  if (tier === 'none' && !policy.allowNoneAttestation) {
    return { accepted: false, tier, reason: 'NOT_HARDWARE_ATTESTATION' };
  }
  if (!policy.allowedFormats.includes(evidence.fmt.toLowerCase())) {
    return { accepted: false, tier, reason: 'ATTESTATION_FORMAT_NOT_ALLOWED' };
  }
  if (tier === 'self' && !policy.allowSelfAttestation) {
    return { accepted: false, tier, reason: 'SELF_ATTESTATION_NOT_ALLOWED' };
  }
  // Rantai ada bukan berarti rantai bisa dipercaya. Alasan penolakan memakai
  // kode kegagalan pertama dari pemeriksaan rantai supaya operator tahu apa yang
  // harus diperbaiki (mis. sertifikat kedaluwarsa vs root tidak dipin).
  if (tier === 'hardware' && policy.requireVerifiedChain) {
    if (!evidence.certificateChain) {
      return { accepted: false, tier, reason: 'ATTESTATION_CHAIN_UNPARSEABLE' };
    }
    if (evidence.certificateChain.failures.length > 0) {
      return { accepted: false, tier, reason: evidence.certificateChain.failures[0] };
    }
  }
  if (
    policy.requireTpmAikEku &&
    evidence.fmt.toLowerCase() === 'tpm' &&
    !(evidence.certificateChain?.leafExtendedKeyUsage ?? []).includes(TPM_AIK_EKU_OID)
  ) {
    return { accepted: false, tier, reason: 'TPM_AIK_EKU_MISSING' };
  }
  if (evidence.aaguid && policy.blockedAaguids.includes(evidence.aaguid.toLowerCase())) {
    return { accepted: false, tier, reason: 'AAGUID_BLOCKED' };
  }
  if (policy.requireUserVerification && !evidence.userVerified) {
    return { accepted: false, tier, reason: 'USER_VERIFICATION_REQUIRED' };
  }
  if (policy.requireSingleDevice && evidence.credentialDeviceType !== 'singleDevice') {
    return { accepted: false, tier, reason: 'SYNCED_AUTHENTICATOR_NOT_ALLOWED' };
  }
  return { accepted: true, tier };
}

/**
 * Sertifikat dari `attStmt.x5c` (DER, urut leaf → root). `null` bila tidak ada
 * atau tidak bisa diurai. Dipisah dari `hasCertificateChain` supaya pemanggil
 * bisa memakai sertifikatnya, bukan cuma tahu keberadaannya.
 */
export function attestationChainDers(attestationObject: Uint8Array<ArrayBuffer>): Uint8Array[] | null {
  try {
    const decoded = decodeAttestationObject(attestationObject) as Map<string, unknown>;
    const attStmt = decoded.get('attStmt') as Map<string, unknown> | undefined;
    if (!attStmt || typeof attStmt.get !== 'function') return null;
    const x5c = attStmt.get('x5c');
    if (!Array.isArray(x5c) || x5c.length === 0) return null;
    const ders = x5c.map((entry) =>
      entry instanceof Uint8Array ? entry : Buffer.isBuffer(entry) ? new Uint8Array(entry) : null
    );
    if (ders.some((der) => der === null)) return null;
    return ders as Uint8Array[];
  } catch {
    return null;
  }
}

/** Apakah statement attestation membawa rantai sertifikat (`x5c`)? */
export function hasCertificateChain(attestationObject: Uint8Array<ArrayBuffer>): boolean {
  const ders = attestationChainDers(attestationObject);
  return ders !== null && ders.length > 0;
}

/**
 * Hasil pemeriksaan rantai `x5c`. `failures` kosong berarti rantai bisa
 * dipercaya menurut aturan di bawah.
 */
export interface AttestationChainEvidence {
  /** Jumlah sertifikat di `x5c`. */
  length: number;
  /** Tiap sertifikat ditandatangani sertifikat berikutnya. */
  linked: boolean;
  /** Puncak rantai menandatangani dirinya sendiri. */
  topSelfSigned: boolean;
  /** Semua sertifikat masih berlaku pada `now`. */
  withinValidity: boolean;
  /** Fingerprint SHA-256 sertifikat puncak. */
  topFingerprint: string | null;
  /** Puncak cocok dengan root yang dipin operator; `null` bila operator tidak memin apa pun. */
  pinnedRootMatch: boolean | null;
  /**
   * Bagaimana rantai mencapai anchor yang dipercaya:
   *   - `pinned-root`: puncak sama dengan root yang dipin ATAU ditandatangani
   *     root yang dipin (root tidak ikut di `x5c`) — ini bentuk perangkat nyata;
   *   - `self-signed`: tanpa pin, puncak menandatangani dirinya sendiri (mode
   *     lama; hanya membuktikan konsistensi internal, bukan identitas vendor);
   *   - `null`: tidak ada anchor.
   */
  anchoredBy: 'self-signed' | 'pinned-root' | null;
  /** EKU sertifikat daun (OID). */
  leafExtendedKeyUsage: string[];
  /** Kode kegagalan (kosong = lolos). */
  failures: string[];
}

const normalizeFingerprint = (value: string): string => value.trim().toUpperCase();

/**
 * Memeriksa rantai sertifikat attestation dengan X.509 sungguhan.
 *
 * Aturan (tiap pelanggaran menambah satu kode ke `failures`):
 *
 *   1. `CHAIN_TOO_SHORT` — rantai satu sertifikat yang **tidak** dipin: itu
 *      hanya "saya menandatangani diri saya sendiri", dan bisa dibuat siapa pun.
 *   2. `CHAIN_UNPARSEABLE` — ada DER yang tidak bisa dibaca.
 *   3. `CERTIFICATE_NOT_YET_VALID` / `CERTIFICATE_EXPIRED` — masa berlaku.
 *   4. `CHAIN_NOT_LINKED` — sertifikat ke-i tidak ditandatangani kunci sertifikat ke-(i+1).
 *   5. `LEAF_IS_CA` — leaf mengaku CA (sertifikat attestation tidak pernah begitu).
 *   6. `TOP_NOT_SELF_SIGNED` — puncak tidak self-signed **dan** operator tidak
 *      memin root yang bisa menutup jalur.
 *   7. `ROOT_NOT_TRUSTED` — operator memin root, tapi rantai tidak berakhir di
 *      salah satunya (fingerprint puncak beda dan tidak ada root yang
 *      menandatangani puncak).
 *   8. `PINNED_ROOT_UNPARSEABLE` — DER di `trustedRootCerts` bukan sertifikat.
 *
 * Jalur yang ditangani: `x5c` boleh berhenti di intermediate (bentuk umum
 * perangkat nyata) asalkan root-nya dipin lewat `trustedRootCerts`; root yang
 * ikut di `x5c` juga diterima bila fingerprint/DER-nya dipin.
 *
 * Tidak ada kripto yang ditulis ulang di sini: parsing DER, verifikasi tanda
 * tangan, basicConstraints, masa berlaku, dan fingerprint semuanya dari
 * `node:crypto` (`X509Certificate`).
 */
export function verifyAttestationChain(
  chainDers: Uint8Array[],
  options: {
    now?: Date;
    trustedRootFingerprints?: string[];
    /** Root (DER) yang boleh mengakhiri jalur walau tidak ikut di `x5c`. */
    trustedRootCerts?: Uint8Array[];
  } = {}
): AttestationChainEvidence {
  const now = options.now ?? new Date();
  const trusted = (options.trustedRootFingerprints ?? []).map(normalizeFingerprint);
  const failures: string[] = [];

  let certificates: X509Certificate[];
  try {
    certificates = chainDers.map((der) => new X509Certificate(Buffer.from(der)));
  } catch {
    return {
      length: chainDers.length,
      linked: false,
      topSelfSigned: false,
      withinValidity: false,
      topFingerprint: null,
      pinnedRootMatch: null,
      anchoredBy: null,
      leafExtendedKeyUsage: [],
      failures: ['CHAIN_UNPARSEABLE'],
    };
  }

  const pinnedCerts: X509Certificate[] = [];
  for (const der of options.trustedRootCerts ?? []) {
    try {
      pinnedCerts.push(new X509Certificate(Buffer.from(der)));
    } catch {
      failures.push('PINNED_ROOT_UNPARSEABLE');
    }
  }
  const hasPins = trusted.length > 0 || pinnedCerts.length > 0;

  const withinValidity = certificates.every((cert) => {
    const from = cert.validFromDate.getTime();
    const to = cert.validToDate.getTime();
    if (now.getTime() < from) {
      failures.push('CERTIFICATE_NOT_YET_VALID');
      return false;
    }
    if (now.getTime() > to) {
      failures.push('CERTIFICATE_EXPIRED');
      return false;
    }
    return true;
  });

  const leaf = certificates[0]!;
  if (leaf.ca) failures.push('LEAF_IS_CA');

  let linked = true;
  for (let index = 0; index < certificates.length - 1; index += 1) {
    const subject = certificates[index]!;
    const issuer = certificates[index + 1]!;
    // Dua pemeriksaan: penerbit yang menyatakan dirinya, dan tanda tangan nyata.
    if (!subject.checkIssued(issuer) || !subject.verify(issuer.publicKey)) {
      linked = false;
      failures.push('CHAIN_NOT_LINKED');
      break;
    }
  }

  const top = certificates[certificates.length - 1]!;
  let topSelfSigned: boolean;
  try {
    topSelfSigned = top.verify(top.publicKey);
  } catch {
    topSelfSigned = false;
  }
  const topFingerprint = top.fingerprint256;
  const topFingerprintNormalized = normalizeFingerprint(topFingerprint);

  // Anchor bisa berupa: (a) puncak yang persis dipin (fingerprint atau DER),
  // (b) root yang dipin MENANDATANGANI puncak — root tidak ikut di `x5c`, atau
  // (c) puncak self-signed ketika operator tidak memin apa pun (mode lama).
  const exactPin =
    hasPins &&
    (trusted.includes(topFingerprintNormalized) ||
      pinnedCerts.some((pinned) => Buffer.from(pinned.raw).equals(Buffer.from(top.raw))));
  const issuedByPinnedRoot = pinnedCerts.some(
    (pinned) => pinned.ca && top.checkIssued(pinned) && top.verify(pinned.publicKey)
  );
  // Mode lama (tanpa pin) hanya boleh mengandalkan puncak self-signed bila
  // rantainya benar-benar berisi minimal dua sertifikat. Satu sertifikat
  // self-signed tanpa pin hanyalah "saya menandatangani diri saya sendiri".
  const anchoredBy: 'self-signed' | 'pinned-root' | null =
    exactPin || issuedByPinnedRoot
      ? 'pinned-root'
      : topSelfSigned && !hasPins && certificates.length >= 2
        ? 'self-signed'
        : null;

  // Satu sertifikat hanya sah bila operator mem-pin-nya secara eksplisit (atau
  // root yang dipin menandatanganinya). Tanpa itu, "rantai" satu cert hanyalah
  // klaim yang bisa dibuat siapa pun.
  if (certificates.length < 2 && anchoredBy === null) failures.push('CHAIN_TOO_SHORT');
  if (anchoredBy === null) {
    failures.push(hasPins ? 'ROOT_NOT_TRUSTED' : 'TOP_NOT_SELF_SIGNED');
  }

  return {
    length: certificates.length,
    linked,
    topSelfSigned,
    withinValidity,
    topFingerprint,
    pinnedRootMatch: hasPins ? anchoredBy === 'pinned-root' : null,
    anchoredBy,
    leafExtendedKeyUsage: leaf.toLegacyObject().ext_key_usage ?? [],
    failures,
  };
}

export interface VerifiedAttestation {
  verified: boolean;
  tier: AttestationTier;
  reason?: string;
  aaguid: string | null;
  credentialId: string | null;
  credentialPublicKey: Uint8Array<ArrayBuffer> | null;
  counter: number;
  credentialDeviceType: string | null;
  credentialBackedUp: boolean;
}

const REJECTED: VerifiedAttestation = {
  verified: false,
  tier: 'unsupported',
  reason: 'ATTESTATION_REJECTED',
  aaguid: null,
  credentialId: null,
  credentialPublicKey: null,
  counter: 0,
  credentialDeviceType: null,
  credentialBackedUp: false,
};

/**
 * Verifikasi penuh satu respons registrasi WebAuthn sebagai bukti akun baru.
 *
 * Melempar bila responsnya tidak sah menurut pustaka (struktur/tanda tangan);
 * pemanggil memperlakukannya sebagai 403. Mengembalikan `verified: false` bila
 * responsnya valid secara kriptografis tetapi **tidak memenuhi kebijakan NYX**
 * (mis. attestation `none`) — itu bukan error server, itu penolakan kebijakan.
 */
export async function verifyNewAccountAttestation(input: {
  response: unknown;
  expectedChallenge: string;
  expectedOrigin: string | string[];
  expectedRPID: string | string[];
  policy?: AttestationPolicy;
}): Promise<VerifiedAttestation> {
  const policy = input.policy ?? DEFAULT_ATTESTATION_POLICY;

  const verification = await verifyRegistrationResponse({
    // Pustaka memvalidasi bentuk respons sendiri; tipe longgar di sini karena
    // payload datang dari HTTP dan sudah melewati skema Zod route.
    response: input.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    requireUserPresence: true,
    requireUserVerification: policy.requireUserVerification,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return REJECTED;
  }

  const info = verification.registrationInfo;
  const chainDers = attestationChainDers(info.attestationObject);
  const evidence: AttestationEvidence = {
    fmt: info.fmt,
    aaguid: info.aaguid,
    credentialDeviceType: info.credentialDeviceType,
    userVerified: info.userVerified,
    hasCertificateChain: chainDers !== null && chainDers.length > 0,
    certificateChain:
      chainDers && chainDers.length > 0
        ? verifyAttestationChain(chainDers, {
            trustedRootFingerprints: policy.trustedAttestationRoots,
            trustedRootCerts: policy.trustedAttestationRootCerts,
          })
        : null,
  };
  const verdict = evaluateAttestationPolicy(evidence, policy);

  return {
    verified: verdict.accepted,
    tier: verdict.tier,
    reason: verdict.reason,
    aaguid: info.aaguid,
    credentialId: info.credential.id,
    credentialPublicKey: info.credential.publicKey,
    counter: info.credential.counter,
    credentialDeviceType: info.credentialDeviceType,
    credentialBackedUp: info.credentialBackedUp,
  };
}

// ============================================================================
// Penyimpanan challenge sekali-pakai
// ============================================================================

/** Bentuk Redis minimal (memudahkan injeksi di unit test). */
export interface AttestationRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
}

export const attestationChallengeKey = (challenge: string): string => `attestation:chal:${challenge}`;

/** GET + DEL dalam satu perintah — challenge tidak bisa dipakai dua kali. */
const CONSUME_CHALLENGE_LUA = `
local v = redis.call('GET', KEYS[1])
if v then
  redis.call('DEL', KEYS[1])
end
return v or false
`;

export async function storeAttestationChallenge(
  redis: AttestationRedis,
  challenge: string,
  ttlSeconds: number = ATTESTATION_CHALLENGE_TTL_SECONDS
): Promise<void> {
  await redis.setEx(attestationChallengeKey(challenge), ttlSeconds, '1');
}

/** True sekali saja, lalu challenge hilang. */
export async function consumeAttestationChallenge(
  redis: AttestationRedis,
  challenge: string
): Promise<boolean> {
  if (typeof challenge !== 'string' || challenge.length === 0) return false;
  const stored = await redis.eval(CONSUME_CHALLENGE_LUA, {
    keys: [attestationChallengeKey(challenge)],
    arguments: [],
  });
  return stored !== null && stored !== undefined && stored !== false;
}
