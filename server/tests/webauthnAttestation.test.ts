// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Attestation WebAuthn untuk akun baru.
 *
 * Dua tingkat pengujian:
 *   1. **Kebijakan murni** — matriks keputusan (format, tier, AAGUID, UV, single
 *      device) tanpa I/O.
 *   2. **Verifikasi nyata** — respons registrasi WebAuthn dibangun byte-per-byte
 *      (CBOR + authenticatorData + clientDataJSON) lalu diverifikasi oleh
 *      `@simplewebauthn/server` yang sungguhan. Ini membuktikan jalur verifikasi
 *      benar-benar berjalan (bukan stub): challenge/origin/RP ID yang salah
 *      ditolak, dan attestation `none` yang sah secara kriptografis tetap
 *      ditolak sebagai bukti perangkat keras.
 *
 * Tingkat ketiga (2026-10-15) menutup celah yang dulu tercatat di
 * `docs/30` §30.20: attestation `packed` **format sungguhan** dengan rantai
 * `x5c` sungguhan (root CA + leaf ber-EKU AIK TPM, kunci ECDSA P-256, tanda
 * tangan ECDSA sungguhan) diverifikasi pustaka yang sama, lalu diputuskan
 * kebijakan. Yang tetap tidak bisa dibangkitkan di sini dan hanya bisa diuji
 * dengan perangkat fisik: kunci privat benar-benar berada di dalam silikon
 * (TPM/Secure Enclave/Titan). Fixture dibuat
 * `server/scripts/webauthn-attestation-fixtures.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATTESTATION_CHALLENGE_TTL_SECONDS,
  DEFAULT_ATTESTATION_POLICY,
  TPM_AIK_EKU_OID,
  attestationChallengeKey,
  attestationPolicyFromEnv,
  classifyAttestationTier,
  consumeAttestationChallenge,
  evaluateAttestationPolicy,
  hasCertificateChain,
  loadAttestationRootCerts,
  storeAttestationChallenge,
  verifyAttestationChain,
  verifyNewAccountAttestation,
} from '../src/utils/webauthnAttestation.js';

// ---------------------------------------------------------------------------
// Encoder CBOR minimal (hanya bentuk yang dipakai attestation object / COSE key)
// ---------------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function header(major: number, length: number): Uint8Array {
  if (length < 24) return new Uint8Array([(major << 5) | length]);
  if (length < 0x100) return new Uint8Array([(major << 5) | 24, length]);
  if (length < 0x10000) return new Uint8Array([(major << 5) | 25, length >> 8, length & 0xff]);
  throw new Error('panjang CBOR tidak didukung di test ini');
}

const cborUint = (v: number): Uint8Array => header(0, v);
const cborNegInt = (v: number): Uint8Array => header(1, -v - 1);
const cborBytes = (b: Uint8Array): Uint8Array => concat(header(2, b.length), b);
const cborText = (s: string): Uint8Array => {
  const bytes = new TextEncoder().encode(s);
  return concat(header(3, bytes.length), bytes);
};
const cborArray = (items: Uint8Array[]): Uint8Array => concat(header(4, items.length), ...items);
const cborMap = (entries: Array<[Uint8Array, Uint8Array]>): Uint8Array =>
  concat(header(5, entries.length), ...entries.flat());

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(crypto.createHash('sha256').update(data).digest());

const CREDENTIAL_ID = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const AAGUID_ZEROS = new Uint8Array(16);

/** COSE EC2 P-256 (alg ES256). Koordinat bisa diisi kunci nyata (attestation self). */
function coseEc2P256(x?: Uint8Array, y?: Uint8Array): Uint8Array {
  return cborMap([
    [cborUint(1), cborUint(2)],
    [cborUint(3), cborNegInt(-7)],
    [cborNegInt(-1), cborUint(1)],
    [cborNegInt(-2), cborBytes(x ?? new Uint8Array(32).fill(0x11))],
    [cborNegInt(-3), cborBytes(y ?? new Uint8Array(32).fill(0x22))],
  ]);
}

function buildAuthData(opts: {
  rpId: string;
  userVerified?: boolean;
  aaguid?: Uint8Array;
  coseKey?: Uint8Array;
}): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(opts.rpId));
  const flags = new Uint8Array([0x01 | 0x40 | (opts.userVerified === false ? 0 : 0x04)]); // UP | AT | UV
  const counter = new Uint8Array([0, 0, 0, 1]);
  const aaguid = opts.aaguid ?? AAGUID_ZEROS;
  const credIdLen = new Uint8Array([CREDENTIAL_ID.length >> 8, CREDENTIAL_ID.length & 0xff]);
  return concat(rpIdHash, flags, counter, aaguid, credIdLen, CREDENTIAL_ID, opts.coseKey ?? coseEc2P256());
}

function buildAttestationObject(opts: {
  authData: Uint8Array;
  fmt?: string;
  attStmt?: Array<[Uint8Array, Uint8Array]>;
}): Uint8Array {
  return cborMap([
    [cborText('fmt'), cborText(opts.fmt ?? 'none')],
    [cborText('attStmt'), cborMap(opts.attStmt ?? [])],
    [cborText('authData'), cborBytes(opts.authData)],
  ]);
}

/** Byte clientDataJSON yang dipakai pustaka — dipakai juga untuk menandatangani. */
function clientDataFor(challenge: string, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })
  );
}

function buildRegistrationResponse(opts: {
  attestationObject: Uint8Array;
  challenge: string;
  origin: string;
}): Record<string, unknown> {
  const clientDataJSON = new TextDecoder().decode(clientDataFor(opts.challenge, opts.origin));
  return {
    id: b64url(CREDENTIAL_ID),
    rawId: b64url(CREDENTIAL_ID),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
      attestationObject: b64url(opts.attestationObject),
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}

const RPID = 'app.example.test';
const ORIGIN = 'https://app.example.test';
const CHALLENGE = b64url(new Uint8Array(32).fill(0x42));

function validNoneAttestation(): { response: Record<string, unknown>; attestationObject: Uint8Array } {
  const attestationObject = buildAttestationObject({ authData: buildAuthData({ rpId: RPID }) });
  return { response: buildRegistrationResponse({ attestationObject, challenge: CHALLENGE, origin: ORIGIN }), attestationObject };
}

// ---------------------------------------------------------------------------

test('classifyAttestationTier: none / self / hardware', () => {
  assert.equal(classifyAttestationTier({ fmt: 'none', hasCertificateChain: false }), 'none');
  assert.equal(classifyAttestationTier({ fmt: 'packed', hasCertificateChain: true }), 'hardware');
  assert.equal(classifyAttestationTier({ fmt: 'packed', hasCertificateChain: false }), 'self');
  assert.equal(classifyAttestationTier({ fmt: 'tpm', hasCertificateChain: true }), 'hardware');
});

/** Bukti rantai yang lolos semua aturan (untuk test kebijakan murni). */
const trustedChain = (overrides: Partial<ReturnType<typeof baseChain>> = {}) => ({ ...baseChain(), ...overrides });
const baseChain = () => ({
  length: 2,
  linked: true,
  topSelfSigned: true,
  withinValidity: true,
  topFingerprint: 'AA:BB:CC',
  pinnedRootMatch: null as boolean | null,
  leafExtendedKeyUsage: [TPM_AIK_EKU_OID],
  failures: [] as string[],
});

test('evaluateAttestationPolicy: matriks keputusan', () => {
  const hardware = {
    fmt: 'packed',
    aaguid: '2c80f6f2-1b0d-4b1a-9d1a-000000000001',
    credentialDeviceType: 'singleDevice',
    userVerified: true,
    hasCertificateChain: true,
    certificateChain: trustedChain(),
  };
  assert.deepEqual(evaluateAttestationPolicy(hardware), { accepted: true, tier: 'hardware' });

  // `none` tidak pernah dianggap bukti perangkat.
  assert.deepEqual(evaluateAttestationPolicy({ ...hardware, fmt: 'none', hasCertificateChain: false }), {
    accepted: false,
    tier: 'none',
    reason: 'NOT_HARDWARE_ATTESTATION',
  });

  // Attestation self (tanpa x5c) ditolak secara default.
  assert.deepEqual(evaluateAttestationPolicy({ ...hardware, hasCertificateChain: false }), {
    accepted: false,
    tier: 'self',
    reason: 'SELF_ATTESTATION_NOT_ALLOWED',
  });
  assert.deepEqual(
    evaluateAttestationPolicy({ ...hardware, hasCertificateChain: false }, { ...DEFAULT_ATTESTATION_POLICY, allowSelfAttestation: true }),
    { accepted: true, tier: 'self' }
  );

  // Escape hatch `none` hanya bila operator menyalakannya secara eksplisit.
  const noneAllowed = { ...DEFAULT_ATTESTATION_POLICY, allowedFormats: ['none'], allowNoneAttestation: true };
  assert.deepEqual(
    evaluateAttestationPolicy({ ...hardware, fmt: 'none', hasCertificateChain: false }, noneAllowed),
    { accepted: true, tier: 'none' }
  );

  // Format di luar allowlist.
  assert.deepEqual(evaluateAttestationPolicy({ ...hardware, fmt: 'android-safetynet' }), {
    accepted: false,
    tier: 'hardware',
    reason: 'ATTESTATION_FORMAT_NOT_ALLOWED',
  });

  // AAGUID diblokir.
  const blocked = evaluateAttestationPolicy(hardware, {
    ...DEFAULT_ATTESTATION_POLICY,
    blockedAaguids: [hardware.aaguid.toLowerCase()],
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'AAGUID_BLOCKED');

  // User verification & authenticator tersinkronisasi.
  assert.equal(evaluateAttestationPolicy({ ...hardware, userVerified: false }).reason, 'USER_VERIFICATION_REQUIRED');
  assert.equal(evaluateAttestationPolicy({ ...hardware, credentialDeviceType: 'multiDevice' }).reason, 'SYNCED_AUTHENTICATOR_NOT_ALLOWED');
  assert.deepEqual(
    evaluateAttestationPolicy({ ...hardware, credentialDeviceType: 'multiDevice' }, { ...DEFAULT_ATTESTATION_POLICY, requireSingleDevice: false }),
    { accepted: true, tier: 'hardware' }
  );

  // Rantai ada tapi tidak bisa dipercaya: kode kegagalan pertama yang dilaporkan.
  assert.equal(
    evaluateAttestationPolicy({ ...hardware, certificateChain: trustedChain({ failures: ['CERTIFICATE_EXPIRED'] }) }).reason,
    'CERTIFICATE_EXPIRED'
  );
  assert.equal(
    evaluateAttestationPolicy({ ...hardware, certificateChain: trustedChain({ failures: ['CHAIN_TOO_SHORT', 'TOP_NOT_SELF_SIGNED'] }) }).reason,
    'CHAIN_TOO_SHORT'
  );
  assert.equal(
    evaluateAttestationPolicy({ ...hardware, certificateChain: null }).reason,
    'ATTESTATION_CHAIN_UNPARSEABLE'
  );
  // Escape hatch operator: melewatkan pemeriksaan rantai harus eksplisit.
  assert.deepEqual(
    evaluateAttestationPolicy(
      { ...hardware, certificateChain: trustedChain({ failures: ['ROOT_NOT_TRUSTED'] }) },
      { ...DEFAULT_ATTESTATION_POLICY, requireVerifiedChain: false }
    ),
    { accepted: true, tier: 'hardware' }
  );

  // `fmt: 'tpm'` tanpa EKU AIK bukan bukti perangkat: tanda tangannya sah, tapi
  // tidak ada yang menjamin penanda tangannya AIK.
  assert.equal(
    evaluateAttestationPolicy({
      ...hardware,
      fmt: 'tpm',
      certificateChain: trustedChain({ leafExtendedKeyUsage: ['1.3.6.1.5.5.7.3.2'] }),
    }).reason,
    'TPM_AIK_EKU_MISSING'
  );
  assert.deepEqual(evaluateAttestationPolicy({ ...hardware, fmt: 'tpm' }), { accepted: true, tier: 'hardware' });
  assert.deepEqual(
    evaluateAttestationPolicy(
      { ...hardware, fmt: 'tpm', certificateChain: trustedChain({ leafExtendedKeyUsage: [] }) },
      { ...DEFAULT_ATTESTATION_POLICY, requireTpmAikEku: false }
    ),
    { accepted: true, tier: 'hardware' }
  );
});

test('attestationPolicyFromEnv: default ketat, override eksplisit', () => {
  const defaults = attestationPolicyFromEnv({} as NodeJS.ProcessEnv);
  assert.deepEqual(defaults, DEFAULT_ATTESTATION_POLICY);

  assert.equal(defaults.requireVerifiedChain, true);
  assert.equal(defaults.requireTpmAikEku, true);
  assert.deepEqual(defaults.trustedAttestationRoots, []);

  const relaxed = attestationPolicyFromEnv({
    ABUSE_ATTESTATION_FORMATS: 'packed, tpm ',
    ABUSE_ATTESTATION_ALLOW_SELF: 'on',
    ABUSE_ATTESTATION_ALLOW_NONE: 'on',
    ABUSE_ATTESTATION_BLOCKED_AAGUIDS: 'AAAA-1, BBBB-2',
    ABUSE_ATTESTATION_ALLOW_NO_UV: 'on',
    ABUSE_ATTESTATION_ALLOW_SYNCED: 'on',
    ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'on',
    ABUSE_ATTESTATION_ROOTS: 'aa:bb, cc:dd',
    ABUSE_ATTESTATION_ALLOW_NO_AIK_EKU: 'on',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(relaxed.allowedFormats, ['packed', 'tpm']);
  assert.equal(relaxed.allowSelfAttestation, true);
  assert.equal(relaxed.allowNoneAttestation, true);
  assert.deepEqual(relaxed.blockedAaguids, ['aaaa-1', 'bbbb-2']);
  assert.equal(relaxed.requireUserVerification, false);
  assert.equal(relaxed.requireSingleDevice, false);
  assert.equal(relaxed.requireVerifiedChain, false);
  assert.deepEqual(relaxed.trustedAttestationRoots, ['aa:bb', 'cc:dd']);
  assert.equal(relaxed.requireTpmAikEku, false);
});

test('attestationPolicyFromEnv: kombinasi passkey tersinkron (Android/iOS) diterima apa adanya', () => {
  const policy = attestationPolicyFromEnv({
    ABUSE_ATTESTATION_FORMATS: 'packed,tpm,android-key,apple,fido-u2f,none',
    ABUSE_ATTESTATION_ALLOW_NONE: 'on',
    ABUSE_ATTESTATION_ALLOW_SYNCED: 'on',
  } as NodeJS.ProcessEnv);

  // Bentuk persis yang dikirim Google Password Manager: `fmt: none`,
  // kredensial tersinkron, tanpa x5c — ditolak sebelum pelonggaran ini.
  const passkey = {
    fmt: 'none',
    aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
    credentialDeviceType: 'multiDevice',
    userVerified: true,
    hasCertificateChain: false,
    certificateChain: null,
  };
  assert.deepEqual(evaluateAttestationPolicy(passkey, policy), { accepted: true, tier: 'none' });

  // `ALLOW_NONE=on` saja tidak cukup: `none` juga harus masuk allowlist format,
  // dan urutan pemeriksaan membuat kealpaan itu muncul sebagai
  // ATTESTATION_FORMAT_NOT_ALLOWED (bukan lolos diam-diam).
  const formatsOnlyHardware = attestationPolicyFromEnv({
    ABUSE_ATTESTATION_FORMATS: 'packed,tpm,android-key,apple,fido-u2f',
    ABUSE_ATTESTATION_ALLOW_NONE: 'on',
    ABUSE_ATTESTATION_ALLOW_SYNCED: 'on',
  } as NodeJS.ProcessEnv);
  assert.equal(evaluateAttestationPolicy(passkey, formatsOnlyHardware).reason, 'ATTESTATION_FORMAT_NOT_ALLOWED');
});

test('verifyNewAccountAttestation: `none` sah secara kripto tapi ditolak kebijakan', async () => {
  const { response } = validNoneAttestation();

  const result = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });

  assert.equal(result.verified, false);
  assert.equal(result.tier, 'none');
  assert.equal(result.reason, 'NOT_HARDWARE_ATTESTATION');
  // Kredensialnya tetap terbaca (bisa dicatat untuk audit pemakaian kebijakan).
  assert.equal(result.credentialId, b64url(CREDENTIAL_ID));
  assert.ok(result.credentialPublicKey && result.credentialPublicKey.length > 0);
  assert.equal(result.counter, 1);
  assert.equal(result.credentialDeviceType, 'singleDevice');
  assert.equal(result.aaguid, '00000000-0000-0000-0000-000000000000');
});

test('verifyNewAccountAttestation: challenge/origin/RP ID salah ditolak pustaka', async () => {
  const { response } = validNoneAttestation();

  await assert.rejects(() =>
    verifyNewAccountAttestation({
      response,
      expectedChallenge: b64url(new Uint8Array(32).fill(0x99)),
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    })
  );

  await assert.rejects(() =>
    verifyNewAccountAttestation({ response, expectedChallenge: CHALLENGE, expectedOrigin: 'https://evil.test', expectedRPID: RPID })
  );

  await assert.rejects(() =>
    verifyNewAccountAttestation({ response, expectedChallenge: CHALLENGE, expectedOrigin: ORIGIN, expectedRPID: 'example.test' })
  );
});

test('verifyNewAccountAttestation: struktur rusak ditolak (bukan lolos senyap)', async () => {
  const { response } = validNoneAttestation();

  await assert.rejects(() =>
    verifyNewAccountAttestation({
      response: { ...response, type: 'public-key' as const, id: 'tidak-base64url!', rawId: 'beda' },
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    })
  );

  // fmt 'none' dengan attStmt tidak kosong = tidak konsisten.
  const bogus = buildAttestationObject({
    authData: buildAuthData({ rpId: RPID }),
    attStmt: [[cborText('sig'), cborBytes(new Uint8Array(8))]],
  });
  await assert.rejects(() =>
    verifyNewAccountAttestation({
      response: buildRegistrationResponse({ attestationObject: bogus, challenge: CHALLENGE, origin: ORIGIN }),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    })
  );

  // UV tidak di-set padahal kebijakan mewajibkannya.
  const noUv = buildAttestationObject({ authData: buildAuthData({ rpId: RPID, userVerified: false }) });
  await assert.rejects(() =>
    verifyNewAccountAttestation({
      response: buildRegistrationResponse({ attestationObject: noUv, challenge: CHALLENGE, origin: ORIGIN }),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    })
  );
});

test('hasCertificateChain: hanya true bila x5c benar-benar ada', () => {
  const { attestationObject } = validNoneAttestation();
  assert.equal(hasCertificateChain(attestationObject), false);

  const withChain = buildAttestationObject({
    authData: buildAuthData({ rpId: RPID }),
    fmt: 'packed',
    attStmt: [[cborText('x5c'), cborArray([cborBytes(new Uint8Array([1, 2, 3])), cborBytes(new Uint8Array([4, 5]))])]],
  });
  assert.equal(hasCertificateChain(withChain), true);

  const emptyChain = buildAttestationObject({
    authData: buildAuthData({ rpId: RPID }),
    fmt: 'packed',
    attStmt: [[cborText('x5c'), cborArray([])]],
  });
  assert.equal(hasCertificateChain(emptyChain), false);

  assert.equal(hasCertificateChain(new Uint8Array([0xff, 0x00])), false);
});

test('challenge attestation: sekali pakai (store → consume → gagal)', async () => {
  const store = new Map<string, { value: string; ttl: number }>();
  let evalCalls = 0;
  const redis = {
    async setEx(key: string, seconds: number, value: string) {
      store.set(key, { value, ttl: seconds });
      return 'OK';
    },
    async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
      evalCalls++;
      const key = options.keys[0]!;
      const entry = store.get(key);
      if (!entry) return null;
      store.delete(key);
      return entry.value;
    },
  };

  await storeAttestationChallenge(redis, CHALLENGE);
  const entry = store.get(attestationChallengeKey(CHALLENGE));
  assert.ok(entry);
  assert.equal(entry!.ttl, ATTESTATION_CHALLENGE_TTL_SECONDS);
  assert.equal(entry!.value, '1');

  assert.equal(await consumeAttestationChallenge(redis, CHALLENGE), true);
  assert.equal(await consumeAttestationChallenge(redis, CHALLENGE), false, 'challenge tidak boleh dipakai dua kali');
  assert.equal(await consumeAttestationChallenge(redis, 'tidak-pernah-ada'), false, 'challenge tak dikenal ditolak');
  assert.equal(await consumeAttestationChallenge(redis, ''), false, 'challenge kosong ditolak tanpa menyentuh Redis');
  assert.equal(evalCalls, 3);
});

// ---------------------------------------------------------------------------
// Attestation `packed` dengan rantai X.509 sungguhan (fixture openssl)
// ---------------------------------------------------------------------------
//
// Yang diuji di sini bukan struktur buatan: sertifikatnya DER nyata (root CA →
// leaf), kuncinya ECDSA P-256 nyata, tanda tangannya ECDSA nyata atas
// `authenticatorData || clientDataHash`, dan verifikasinya lewat
// `@simplewebauthn/server` yang sama dengan produksi. Yang tidak bisa
// dibangkitkan di sini (dan karena itu tetap residual jujur): kunci privat
// benar-benar berada di dalam silikon perangkat.

const FIXTURE_DIR = new URL('./fixtures/webauthn/', import.meta.url);
const readFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, FIXTURE_DIR)));
const aikLeafDer = readFixture('leaf-aik.der');
const plainLeafDer = readFixture('leaf-plain.der');
const chainedLeafDer = readFixture('leaf-chained.der');
const intermediateDer = readFixture('intermediate-ca.der');
const rootCaDer = readFixture('root-ca.der');
const aikKey = crypto.createPrivateKey(readFileSync(new URL('leaf-aik.key.pem', FIXTURE_DIR)));
const chainedKey = crypto.createPrivateKey(readFileSync(new URL('leaf-chained.key.pem', FIXTURE_DIR)));
const plainLeafKey = crypto.createPrivateKey(readFileSync(new URL('leaf-plain.key.pem', FIXTURE_DIR)));
const ROOT_FINGERPRINT = new crypto.X509Certificate(Buffer.from(rootCaDer)).fingerprint256;

/** Attestation `packed` sungguhan: tanda tangan ECDSA oleh kunci leaf. */
function packedAttestation(opts: {
  authData: Uint8Array;
  challenge: string;
  origin: string;
  key: crypto.KeyObject;
  /** `null` = tanpa `x5c` (attestation self). */
  chain: Uint8Array[] | null;
  fmt?: string;
  tamperSignature?: boolean;
}): Uint8Array {
  const signed = concat(opts.authData, sha256(clientDataFor(opts.challenge, opts.origin)));
  const signature = new Uint8Array(crypto.sign('sha256', signed, opts.key));
  if (opts.tamperSignature) signature[signature.length - 1] ^= 0xff;

  const attStmt: Array<[Uint8Array, Uint8Array]> = [
    [cborText('alg'), cborNegInt(-7)],
    [cborText('sig'), cborBytes(signature)],
  ];
  if (opts.chain) attStmt.push([cborText('x5c'), cborArray(opts.chain.map(cborBytes))]);
  return buildAttestationObject({ authData: opts.authData, fmt: opts.fmt ?? 'packed', attStmt });
}

test('verifyAttestationChain: rantai nyata lolos, pelanggarannya terdeteksi', () => {
  const ok = verifyAttestationChain([aikLeafDer, rootCaDer]);
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.length, 2);
  assert.equal(ok.linked, true);
  assert.equal(ok.topSelfSigned, true);
  assert.equal(ok.withinValidity, true);
  assert.equal(ok.topFingerprint, ROOT_FINGERPRINT);
  assert.ok(ok.leafExtendedKeyUsage.includes(TPM_AIK_EKU_OID), 'leaf AIK harus punya EKU TPM');

  // Satu sertifikat = bukan rantai, sekalipun tanda tangannya sah.
  const single = verifyAttestationChain([aikLeafDer]);
  assert.ok(single.failures.includes('CHAIN_TOO_SHORT'));

  // Urutan terbalik = tidak tersambung.
  assert.ok(verifyAttestationChain([rootCaDer, aikLeafDer]).failures.includes('CHAIN_NOT_LINKED'));

  // Masa berlaku dievaluasi terhadap `now` yang diberikan.
  assert.ok(verifyAttestationChain([aikLeafDer, rootCaDer], { now: new Date('2100-01-01') }).failures.includes('CERTIFICATE_EXPIRED'));
  assert.ok(
    verifyAttestationChain([aikLeafDer, rootCaDer], { now: new Date('2000-01-01') }).failures.includes('CERTIFICATE_NOT_YET_VALID')
  );

  // Root dipin: cocok = lolos, beda = ditolak.
  const pinnedOk = verifyAttestationChain([aikLeafDer, rootCaDer], { trustedRootFingerprints: [ROOT_FINGERPRINT] });
  assert.deepEqual(pinnedOk.failures, []);
  assert.equal(pinnedOk.pinnedRootMatch, true);

  const pinnedBad = verifyAttestationChain([aikLeafDer, rootCaDer], {
    trustedRootFingerprints: ['AA:BB:CC:DD'],
  });
  assert.equal(pinnedBad.pinnedRootMatch, false);
  assert.ok(pinnedBad.failures.includes('ROOT_NOT_TRUSTED'));

  // Leaf tanpa EKU: rantai tetap sah, tapi EKU-nya kosong.
  const plain = verifyAttestationChain([plainLeafDer, rootCaDer]);
  assert.deepEqual(plain.failures, []);
  assert.deepEqual(plain.leafExtendedKeyUsage, []);

  // DER yang tidak bisa diurai tidak boleh diam-diam dianggap sah.
  assert.deepEqual(verifyAttestationChain([new Uint8Array([1, 2, 3])]).failures, ['CHAIN_UNPARSEABLE']);
});

test('verifyNewAccountAttestation: packed + x5c nyata DITERIMA sebagai tier hardware', async () => {
  const authData = buildAuthData({ rpId: RPID });
  const attestationObject = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: aikKey,
    chain: [aikLeafDer, rootCaDer],
  });

  const result = await verifyNewAccountAttestation({
    response: buildRegistrationResponse({ attestationObject, challenge: CHALLENGE, origin: ORIGIN }),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });

  assert.equal(result.verified, true, `ditolak: ${result.reason}`);
  assert.equal(result.tier, 'hardware');
  assert.equal(result.reason, undefined);
  assert.equal(result.credentialId, b64url(CREDENTIAL_ID));
  assert.ok(result.credentialPublicKey && result.credentialPublicKey.length > 0);
});

test('verifyNewAccountAttestation: root dipin menerima root benar dan menolak root lain', async () => {
  const authData = buildAuthData({ rpId: RPID });
  const attestationObject = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: aikKey,
    chain: [aikLeafDer, rootCaDer],
  });
  const response = buildRegistrationResponse({ attestationObject, challenge: CHALLENGE, origin: ORIGIN });

  const trusted = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
    policy: { ...DEFAULT_ATTESTATION_POLICY, trustedAttestationRoots: [ROOT_FINGERPRINT] },
  });
  assert.equal(trusted.verified, true, `ditolak: ${trusted.reason}`);

  const untrusted = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
    policy: { ...DEFAULT_ATTESTATION_POLICY, trustedAttestationRoots: ['AA:BB:CC:DD'] },
  });
  assert.equal(untrusted.verified, false);
  assert.equal(untrusted.reason, 'ROOT_NOT_TRUSTED');
});

test('verifyAttestationChain: x5c tanpa root diterima bila root-nya dipin (bentuk perangkat nyata)', () => {
  // TPM/Windows Hello, Android Key Attestation, packed YubiKey, dan `apple`
  // sering mengirim x5c = leaf (+ intermediate) saja; root hidup di trust store
  // vendor. Jalur harus tetap bisa dibangun dari root yang dipin operator.
  const leafOnly = verifyAttestationChain([aikLeafDer], { trustedRootCerts: [rootCaDer] });
  assert.deepEqual(leafOnly.failures, []);
  assert.equal(leafOnly.anchoredBy, 'pinned-root');
  assert.equal(leafOnly.pinnedRootMatch, true);

  // Fingerprint root saja TIDAK cukup kalau root tidak ikut x5c: tanpa kunci
  // publik root, tanda tangan leaf tidak bisa diverifikasi. Jangan diterima
  // hanya karena operator menyebut nama fingerprint.
  const fingerprintOnly = verifyAttestationChain([aikLeafDer], {
    trustedRootFingerprints: [ROOT_FINGERPRINT],
  });
  assert.ok(fingerprintOnly.failures.includes('CHAIN_TOO_SHORT'));
  assert.equal(fingerprintOnly.pinnedRootMatch, false);

  // Sertifikat yang dipin tapi bukan penerbit (dan bukan CA) tidak boleh
  // mengakhiri jalur.
  const wrongRoot = verifyAttestationChain([aikLeafDer], { trustedRootCerts: [plainLeafDer] });
  assert.ok(wrongRoot.failures.includes('ROOT_NOT_TRUSTED'));

  // Satu sertifikat yang dipin persis adalah trust anchor eksplisit → tidak
  // lagi kena CHAIN_TOO_SHORT. Fixture root di sini CA:TRUE, jadi status
  // LEAF_IS_CA tetap muncul (memang bukan leaf); bentuk CA:FALSE yang dipakai
  // authenticator virtual diuji E2E di lingkungan dev.
  const singlePinned = verifyAttestationChain([rootCaDer], {
    trustedRootFingerprints: [ROOT_FINGERPRINT],
  });
  assert.equal(singlePinned.anchoredBy, 'pinned-root');
  assert.equal(singlePinned.length, 1);
  assert.equal(singlePinned.failures.includes('CHAIN_TOO_SHORT'), false);
  assert.equal(singlePinned.failures.includes('ROOT_NOT_TRUSTED'), false);
  assert.deepEqual(singlePinned.failures, ['LEAF_IS_CA']);
});

test('verifyAttestationChain: jalur 3 tingkat (leaf→intermediate) dengan root dipin', () => {
  // Bentuk Android/YubiKey/Apple/TPM: x5c berhenti di intermediate, root tidak
  // ikut. Jalur dibangun dengan kunci publik root yang dipin.
  const ok = verifyAttestationChain([chainedLeafDer, intermediateDer], {
    trustedRootCerts: [rootCaDer],
  });
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.anchoredBy, 'pinned-root');
  assert.equal(ok.length, 2);

  // Tanpa pin, rantai berhenti di intermediate → tidak ada anchor.
  assert.ok(
    verifyAttestationChain([chainedLeafDer, intermediateDer]).failures.includes('TOP_NOT_SELF_SIGNED')
  );

  // Root lain yang dipin tidak boleh menutup jalur ini.
  assert.ok(
    verifyAttestationChain([chainedLeafDer, intermediateDer], {
      trustedRootCerts: [plainLeafDer],
    }).failures.includes('ROOT_NOT_TRUSTED')
  );

  // Rantai lengkap (root ikut) + fingerprint root juga sah.
  const full = verifyAttestationChain([chainedLeafDer, intermediateDer, rootCaDer], {
    trustedRootFingerprints: [ROOT_FINGERPRINT],
  });
  assert.deepEqual(full.failures, []);
  assert.equal(full.anchoredBy, 'pinned-root');
});

test('verifyNewAccountAttestation: rantai perangkat nyata (root tidak ikut x5c) diterima', async () => {
  const authData = buildAuthData({ rpId: RPID });
  const attestationObject = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: chainedKey,
    chain: [chainedLeafDer, intermediateDer],
  });
  const response = buildRegistrationResponse({ attestationObject, challenge: CHALLENGE, origin: ORIGIN });

  const accepted = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
    policy: { ...DEFAULT_ATTESTATION_POLICY, trustedAttestationRootCerts: [rootCaDer] },
  });
  assert.equal(accepted.verified, true, `ditolak: ${accepted.reason}`);
  assert.equal(accepted.tier, 'hardware');

  const rejected = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });
  assert.equal(rejected.verified, false);
  assert.equal(rejected.reason, 'TOP_NOT_SELF_SIGNED');
});

test('verifyNewAccountAttestation: root dipin menutup jalur walau x5c tanpa root', async () => {
  const authData = buildAuthData({ rpId: RPID });
  const attestationObject = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: aikKey,
    // Bentuk perangkat nyata: hanya leaf, root tidak dikirim.
    chain: [aikLeafDer],
  });
  const response = buildRegistrationResponse({ attestationObject, challenge: CHALLENGE, origin: ORIGIN });

  const accepted = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
    policy: { ...DEFAULT_ATTESTATION_POLICY, trustedAttestationRootCerts: [rootCaDer] },
  });
  assert.equal(accepted.verified, true, `ditolak: ${accepted.reason}`);
  assert.equal(accepted.tier, 'hardware');

  // Tanpa root yang dipin, bentuk yang sama tetap ditolak.
  const rejected = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });
  assert.equal(rejected.verified, false);
  assert.equal(rejected.reason, 'CHAIN_TOO_SHORT');
});

test('attestationPolicyFromEnv: ABUSE_ATTESTATION_ROOTS_FILE dibaca sebagai root DER', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-attest-roots-'));
  try {
    const pemPath = join(dir, 'roots.pem');
    writeFileSync(pemPath, new crypto.X509Certificate(Buffer.from(rootCaDer)).toString());

    const policy = attestationPolicyFromEnv({
      ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN: 'off',
      ABUSE_ATTESTATION_ROOTS_FILE: pemPath,
    });
    assert.equal(policy.requireVerifiedChain, true);
    assert.equal(policy.trustedAttestationRootCerts.length, 1);
    assert.deepEqual(new Uint8Array(policy.trustedAttestationRootCerts[0]!), rootCaDer);

    // Berkas hilang = konfigurasi rusak, bukan "tidak ada root".
    assert.throws(
      () => attestationPolicyFromEnv({ ABUSE_ATTESTATION_ROOTS_FILE: join(dir, 'tidak-ada.pem') }),
      /ABUSE_ATTESTATION_ROOTS_FILE tidak bisa dibaca/
    );

    // Berkas tanpa sertifikat PEM juga harus terlihat sebagai kesalahan.
    const emptyPath = join(dir, 'kosong.pem');
    writeFileSync(emptyPath, '# bukan sertifikat\n');
    assert.throws(() => loadAttestationRootCerts(emptyPath), /tidak memuat sertifikat PEM/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyNewAccountAttestation: tanda tangan diubah / satu sertifikat / rantai tak tersambung ditolak', async () => {
  const authData = buildAuthData({ rpId: RPID });

  // 1. Tanda tangan diubah → tidak boleh diterima, dalam bentuk apa pun
  //    (pustaka bisa melempar atau mengembalikan `verified: false`; yang penting
  //    tidak ada jalur yang meloloskannya).
  const tampered = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: aikKey,
    chain: [aikLeafDer, rootCaDer],
    tamperSignature: true,
  });
  let tamperedAccepted = false;
  try {
    const tamperedResult = await verifyNewAccountAttestation({
      response: buildRegistrationResponse({ attestationObject: tampered, challenge: CHALLENGE, origin: ORIGIN }),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    });
    tamperedAccepted = tamperedResult.verified;
  } catch {
    tamperedAccepted = false;
  }
  assert.equal(tamperedAccepted, false, 'tanda tangan yang diubah diterima — ini kegagalan keamanan');

  // 2. Hanya satu sertifikat (self-signed buatan sendiri): tanda tangan sah,
  //    tapi rantainya tidak membuktikan perangkat apa pun.
  const singleCert = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: aikKey,
    chain: [aikLeafDer],
  });
  const singleResult = await verifyNewAccountAttestation({
    response: buildRegistrationResponse({ attestationObject: singleCert, challenge: CHALLENGE, origin: ORIGIN }),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });
  assert.equal(singleResult.verified, false);
  assert.equal(singleResult.reason, 'CHAIN_TOO_SHORT');

  // 3. Rantai yang tidak tersambung: dua sertifikat sah, tapi leaf tidak
  //    ditandatangani sertifikat berikutnya. Pustaka hanya memeriksa leaf
  //    (subject/C/CA/versi) — penyambungan rantai adalah tanggung jawab kami,
  //    dan inilah yang membedakannya dari "x5c ada isinya".
  const unlinked = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: aikKey,
    chain: [aikLeafDer, plainLeafDer],
  });
  const unlinkedResult = await verifyNewAccountAttestation({
    response: buildRegistrationResponse({ attestationObject: unlinked, challenge: CHALLENGE, origin: ORIGIN }),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });
  assert.equal(unlinkedResult.verified, false);
  assert.equal(unlinkedResult.reason, 'CHAIN_NOT_LINKED');

  // Catatan: aturan "fmt tpm wajib ber-EKU AIK" diuji di matriks kebijakan murni
  // di atas, bukan lewat respons penuh — attestation TPM sungguhan menuntut
  // struktur `certInfo`/`pubArea` yang hanya bisa dibangkitkan perangkat TPM.
});

test('verifyNewAccountAttestation: packed self (tanpa x5c) ditolak kecuali operator mengizinkan', async () => {
  // Kunci kredensial nyata: tanda tangan self-attestation dibuat kunci itu
  // sendiri, jadi pustaka benar-benar memverifikasinya.
  const credentialKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = credentialKey.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = coseEc2P256(
    new Uint8Array(Buffer.from(jwk.x, 'base64url')),
    new Uint8Array(Buffer.from(jwk.y, 'base64url'))
  );
  const authData = buildAuthData({ rpId: RPID, coseKey: cose });
  const attestationObject = packedAttestation({
    authData,
    challenge: CHALLENGE,
    origin: ORIGIN,
    key: credentialKey.privateKey,
    chain: null,
  });
  const response = buildRegistrationResponse({ attestationObject, challenge: CHALLENGE, origin: ORIGIN });

  const rejected = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
  });
  assert.equal(rejected.verified, false);
  assert.equal(rejected.tier, 'self');
  assert.equal(rejected.reason, 'SELF_ATTESTATION_NOT_ALLOWED');

  const allowed = await verifyNewAccountAttestation({
    response,
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: RPID,
    policy: { ...DEFAULT_ATTESTATION_POLICY, allowSelfAttestation: true },
  });
  assert.equal(allowed.verified, true, `ditolak: ${allowed.reason}`);
  assert.equal(allowed.tier, 'self');
});
