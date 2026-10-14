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
 *      fido-u2f/self). Rantai sertifikat divalidasi terhadap root FIDO yang
 *      dikonfigurasi di `SettingsService` bila tersedia.
 *   2. **Kebijakan NYX** (fungsi murni `evaluateAttestationPolicy`) menentukan
 *      apakah bukti itu cukup: format harus termasuk allowlist (default:
 *      format perangkat keras), **rantai sertifikat wajib ada** (attestation
 *      "self" hanya bukti kepemilikan kunci, bukan perangkat), AAGUID tidak
 *      diblokir, dan authenticator tidak disinkronkan (`multiDevice`) karena
 *      akun NYX bersifat satu perangkat.
 *
 * `none` attestation (yang mengaku "tidak ada") **selalu ditolak** sebagai
 * bukti perangkat keras — itu inti dari lapisan ini.
 *
 * Challenge disimpan sekali-pakai di Redis (`attestation:chal:*`) dan
 * dihapus saat dikonsumsi, sehingga bukti tidak bisa diputar ulang untuk
 * membuat akun kedua.
 */

import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { decodeAttestationObject } from '@simplewebauthn/server/helpers';

/** Umur challenge attestation (detik). */
export const ATTESTATION_CHALLENGE_TTL_SECONDS = 600;

/** Format attestation yang membawa bukti perangkat keras (bukan `none`). */
export const HARDWARE_ATTESTATION_FORMATS = ['packed', 'tpm', 'android-key', 'apple', 'fido-u2f'] as const;

export type AttestationTier = 'hardware' | 'self' | 'none' | 'unsupported';

export interface AttestationPolicy {
  /** Format yang boleh membuktikan perangkat keras. */
  allowedFormats: string[];
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

/** Kebijakan dari env (operator bisa melonggarkan tanpa deploy kode). */
export function attestationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AttestationPolicy {
  return {
    allowedFormats: listFromEnv(env.ABUSE_ATTESTATION_FORMATS, [...HARDWARE_ATTESTATION_FORMATS]),
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

/** Apakah statement attestation membawa rantai sertifikat (`x5c`)? */
export function hasCertificateChain(attestationObject: Uint8Array<ArrayBuffer>): boolean {
  try {
    const decoded = decodeAttestationObject(attestationObject) as Map<string, unknown>;
    const attStmt = decoded.get('attStmt') as Map<string, unknown> | undefined;
    if (!attStmt || typeof attStmt.get !== 'function') return false;
    const x5c = attStmt.get('x5c');
    return Array.isArray(x5c) && x5c.length > 0;
  } catch {
    return false;
  }
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
  const evidence: AttestationEvidence = {
    fmt: info.fmt,
    aaguid: info.aaguid,
    credentialDeviceType: info.credentialDeviceType,
    userVerified: info.userVerified,
    hasCertificateChain: hasCertificateChain(info.attestationObject),
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
