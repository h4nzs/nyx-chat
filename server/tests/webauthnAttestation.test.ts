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
 * Catatan jujur: attestation perangkat keras sungguhan (packed/tpm dengan x5c)
 * tidak bisa dibangkitkan di unit test tanpa authenticator nyata — itu celah
 * E2E yang dicatat di `docs/30` §30.20.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  ATTESTATION_CHALLENGE_TTL_SECONDS,
  DEFAULT_ATTESTATION_POLICY,
  attestationChallengeKey,
  attestationPolicyFromEnv,
  classifyAttestationTier,
  consumeAttestationChallenge,
  evaluateAttestationPolicy,
  hasCertificateChain,
  storeAttestationChallenge,
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

/** COSE EC2 P-256 (alg ES256) — kunci publik dummy, sah secara struktur. */
function coseEc2P256(): Uint8Array {
  return cborMap([
    [cborUint(1), cborUint(2)],
    [cborUint(3), cborNegInt(-7)],
    [cborNegInt(-1), cborUint(1)],
    [cborNegInt(-2), cborBytes(new Uint8Array(32).fill(0x11))],
    [cborNegInt(-3), cborBytes(new Uint8Array(32).fill(0x22))],
  ]);
}

function buildAuthData(opts: { rpId: string; userVerified?: boolean; aaguid?: Uint8Array }): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(opts.rpId));
  const flags = new Uint8Array([0x01 | 0x40 | (opts.userVerified === false ? 0 : 0x04)]); // UP | AT | UV
  const counter = new Uint8Array([0, 0, 0, 1]);
  const aaguid = opts.aaguid ?? AAGUID_ZEROS;
  const credIdLen = new Uint8Array([CREDENTIAL_ID.length >> 8, CREDENTIAL_ID.length & 0xff]);
  return concat(rpIdHash, flags, counter, aaguid, credIdLen, CREDENTIAL_ID, coseEc2P256());
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

function buildRegistrationResponse(opts: {
  attestationObject: Uint8Array;
  challenge: string;
  origin: string;
}): Record<string, unknown> {
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.create',
    challenge: opts.challenge,
    origin: opts.origin,
    crossOrigin: false,
  });
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

test('evaluateAttestationPolicy: matriks keputusan', () => {
  const hardware = {
    fmt: 'packed',
    aaguid: '2c80f6f2-1b0d-4b1a-9d1a-000000000001',
    credentialDeviceType: 'singleDevice',
    userVerified: true,
    hasCertificateChain: true,
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
});

test('attestationPolicyFromEnv: default ketat, override eksplisit', () => {
  const defaults = attestationPolicyFromEnv({} as NodeJS.ProcessEnv);
  assert.deepEqual(defaults, DEFAULT_ATTESTATION_POLICY);

  const relaxed = attestationPolicyFromEnv({
    ABUSE_ATTESTATION_FORMATS: 'packed, tpm ',
    ABUSE_ATTESTATION_ALLOW_SELF: 'on',
    ABUSE_ATTESTATION_ALLOW_NONE: 'on',
    ABUSE_ATTESTATION_BLOCKED_AAGUIDS: 'AAAA-1, BBBB-2',
    ABUSE_ATTESTATION_ALLOW_NO_UV: 'on',
    ABUSE_ATTESTATION_ALLOW_SYNCED: 'on',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(relaxed.allowedFormats, ['packed', 'tpm']);
  assert.equal(relaxed.allowSelfAttestation, true);
  assert.equal(relaxed.allowNoneAttestation, true);
  assert.deepEqual(relaxed.blockedAaguids, ['aaaa-1', 'bbbb-2']);
  assert.equal(relaxed.requireUserVerification, false);
  assert.equal(relaxed.requireSingleDevice, false);
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
