// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router, Response, CookieOptions, Request } from 'express'
import { prisma } from '../lib/prisma.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { ApiError } from '../utils/errors.js'
import { newJti, refreshExpiryDate, signAccessToken, verifyJwt, signTransportTicket } from '../utils/jwt.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { authCookieOptions, clearAuthCookies, isEphemeralGuestSubject, revokeFamily } from '../utils/sessionUtils.js'
// [BUGFIX 2026-10-18] Klasifikasi replay rotasi refresh token (lihat util-nya).
import {
  classifyRefreshReplay,
  refreshReplayGraceMs,
  sessionEndedError,
} from '../utils/refreshReplay.js'
import { powRateKey, resolvePowIdentity } from '../utils/powIdentity.js'
import { cfAwareClientIp } from '../utils/clientIp.js'
import { env } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { authLimiter, burnerLimiter } from '../middleware/rateLimiter.js'
// [docs/35 Fase 4d] Baris user/device yang berubah membuat snapshot PIR basi;
// tandai generasinya supaya job interval (3 menit) membangun ulang, bukan
// menunggu cron harian 04:15.
import { markPirSnapshotDirty } from '../pir/dirty.js'
import { getSodium } from '../lib/sodium.js'
import { invalidateActiveDeviceCache } from '../utils/redisResilience.js'
import {
  deviceInstallationTag,
  generateShareId,
  identifierLookupCandidates,
  openAtRest,
  pepperedIdentifier,
  sealAtRest,
  sealedLookupCandidates,
} from '../utils/atRestSecrets.js'
import { ensureUserShareId } from '../utils/userShareId.js'
// [LINK 2026-10-18] State machine pairing perangkat lewat QR (token → pending →
// approved → complete). Logikanya murni + bisa diuji tanpa Prisma/Redis.
import {
  LINK_TOKEN_PATTERN,
  approvePendingLink,
  consumeLinkToken,
  createPendingLink,
  denyPendingLink,
  getApprovedDeviceId,
  getLinkState,
  readPendingLink,
  takeApprovedLink,
  type LinkingSealer,
  type LinkingStore,
} from '../utils/deviceLinking.js'
// [docs/40] Arsip riwayat: intent → preparing → ready (state ter-seal di Redis).
import { hasHistoryIntent, markHistoryIntent, readHistoryState } from '../utils/linkHistory.js'
// [docs/28 Tier 1.5 / D14] key Redis memakai tag, bukan userId asli (Redis = artefak setara dump).
// [docs/28 Tier 4] identitas at-rest: key Redis tidak menyematkan userId asli.
import { identityKey, identityTag } from '../utils/redisIdentity.js'
// [docs/30 §30.12 WS-H] Guard burst registrasi (per sumber IP-hash & instalasi).
import { enforceRegistrationBurst, mayWaiveAttestation } from '../utils/registrationGuard.js'
// [docs/30 §30.12 WS-H] Attestation yang DITOLAK harus terlihat tanpa membaca log:
// `root_not_trusted` = bundle root operator ketinggalan, `rejected`/`accepted` =
// laju penolakan (ops/prometheus/alerts.yml grup `nyx-attestation`).
import { ATTESTATION_REGISTRATION, LEGACY_V1_USAGE, OHTTP_OPS, incCounter } from '../utils/metrics.js'
// [docs/35 Fase 3] Token carriage OHTTP (umur 120 detik, scope allowlist).
import { OHTTP_TOKEN_TTL_SEC, signOhttpToken } from '../utils/ohttpToken.js'
import { isOhttpEnabled } from '../ohttp/config.js'
// [docs/28 Tier 2 — B4] bucket metadata temporal (hari/15 menit).
import { dayBucket, deviceActivityBucket } from '../utils/temporalBucket.js'
import { nanoid } from 'nanoid'
import argon2 from 'argon2'
import crypto from 'crypto'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
// [docs/30 §30.5 WS-A] Jejak kunci identitas di log Key Transparency.
import {
  KT_KEY_VERSION_RECOVERY,
  KT_KEY_VERSION_REGISTRATION,
  publishKeyTransparencyEntry
} from '../utils/keyTransparency.js'
// [docs/30 §30.5 WS-A] Rotasi kunci identitas di jalur login → entri log KT.
import {
  backfillKtV2IdentityOnLogin,
  identityKeysChanged,
  publishIdentityKeyChange
} from '../utils/ktIdentityLog.js'
import { searchOprfIndexForIdentifier } from '../utils/searchOprf.js'
// [docs/30 §30.12 WS-H] Attestation perangkat untuk akun baru (gerbang sybil).
import {
  attestationPolicyFromEnv,
  attestationReasonCode,
  consumeAttestationChallenge,
  storeAttestationChallenge,
  verifyNewAccountAttestation
} from '../utils/webauthnAttestation.js'
// [2026-10-18] Normalisasi credential ID WebAuthn (Buffer → Base64URLString).
import { parseCredentialTransports, toBase64UrlCredentialId } from '../utils/webauthnCredentials.js'
import { Buffer } from 'buffer'
import { redisClient } from '../lib/redis.js'
// ✅ FIX: Import tipe JWT Payload dari shared
import { TransportOpCode, CRYPTO_VERSION_V2, ML_DSA_65_PUBLIC_KEY_BYTES, PQ_V2_DOMAINS, type AuthJwtPayload } from '@nyx/shared'
import { verifyMlDsaSignature } from '../utils/mlDsa.js'
// [LINK] Notifikasi permintaan tautan ke perangkat lama (relay yang sama dengan
// semua event KEY_SYNC lain — WSS maupun WebTransport).
import { sendJsonToUser } from '../network/redisBridge.js'

/**
 * [docs/28 Tier 0 — D7] Fingerprint perangkat = identifier ber-entropi rendah
 * (UA + language + timezone + screen + hardware), jadi hash mentahnya bisa
 * dienumerasi dari dump. Index dengan HMAC(pepper): nilai tetap deterministik
 * untuk binding percobaan login, tapi dump DB tidak memuat sidik jari mentah.
 * Catatan: baris lama (raw) tidak akan cocok lagi sekali — user cukup login
 * sekali untuk me-rebind nilai ter-index.
 */
function indexDeviceFingerprint(raw?: string | string[]): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value ? pepperedIdentifier(value) : undefined;
}

function getGenericDeviceName(userAgent?: string | string[]): string {
  if (!userAgent) return 'Unknown Device';
  const ua = String(userAgent);
  if (ua.includes('Windows')) return 'Windows Device';
  if (ua.includes('Android')) return 'Android Device';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS Device';
  if (ua.includes('Mac OS')) return 'Mac Device';
  if (ua.includes('Linux')) return 'Linux Device';
  return 'Web Browser Session';
}

const router: Router = Router()

router.get('/transport-ticket', requireAuth, (req, res) => {
  if (!req.user || !req.deviceId) {
    throw new ApiError(401, 'Session incomplete for ticket issuance');
  }
  
  const ticket = signTransportTicket({ 
    id: req.user.id, 
    deviceId: req.deviceId 
  });
  
  res.json({ ticket });
});

const rpName = 'NYX'
const getRpID = () => {
  try { return env.nodeEnv === 'production' ? 'nyx-app.my.id' : 'localhost' } catch (_e) { return 'localhost' }
}
const rpID = getRpID()
const expectedOrigin = env.corsOrigin || 'https://nyx-app.my.id'

function setAuthCookies (res: Response, { access, refresh }: { access: string; refresh: string }) {
  // [OPS 2026-10-25] Opsi (termasuk `domain` dari COOKIE_DOMAIN) dipakai bersama
  // `clearAuthCookies` supaya cookie tidak “set di satu domain, hapus di domain
  // lain”. Lihat utils/sessionUtils.ts.
  const cookieOptions: CookieOptions = authCookieOptions()
  res.cookie('at', access, { ...cookieOptions, maxAge: 1000 * 60 * 15 })
  res.cookie('rt', refresh, { ...cookieOptions, maxAge: 1000 * 60 * 60 * 24 * 30 })
}

async function issueTokens (user: { id: string, role?: string }, deviceId: string, req: Request, familyId?: string) {
  const accessJti = newJti()
  const access = signAccessToken({ id: user.id, role: user.role, deviceId, jti: accessJti })
  const refreshJti = newJti()
  const refresh = signAccessToken({ sub: user.id, jti: refreshJti, deviceId }, { expiresIn: '30d' })

  // [docs/28 Tier 0 — D5] ipAddress & userAgent TIDAK lagi dipersist: hash IP
  // tanpa kunci (8 byte) = enumerable (IPv4 2^32) dan userAgent plaintext = sidik
  // jari perangkat/browser. Daftar sesi memakai Device.name + flag isCurrent.

  // GUEST users (Burner Chat) are ephemeral and don't exist in the User/Device tables.
  // We skip DB persistence for their refresh tokens to avoid FK constraint violations.
  // Sama untuk deviceId kosong (recovery flow: login tanpa kunci lokal) — refresh token
  // tidak dipersist karena tidak ada device yang valid (FK RefreshToken_deviceId_fkey).
  if (user.role !== 'GUEST' && deviceId) {
    // Enforce "One User, One Active Device": Revoke all existing sessions for this user.
    // [2026-10-29] Dulu ada bypass 15 menit (`is_migrating`) untuk transfer vault
    // lewat QR; alur itu dihapus, jadi tidak boleh ada lagi jalur yang membuat
    // dua device sah bersamaan.
    await prisma.refreshToken.deleteMany({
        where: {
            device: { userId: user.id }
        }
    });

    // Generate familyId for token rotation tracking (reuse detection)
    const tokenFamilyId = familyId || crypto.randomUUID();

    await prisma.refreshToken.create({
      data: { jti: refreshJti, deviceId, familyId: tokenFamilyId, expiresAt: refreshExpiryDate() }
    })

    // Store active device in Redis for instant WebTransport validation (Lapis 1 Security)
    // [ROBUSTNESS] Bila deviceId BERUBAH (login di perangkat baru / setelah
    // logout), kirim sinyal invalidasi agar cache lokal 60s di SEMUA instance
    // dibuang — tanpa itu device baru yang sah diblokir ≤60s oleh cache yang
    // masih menyimpan deviceId lama. Device sama (refresh) tidak perlu sinyal.
    try {
      const activeDeviceKey = identityKey('active_device', user.id);
      const prevDevice = await redisClient.get(activeDeviceKey);
      if (prevDevice !== deviceId) {
        await redisClient.setEx(activeDeviceKey, 86400 * 30, deviceId); // 30 days
        await invalidateActiveDeviceCache(user.id, redisClient);
      } else {
        await redisClient.setEx(activeDeviceKey, 86400 * 30, deviceId); // 30 days
      }
    } catch (redisErr) {
      console.error('[Redis] Failed to set active device cache:', redisErr);
    }

    // [docs/28 Tier 2 — B4] Aktivitas user dipotong ke HARI; tulis hanya saat
    // hari berganti (updateMany = no-op bila sudah hari ini) supaya tidak ada
    // write tiap refresh. `lastActiveDay` menggantikan presisi `lastActiveAt`.
    try {
      await prisma.user.updateMany({
        where: { id: user.id, lastActiveDay: { lt: dayBucket() } },
        data: { lastActiveDay: dayBucket() },
      });
    } catch (activeErr) {
      console.warn('[Auth] Failed to update lastActiveDay:', activeErr);
    }
  }
  
  return { access, refresh, familyId: familyId || crypto.randomUUID() }
}

async function verifyTurnstileToken (token: string): Promise<boolean> {
  if (env.nodeEnv !== 'production' && !process.env.TURNSTILE_SECRET_KEY) return true
  if (!token) return false

  const verify = async (secret: string) => {
    const formData = new FormData()
    formData.append('secret', secret)
    formData.append('response', token)
    try {
      const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(5000)
      })
      const outcome = await result.json() as { success: boolean }
      return outcome.success
    } catch (e) {
      return false
    }
  }

  // 1. Try with configured secret
  const ok = await verify(process.env.TURNSTILE_SECRET_KEY || '')
  if (ok) return true

  // 2. If dev, try with dummy secret (for localhost sitekey: 1x00000000000000000000AA)
  if (env.nodeEnv !== 'production') {
    return await verify('1x0000000000000000000000000000000AA')
  }

  return false
}

const isValidBase64Url = (str: string, expectedBytes?: number) => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(str)) return false;
  if (expectedBytes) {
    try {
      const buf = Buffer.from(str, 'base64url');
      if (buf.byteLength !== expectedBytes) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const validateKey = (expectedBytes?: number) => z.string().refine(val => isValidBase64Url(val, expectedBytes), { message: `Invalid key format or length (expected ${expectedBytes || 'valid base64url'})` });

/**
 * [docs/30 §30.12 WS-H] Opsi attestation untuk pendaftaran akun baru.
 *
 * Publik (belum ada akun) dan dibatasi `authLimiter`. Attestation diminta
 * `direct` supaya statement attestation benar-benar dikirim, dan challenge-nya
 * disimpan sekali-pakai di Redis (`attestation:chal:*`, TTL 10 menit) — bukti
 * tidak bisa diputar ulang untuk membuat akun kedua.
 */
router.post('/register/attestation-options', authLimiter, async (_req, res, next) => {
  try {
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      // Belum ada akun: user id acak (tidak menautkan ke usernameHash apa pun).
      userID: crypto.randomBytes(32),
      userName: `nyx-new-account-${crypto.randomBytes(4).toString('hex')}`,
      attestationType: 'direct',
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        authenticatorAttachment: 'platform'
      }
    })

    await storeAttestationChallenge(redisClient, options.challenge)
    res.json(options)
  } catch (e) { next(e) }
})

router.post('/register', authLimiter, zodValidate({
  body: z.object({
    usernameHash: z.string().min(10),
    password: z.string().min(8).max(128),
    encryptedProfile: z.string().optional(),
    publicKey: validateKey(32),
    pqPublicKey: validateKey(1216).optional(),
    signingKey: validateKey(32),
    signingKeyV2: validateKey(ML_DSA_65_PUBLIC_KEY_BYTES).optional(),
    encryptedPrivateKeys: z.string().optional(),
    deviceName: z.string().optional(),
    turnstileToken: z.string().optional(),
    // [docs/30 §30.12 WS-H] Bukti attestation (diminta hanya bila gerbang menyala).
    attestation: z.object({
      challenge: z.string().min(1).max(256),
      response: z.unknown()
    }).optional(),
    // Perangkat tanpa authenticator sama sekali (desktop Linux tanpa security
    // key) tidak bisa *membuktikan* ketiadaan itu; klien hanya menyatakannya,
    // dan server menerimanya HANYA bila operator menyalakan
    // ABUSE_ATTESTATION_ALLOW_UNATTESTED. Akun yang lahir begini isVerified=false.
    attestationUnavailable: z.boolean().optional()
  })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password, encryptedProfile, publicKey, pqPublicKey, signingKey, signingKeyV2, encryptedPrivateKeys, deviceName, turnstileToken } = req.body

    const isHuman = await verifyTurnstileToken(turnstileToken || '')
    if (!isHuman) throw new ApiError(400, 'Bot detected. Please try again or reload page.')

    // [docs/28 Tier 0 — D6] Blind index disimpan TER-PEPPER (HMAC dari nilai
    // Argon2id klien): parameternya publik & salt-nya statis, jadi hash mentah
    // bisa dibangunkan rainbow table global. Dalam dump, tanpa pepper tidak ada
    // yang bisa dibalik. Kandidat kedua (nilai kiriman apa adanya) melayani
    // echo: klien bisa mengirim `usernameHash` ter-pepper yang dikembalikan
    // server (link berbagi profil) — lihat identifierLookupCandidates().
    const existingUser = await prisma.user.findFirst({
      where: { usernameHash: { in: identifierLookupCandidates(usernameHash) } },
      select: { id: true }
    })
    if (existingUser) throw new ApiError(409, 'Username already taken (Hash Collision).')

    const passwordHash = await hashPassword(password)
    
    const fingerprint = indexDeviceFingerprint(req.headers['x-nyx-fingerprint']);
    const _iid = req.headers['x-nyx-installation-id'];
    const installationId = typeof _iid === 'string' ? _iid : undefined;

    // [docs/30 §30.12 WS-H] Batasi pendaftaran massal per sumber (IP ter-HMAC,
    // bukan IP mentah), per instalasi, dan per jaringan (ASN dari tabel lokal).
    // No-op kecuali ABUSE_REGISTRATION_GUARD=on, sehingga jalan keluar/rollback
    // tidak butuh deploy logika baru.
    const burst = await enforceRegistrationBurst({ ip: cfAwareClientIp(req), installationId });

    // [docs/30 §30.12 WS-H langkah 2] Gerbang attestation perangkat: diwajibkan
    // oleh env (semua akun baru) ATAU oleh heuristik burst sybil per-ASN.
    // Diverifikasi SEBELUM akun dibuat — kegagalan tidak meninggalkan baris User.
    const attestationRequired = process.env.ABUSE_REQUIRE_ATTESTATION === 'on' || burst.requireAttestation;
    const attestationWaivable = mayWaiveAttestation(process.env, {
      requestedByBurst: burst.requireAttestation
    });
    let attestedCredential: {
      credentialId: string;
      publicKey: Uint8Array<ArrayBuffer>;
      counter: number;
      deviceType: string;
      backedUp: boolean;
      tier: string;
    } | null = null;

    if (attestationRequired) {
      const proof = req.body.attestation as { challenge: string; response: unknown } | undefined;
      if (!proof) {
        if (attestationWaivable && req.body.attestationUnavailable === true) {
          // Perangkat tanpa authenticator sama sekali (desktop Linux tanpa
          // platform authenticator maupun security key). Tidak ada bukti yang
          // bisa dikirim — klien menyatakannya, server menerima HANYA karena
          // operator menyalakan ABUSE_ATTESTATION_ALLOW_UNATTESTED. Akun lahir
          // dengan isVerified=false, jadi sandbox (upload, pencarian luas)
          // tetap tertutup; metrik membuat populasi ini terlihat.
          incCounter(ATTESTATION_REGISTRATION, { result: 'unattested', reason: 'no_authenticator' });
          console.warn(
            '[WS-H] Akun baru dibuat TANPA attestation: perangkat tanpa authenticator (ABUSE_ATTESTATION_ALLOW_UNATTESTED=on). isVerified=false.'
          );
        } else {
          // Bukan kegagalan keamanan: perangkat/klien belum menjalankan upacara
          // WebAuthn (mis. tanpa authenticator platform). Tetap dihitung — lonjakan
          // di sini berarti kebijakan tidak terpenuhi di sisi klien.
          incCounter(ATTESTATION_REGISTRATION, { result: 'missing', reason: 'none' });
          throw new ApiError(428, 'ATTESTATION_REQUIRED');
        }
      } else {
        const challengeAlive = await consumeAttestationChallenge(redisClient, proof.challenge);
        if (!challengeAlive) {
          incCounter(ATTESTATION_REGISTRATION, { result: 'challenge_invalid', reason: 'none' });
          throw new ApiError(403, 'ATTESTATION_CHALLENGE_INVALID');
        }

        let verification;
        try {
          verification = await verifyNewAccountAttestation({
            response: proof.response,
            expectedChallenge: proof.challenge,
            expectedOrigin,
            expectedRPID: rpID,
            policy: attestationPolicyFromEnv()
          });
        } catch (verifyErr) {
          // Respons tidak sah menurut pustaka (struktur/tanda tangan) → tolak, jangan 500.
          console.warn('[WS-H] Attestation akun baru tidak sah:', verifyErr);
          incCounter(ATTESTATION_REGISTRATION, { result: 'malformed', reason: 'none' });
          throw new ApiError(403, 'ATTESTATION_INVALID');
        }

        if (!verification.verified || !verification.credentialId || !verification.credentialPublicKey) {
          // Penolakan KEBIJAKAN: kripto sah, tapi buktinya tidak memenuhi kriteria
          // perangkat. Alasannya dipetakan ke kode pendek (`root_not_trusted`, …)
          // supaya kedua aturan alert attestation bisa membedakannya.
          //
          // Metadata ini ikut dicatat karena `NOT_HARDWARE_ATTESTATION` punya dua
          // penyebab yang butuh tindakan BERBEDA: browser yang tidak meneruskan
          // attestation sama sekali (Firefox Android) vs passkey tersinkron milik
          // Google/Apple Password Manager, yang memang tidak membawa bukti
          // perangkat dan ditandai `multiDevice`. Tanpa AAGUID + jenis kredensial,
          // operator hanya melihat "perangkat tidak bisa" tanpa tahu apakah yang
          // perlu diganti browser atau memang kebijakannya tidak cocok.
          console.warn('[WS-H] Attestation akun baru ditolak:', {
            reason: verification.reason ?? 'UNKNOWN',
            tier: verification.tier,
            aaguid: verification.aaguid ?? 'none',
            deviceType: verification.credentialDeviceType ?? 'unknown',
            backedUp: verification.credentialBackedUp
          });
          incCounter(ATTESTATION_REGISTRATION, {
            result: 'rejected',
            reason: attestationReasonCode(verification.reason)
          });
          throw new ApiError(403, `ATTESTATION_REJECTED: ${verification.reason ?? 'UNKNOWN'}`);
        }

        incCounter(ATTESTATION_REGISTRATION, { result: 'accepted', reason: 'none' });

        attestedCredential = {
          credentialId: verification.credentialId,
          publicKey: verification.credentialPublicKey,
          counter: verification.counter,
          deviceType: verification.credentialDeviceType ?? 'singleDevice',
          backedUp: verification.credentialBackedUp,
          tier: verification.tier
        };
      }
    }

    const user = await prisma.user.create({
      data: {
        usernameHash: pepperedIdentifier(usernameHash),
        // [docs/35 Fase 4a] Index OPRF untuk pencarian; NULL bila gate mati.
        oprfIndex: searchOprfIndexForIdentifier(usernameHash),
        // [docs/28 §R5] ID publik terpisah dari blind index.
        shareId: generateShareId(),
        passwordHash,
        // [docs/28 Tier 2 — B4] hari pendaftaran (bucket harian), bukan detik.
        lastActiveDay: dayBucket(),
        encryptedProfile,
        // [WS-H] Hanya attestation ber-tier `hardware` yang menandai akun
        // terverifikasi. Bila operator menyalakan `ABUSE_ATTESTATION_ALLOW_NONE`
        // (passkey tersinkron Google/Apple — `fmt: none`, `multiDevice`) akun
        // tetap dibuat, tapi `isVerified` dibiarkan false: tidak ada bukti
        // perangkat yang bisa diklaim, dan upload/aksi yang butuh verifikasi
        // tidak boleh terbuka hanya karena upacara WebAuthn selesai.
        isVerified: attestedCredential?.tier === 'hardware',
        authenticators: attestedCredential
          ? {
              create: [
                {
                  id: nanoid(),
                  credentialID: attestedCredential.credentialId,
                  credentialPublicKey: isoBase64URL.fromBuffer(attestedCredential.publicKey),
                  counter: BigInt(attestedCredential.counter),
                  credentialDeviceType: attestedCredential.deviceType,
                  credentialBackedUp: attestedCredential.backedUp
                }
              ]
            }
          : undefined,
        devices: {
          create: {
            // FIX 1: Safe Buffer conversion for optional inputs
            publicKey: Buffer.from(publicKey, 'base64url'),
            pqPublicKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : null,
            signingKey: Buffer.from(signingKey, 'base64url'),
            ...(signingKeyV2 && {
              signingKeyV2: Buffer.from(signingKeyV2, 'base64url'),
              cryptoVersion: CRYPTO_VERSION_V2
            }),
            encryptedPrivateKey: encryptedPrivateKeys ? Buffer.from(encryptedPrivateKeys, 'utf8') : null,
            // [docs/28 Tier 1.5] label & anchor perangkat tidak pernah plaintext.
            nameSealed: await sealAtRest(deviceName || 'Primary Device'),
            fingerprint: fingerprint || null,
            installationTag: installationId ? deviceInstallationTag(installationId) : null
          }
        }
      },
      include: {
        devices: true
      }
    })

    const device = user.devices[0]
    if (!device) throw new ApiError(500, 'Registration succeeded but device was not created.')
    const deviceId = device.id

    // User baru harus bisa dicari setelah snapshot berikutnya (≤ 3 menit).
    void markPirSnapshotDirty('register')

    // [docs/30 §30.5 WS-A] Catat kunci publik di log KT (no-op tanpa KT_V2_SERVER_URL).
    // Fire-and-forget: latensi registrasi tidak bergantung pada log; kegagalan
    // terlihat sebagai metrik `nyx_kt_writes_total{result="error"}` + log
    // (search key ter-hash, tanpa identitas).
    void publishKeyTransparencyEntry({
      usernameHash,
      identityKey: Buffer.from(publicKey, 'base64url'),
      pqIdentityKey: Buffer.from(pqPublicKey ?? '', 'base64url'),
      signingKey: Buffer.from(signingKey, 'base64url'),
      signingKeyV2: signingKeyV2 ? Buffer.from(signingKeyV2, 'base64url') : null,
      keyVersion: KT_KEY_VERSION_REGISTRATION,
      updatedAtDay: Math.floor(dayBucket().getTime() / 86_400_000),
    });
    const tokens = await issueTokens(user, deviceId, req)
    setAuthCookies(res, tokens)

    res.status(201).json({
      message: 'Registration successful.',
      user: { id: user.id, usernameHash: user.usernameHash, shareId: user.shareId, encryptedProfile: user.encryptedProfile, isVerified: user.isVerified, subscriptionTier: user.subscriptionTier },
      accessToken: tokens.access,
      deviceId,
      needVerification: false,
      // Tier attestation yang diterima (`hardware`/`self`), null bila gerbang mati.
      attestationTier: attestedCredential?.tier ?? null
    })
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e as Record<string, unknown>).code === 'P2002') {
      return next(new ApiError(409, 'Username already taken.'))
    }
    next(e)
  }
})

router.post('/login', authLimiter, zodValidate({
  body: z.object({
    usernameHash: z.string().min(10),
    password: z.string().min(8),
    publicKey: validateKey(32).optional(),
    pqPublicKey: validateKey(1216).optional(),
    signingKey: validateKey(32).optional(),
    encryptedPrivateKey: z.string().optional(),
    deviceName: z.string().optional(),
    deviceId: z.string().optional()
  })
}),async (req, res, next) => {
  try {
    const { usernameHash, password, publicKey, pqPublicKey, signingKey, encryptedPrivateKey, deviceName } = req.body
    const explicitDeviceId = req.body.deviceId;
    const fingerprint = indexDeviceFingerprint(req.headers['x-nyx-fingerprint']);
    const _iid = req.headers['x-nyx-installation-id'];
    const installationId = typeof _iid === 'string' ? _iid : undefined;

    const user = await prisma.user.findFirst({
      where: { usernameHash: { in: identifierLookupCandidates(usernameHash) } },
      include: {
        devices: { orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }] }
      }
    })

    if (!user) throw new ApiError(401, 'Invalid credentials')
    if (user.bannedAt) return res.status(403).json({ error: 'ACCESS DENIED: Your account has been suspended.', reason: user.banReason })

    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) throw new ApiError(401, 'Invalid credentials')

    // [docs/35 Fase 4a] Segarkan index OPRF saat login. Login adalah satu-satunya
    // tempat server menerima hash Argon2 mentah, jadi bila seed OPRF/pepper
    // berubah, ini kesempatan memperbaiki baris lama (bukan hanya NULL).
    // Kegagalan tidak boleh menggagalkan login.
    const oprfIndex = searchOprfIndexForIdentifier(usernameHash);
    if (oprfIndex && oprfIndex !== user.oprfIndex) {
      try {
        await prisma.user.update({ where: { id: user.id }, data: { oprfIndex } });
        console.info('[OPRF] oprfIndex disegarkan saat login');
        // Index berubah = record PIR lama tidak lagi cocok dengan query klien.
        void markPirSnapshotDirty('login-oprf-index')
      } catch (error) {
        console.warn('[OPRF] gagal menyegarkan oprfIndex saat login:', error);
      }
    }

    let activeDeviceId = '';
    let activeEncryptedPrivateKey = '';
    let identityChanged = false;

    if (publicKey && signingKey && encryptedPrivateKey) {
      let device = null;
      
      if (explicitDeviceId) {
        device = await prisma.device.findFirst({
          where: { id: explicitDeviceId, userId: user.id }
        });
      }
      
      if (!device) {
        device = await prisma.device.findFirst({
          where: {
            userId: user.id,
            publicKey: Buffer.from(publicKey, 'base64url')
          }
        });
      }
      
      // [docs/30 §30.5 WS-A] Material identitas SEBELUM update — dasar keputusan
      // "kunci benar-benar berubah": login normal mengirim kunci yang SAMA, jadi
      // hanya regenerasi kunci lokal yang menghasilkan entri log.
      const previousIdentity = device
        ? { publicKey: device.publicKey, signingKey: device.signingKey, signingKeyV2: device.signingKeyV2 }
        : null;

      if (device) {
          device = await prisma.device.update({
              where: { id: device.id },
              data: { 
                lastActiveAt: deviceActivityBucket(), 
                // Update hardware binding
                fingerprint: fingerprint || device.fingerprint,
                installationTag: installationId ? deviceInstallationTag(installationId) : device.installationTag,
                // Update keys in case they were regenerated locally
                publicKey: Buffer.from(publicKey, 'base64url'),
                pqPublicKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : device.pqPublicKey,
                signingKey: Buffer.from(signingKey, 'base64url'), 
                encryptedPrivateKey: Buffer.from(encryptedPrivateKey, 'utf8'), 
                nameSealed: await sealAtRest(deviceName || getGenericDeviceName(req.headers['user-agent']))
              }
          });
      } else {
          device = await prisma.device.create({
            data: {
              userId: user.id,
              publicKey: Buffer.from(publicKey, 'base64url'),
              pqPublicKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : null,
              signingKey: Buffer.from(signingKey, 'base64url'),
              encryptedPrivateKey: Buffer.from(encryptedPrivateKey, 'utf8'),
              nameSealed: await sealAtRest(deviceName || getGenericDeviceName(req.headers['user-agent'])),
              fingerprint: fingerprint || null,
              installationTag: installationId ? deviceInstallationTag(installationId) : null
            }
          });
      }
      activeDeviceId = device.id;
      activeEncryptedPrivateKey = device.encryptedPrivateKey ? Buffer.from(device.encryptedPrivateKey).toString('utf8') : '';

      // [docs/30 §30.5 WS-A] Kunci identitas yang berubah di jalur login WAJIB
      // terlihat di log. Kepemilikan identifier di sini terbukti oleh login itu
      // sendiri: `usernameHash` dari body dipakai `identifierLookupCandidates`
      // untuk menemukan akun ini, dan password sudah diverifikasi di atas.
      identityChanged = identityKeysChanged(previousIdentity, {
        identityKey: Buffer.from(publicKey, 'base64url'),
        signingKey: Buffer.from(signingKey, 'base64url'),
        signingKeyV2: previousIdentity?.signingKeyV2 ?? undefined,
      });
      // Perangkat baru (belum ada barisnya) atau kunci identitas yang berubah
      // mengubah record PIR (snapshot memakai device terakhir).
      if (!previousIdentity || identityChanged) {
        void markPirSnapshotDirty('login-device')
      }

      if (identityChanged) {
        void publishIdentityKeyChange({
          userId: user.id,
          usernameHash,
          identityKey: Buffer.from(publicKey, 'base64url'),
          pqIdentityKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : null,
          signingKey: Buffer.from(signingKey, 'base64url'),
          signingKeyV2: previousIdentity?.signingKeyV2 ?? null,
        });
      }

    } else {
      if (explicitDeviceId) {
          const device = user.devices.find(d => d.id === explicitDeviceId);
          
          // SECURITY CHECK: If device exists but fingerprint MISMATCHES, 
          // it means the browser data (LocalStorage) was cloned to a different hardware.
          if (device && device.fingerprint && fingerprint && device.fingerprint !== fingerprint) {
              // Toleransi: Jika anchor instalasi masih cocok, kita izinkan update fingerprint
              // [docs/28 Tier 1.5] kolom menyimpan TAG → bandingkan nilai ter-tag.
              if (device.installationTag && installationId && device.installationTag === deviceInstallationTag(installationId)) {
                  await prisma.device.update({
                      where: { id: device.id },
                      data: { fingerprint, lastActiveAt: deviceActivityBucket() }
                  });
                  activeDeviceId = device.id;
              } else {
                  console.warn(`[Security] Hardware/Anchor mismatch for device ${explicitDeviceId}. Forcing recovery flow.`);
                  activeDeviceId = ''; 
              }
          } else {
              if (!device) throw new ApiError(404, 'Specified device not found.');
              activeDeviceId = device.id;
              activeEncryptedPrivateKey = device.encryptedPrivateKey ? Buffer.from(device.encryptedPrivateKey).toString('utf8') : '';
              
              // Update last active and sync IDs if missing
              await prisma.device.update({ 
                where: { id: device.id }, 
                data: { 
                  lastActiveAt: deviceActivityBucket(),
                  fingerprint: fingerprint || device.fingerprint,
                  installationTag: installationId ? deviceInstallationTag(installationId) : device.installationTag
                } 
              });
          }
      }

      // If no valid device ID found (either not provided or failed fingerprint check)
      if (!activeDeviceId) {
          if (user.devices.length === 0) throw new ApiError(404, 'No device found. Please recover your account.');
          
          // DO NOT blindly pick the first device! 
          // If we are here, it means this is a new device or the fingerprint mismatched.
          // We must force the client into the recovery flow to establish a new device identity.
          activeDeviceId = '';
          activeEncryptedPrivateKey = '';
      }
    }

    // [docs/34 §34.6] Populasi v2 untuk akun lama, opt-in. Hanya bila kunci
    // tidak berubah (rotasi sudah menulis v2 sendiri) dan perangkat punya
    // ML-DSA-65; login sudah membuktikan kepemilikan identifier.
    if (
      !identityChanged &&
      activeDeviceId &&
      process.env.KT_V2_BACKFILL_ON_LOGIN === '1' &&
      process.env.KT_V2_SERVER_URL
    ) {
      const activeDevice = user.devices.find((d) => d.id === activeDeviceId);
      if (activeDevice?.signingKeyV2?.length) {
        void backfillKtV2IdentityOnLogin({
          usernameHash,
          identityKey: activeDevice.publicKey,
          pqIdentityKey: activeDevice.pqPublicKey,
          signingKey: activeDevice.signingKey,
          signingKeyV2: activeDevice.signingKeyV2,
        });
      }
    }

    const safeUser = { id: user.id, usernameHash: user.usernameHash, shareId: await ensureUserShareId(user), encryptedProfile: user.encryptedProfile, isVerified: user.isVerified, role: user.role, subscriptionTier: user.subscriptionTier }

    const tokens = await issueTokens(safeUser, activeDeviceId, req)
    setAuthCookies(res, tokens)

    res.json({ 
      user: safeUser, 
      accessToken: tokens.access,
      deviceId: activeDeviceId,
      encryptedPrivateKey: activeEncryptedPrivateKey 
    })
  } catch (e) {
    next(e)
  }
})

/**
 * Endpoint khusus untuk memberikan JWT sementara kepada Guest (Burner Chat).
 * Tanpa password, tanpa registrasi permanen.
 */
// [AUDIT 2026-10-24] Guest = identitas baru + bucket rate limit baru, jadi
// pembuatannya harus dibatasi per IP (lihat `burnerLimiter`).
router.post('/burner', burnerLimiter, async (req, res, next) => {
  try {
    const guestId = `guest_${crypto.randomUUID().substring(0, 8)}`;
    const guestDeviceId = `burner_${crypto.randomUUID().substring(0, 8)}`;
    
    // Kita berikan token dengan role GUEST
    const tokens = await issueTokens({ id: guestId, role: 'GUEST' }, guestDeviceId, req);
    setAuthCookies(res, tokens);
    
    res.json({
      accessToken: tokens.access,
      user: {
        id: guestId,
        role: 'GUEST',
        usernameHash: 'anonymous_guest'
      },
      deviceId: guestDeviceId
    });
  } catch (e) { next(e) }
})

router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.rt
    if (!token) throw new ApiError(401, 'No refresh token')
    const payload = verifyJwt(token) as { jti?: string; sub?: string; deviceId?: string } | string | null;
    if (typeof payload === 'string' || !payload?.jti || !payload?.sub || !payload?.deviceId) {
      clearAuthCookies(res)
      throw new ApiError(401, 'Invalid refresh token')
    }

    let basis = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } })
    if (!basis) {
      // [BURNER GUEST] Refresh token guest memang TIDAK pernah dipersist (lihat
      // issueTokens) → "tidak ditemukan" di sini normal untuk halaman /drop.
      // JANGAN clear cookie: `at` masih sah dan `GET /api/auth/transport-ticket`
      // butuh cookie itu, kalau dibersihkan uplink burner tidak pernah naik.
      if (isEphemeralGuestSubject(payload.sub)) {
        throw new ApiError(401, 'Guest sessions are ephemeral and cannot be refreshed.');
      }
      // Token doesn't exist in DB at all — either never existed or was fully deleted.
      // Clear cookies and require re-login.
      clearAuthCookies(res)
      throw new ApiError(401, 'Refresh token not found. Please login again.');
    }

    // --- REUSE DETECTION ---
    // A presented token that was already revoked/replaced is a duplicate of a
    // rotation. This can be EITHER a genuine reuse attack (stolen token replayed)
    // OR a benign concurrent/duplicate request from the same browser — e.g. the
    // main app tab and the burner "/drop" tab both bootstrap and refresh with the
    // SAME httpOnly `rt` cookie at the same instant. We must NOT brick the whole
    // session family for the benign case.
    if (basis.revokedAt || basis.replacedById) {
      // [BUGFIX 2026-10-18] Dulu: toleransi 5 detik berbasis `now - newest.createdAt`.
      // Retry klien yang wajar (timeout request 30 s + backoff, tab di-freeze)
      // melewati jendela itu → family di-revoke → `force_logout` ke SEMUA device
      // → user ter-logout sendiri dengan `/login?reason=revoked`.
      // Sekarang keputusan diambil helper murni (utils/refreshReplay.ts):
      //   session_ended → family sudah mati, 401 biasa tanpa alarm/broadcast;
      //   benign        → penerus langsung & dalam jendela toleransi;
      //   reuse         → benar-benar token lama di luar rantai → revoke.
      const tip = await prisma.refreshToken.findFirst({
        where: { familyId: basis.familyId, deviceId: basis.deviceId, revokedAt: null, replacedById: null },
        orderBy: { createdAt: 'desc' },
      });

      const graceMs = refreshReplayGraceMs();
      const decision = classifyRefreshReplay({
        presentedId: basis.id,
        tip: tip ? { id: tip.id, replacesId: tip.replacedById, createdAt: tip.createdAt } : null,
        now: Date.now(),
        graceMs,
      });

      if (decision === 'benign' && tip) {
        // Benign: tab/jendela lain (atau retry setelah respons hilang) sudah
        // merotasi token ini. Lanjutkan rantai dari token hidup terbaru.
        console.info(`[Auth] Concurrent refresh detected (token superseded within ${graceMs}ms) — continuing session.`);
        basis = tip;
      } else if (decision === 'session_ended') {
        // Tidak ada token hidup: sesi ini memang sudah berakhir (logout di tab
        // lain, revokasi sesi, cleanup). Jangan alarm & jangan broadcast
        // `force_logout` — tidak ada sesi hidup yang perlu dilindungi, dan
        // broadcast itulah yang dulu me-logout device lain yang masih sah.
        console.info(`[Auth] Refresh with token from an ended session (family already revoked) — 401 without alarm.`);
        clearAuthCookies(res);
        throw sessionEndedError();
      } else {
        console.warn(`[Security] Refresh token reuse detected! Device: ${basis.deviceId.slice(0, 8)}…, Family: ${basis.familyId}`);

        // Revoke ALL tokens in this family (compromise containment) + Redis blacklist
        await revokeFamily(basis.familyId)

        // Clear cookies
        clearAuthCookies(res)

        // [BUGFIX 2026-10-18] Scope ke device asal replay. Dulu event tanpa
        // deviceId → setiap socket milik user (termasuk perangkat lain yang
        // sesinya masih sah) ikut logout.
        try {
          const { emitEventToUser } = await import('../network/redisBridge.js');
          await emitEventToUser(
            payload.sub,
            'force_logout',
            { reason: 'session_hijacked', deviceId: basis.deviceId },
            basis.deviceId,
          );
        } catch (_e) {}

        throw new ApiError(401, 'Refresh token reuse detected. All sessions in this family have been revoked for security.');
      }
    }

    if (basis.expiresAt < new Date()) {
      clearAuthCookies(res)
      throw new ApiError(401, 'Refresh token expired')
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) throw new ApiError(401, 'User not found')
    if (user.bannedAt) throw new ApiError(403, `ACCESS DENIED: ${user.banReason || 'Account suspended'}`)

    // --- PROPER ROTATION WITH FAMILY CHAIN ---
    // 1. Mark old token as replaced (don't delete — keep for reuse detection)
    const newJtiValue = newJti();
    await prisma.refreshToken.update({
      where: { jti: basis.jti },
      data: { revokedAt: new Date() }
    });

    // 2. Create new token linked to the old one via replacedById chain
    const access = signAccessToken({ id: user.id, role: user.role, deviceId: basis.deviceId, jti: newJti() });
    const refresh = signAccessToken({ sub: user.id, jti: newJtiValue, deviceId: basis.deviceId }, { expiresIn: '30d' });

    await prisma.refreshToken.create({
      data: {
        jti: newJtiValue,
        familyId: basis.familyId,
        deviceId: basis.deviceId,
        expiresAt: refreshExpiryDate(),
        replacedById: basis.id // Link to the previous token in the chain
      }
    });

    // Update Redis active device
    // [ROBUSTNESS] Paritas dengan issueTokens: invalidate bila device berubah.
    try {
      const activeDeviceKey = identityKey('active_device', user.id);
      const prevDevice = await redisClient.get(activeDeviceKey);
      if (prevDevice !== basis.deviceId) {
        await redisClient.setEx(activeDeviceKey, 86400 * 30, basis.deviceId);
        await invalidateActiveDeviceCache(user.id, redisClient);
      } else {
        await redisClient.setEx(activeDeviceKey, 86400 * 30, basis.deviceId);
      }
    } catch (_e) {}

    setAuthCookies(res, { access, refresh });
    res.json({ ok: true, accessToken: access });
  } catch (e) {
    next(e)
  }
})

router.get('/recover/challenge', authLimiter, async (req, res, next) => {
  try {
    const { identifier } = req.query;
    if (!identifier || typeof identifier !== 'string') throw new ApiError(400, "Identifier is required.");
    const sodium = await getSodium();
    const nonce = sodium.to_hex(sodium.randombytes_buf(32));
    // [docs/28 Tier 0 — D6/D14] Nonce di-key oleh identifier TER-PEPPER — Redis
    // juga termasuk artefak yang harus tahan dump (tidak memuat identifier mentah).
    await redisClient.setEx(`recover_nonce:${pepperedIdentifier(identifier)}`, 300, nonce);
    res.json({ nonce });
  } catch (e) { next(e); }
});

router.post('/recover', authLimiter, zodValidate({
  body: z.object({
    identifier: z.string().min(10),
    newPassword: z.string().min(8),
    newEncryptedKeys: z.string(),
    publicKey: validateKey(32),
    pqPublicKey: validateKey(1216).optional(),
    signingKey: validateKey(32),
    signingKeyV2: validateKey(ML_DSA_65_PUBLIC_KEY_BYTES).optional(),
    // [PQ-only 2026-10-23] `signature` (Ed25519) masih diterima bentuknya agar
    // klien lama tidak kena 400 schema, tetapi TIDAK diverifikasi.
    signature: z.string().optional(),
    signatureV2: z.string().optional(),
    timestamp: z.number(),
    nonce: z.string()
  })
}), async (req, res, next) => {
  try {
    const { identifier: usernameHash, newPassword, newEncryptedKeys, publicKey, pqPublicKey, signingKey, signingKeyV2, signatureV2, timestamp, nonce } = req.body;

    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) throw new ApiError(400, "Recovery request expired.");

    // Kandidat kunci: [ter-pepper, nilai kiriman] — tahan terhadap klien yang
    // mengirim bentuk berbeda antara /recover/challenge dan /recover/verify
    // (bisa Argon2id mentah atau hash ter-pepper yang di-echo server).
    let cachedNonce: string | null = null;
    for (const candidate of identifierLookupCandidates(usernameHash)) {
      const key = `recover_nonce:${candidate}`;
      const value = await redisClient.get(key);
      if (value) {
        cachedNonce = value;
        await redisClient.del(key);
        break;
      }
    }
    if (!cachedNonce || cachedNonce !== nonce) throw new ApiError(401, "Invalid or expired recovery challenge.");

    const user = await prisma.user.findFirst({
      where: { usernameHash: { in: identifierLookupCandidates(usernameHash) } },
      include: { devices: true }
    });
    if (!user || user.devices.length === 0) throw new ApiError(404, "User not found or invalid keys.");

    const { getSodium } = await import('../lib/sodium.js');
    const sodium = await getSodium();
    const pqKeyStr = pqPublicKey || "";
    const messageString = `${usernameHash}:${timestamp}:${nonce}:${newPassword}:${newEncryptedKeys}:${publicKey}:${pqKeyStr}:${signingKey}`;
    const messageBytes = Buffer.from(messageString, 'utf-8');
    // [PQ v2 Fase 1.5 langkah 9] Pemulihan bisa ditandatangani ML-DSA (v1 tetap diterima).
    let signatureV2Bytes: Uint8Array | null = null;
    if (signatureV2) {
        try {
            signatureV2Bytes = sodium.from_base64(signatureV2, sodium.base64_variants.URLSAFE_NO_PADDING);
        } catch {
            throw new ApiError(400, "Invalid v2 recovery signature encoding.");
        }
    }

    // [PQ-only 2026-10-23] Pemulihan WAJIB ditandatangani ML-DSA (v2). Tanda
    // tangan Ed25519 v1 tidak lagi diverifikasi — `signature` tetap diterima di
    // body hanya agar klien lama mendapat 401 yang jelas, bukan 400 schema.
    if (!signatureV2Bytes) {
        throw new ApiError(401, "Recovery signatureV2 (ML-DSA) wajib.");
    }
    let isValid = false;
    for (const device of user.devices) {
        if (!device.signingKeyV2) continue;
        try {
            if (verifyMlDsaSignature({
                signature: signatureV2Bytes,
                message: new Uint8Array(messageBytes),
                publicKey: new Uint8Array(device.signingKeyV2),
                domain: PQ_V2_DOMAINS.RECOVERY,
            })) {
                isValid = true;
                break;
            }
        } catch(e) { console.warn("[Auth] Recovery v2 signature verification error:", e); }
    }

    if (!isValid) throw new ApiError(401, "Cryptographic signature verification failed.");

    if (!publicKey || !signingKey || !newEncryptedKeys) {
      throw new ApiError(400, 'Missing required cryptographic keys or encrypted private keys.');
    }

    const passwordHash = await hashPassword(newPassword);

    const fingerprint = indexDeviceFingerprint(req.headers['x-nyx-fingerprint']);
    const _iid = req.headers['x-nyx-installation-id'];
    const installationId = typeof _iid === 'string' ? _iid : undefined;

    // [docs/28 Tier 1.5] seal/tag dihitung SEBELUM transaksi array (nilainya statis).
    const recoveredDeviceNameSealed = await sealAtRest('Recovered Device');
    const recoveredInstallationTag = installationId ? deviceInstallationTag(installationId) : null;

    const [updatedUser, _, __, newDevice] = await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
        prisma.device.deleteMany({ where: { userId: user.id } }), 
        prisma.authenticator.deleteMany({ where: { userId: user.id } }), 
        prisma.device.create({ 
          data: {
            userId: user.id,
            // FIX 4: Safe buffer conversion for Recovery creation
            publicKey: Buffer.from(publicKey, 'base64url'),
            pqPublicKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : null,
            signingKey: Buffer.from(signingKey, 'base64url'),
            ...(signingKeyV2 && {
              signingKeyV2: Buffer.from(signingKeyV2, 'base64url'),
              cryptoVersion: CRYPTO_VERSION_V2
            }),
            encryptedPrivateKey: newEncryptedKeys ? Buffer.from(newEncryptedKeys, 'utf8') : null,
            nameSealed: recoveredDeviceNameSealed,
            fingerprint: fingerprint || null,
            installationTag: recoveredInstallationTag
          }
        })
    ]);

    // [docs/30 §30.5 WS-A] Pemulihan akun = kunci identitas baru → wajib terlihat
    // di log KT. `usernameHash` di sini adalah `identifier` dari klien; bila klien
    // mengirim bentuk ter-pepper (bukan Argon2id mentah 32 byte), entri dilewati
    // dengan peringatan — server tidak bisa menurunkan search key dari pepper.
    void publishKeyTransparencyEntry({
      usernameHash,
      identityKey: Buffer.from(publicKey, 'base64url'),
      pqIdentityKey: Buffer.from(pqPublicKey ?? '', 'base64url'),
      signingKey: Buffer.from(signingKey, 'base64url'),
      signingKeyV2: signingKeyV2 ? Buffer.from(signingKeyV2, 'base64url') : null,
      keyVersion: KT_KEY_VERSION_RECOVERY,
      updatedAtDay: Math.floor(dayBucket().getTime() / 86_400_000),
    });

    const tokens = await issueTokens(updatedUser, newDevice.id, req);    
    setAuthCookies(res, tokens);
    res.json({ message: "Account recovered successfully.", accessToken: tokens.access });
  } catch (e) { next(e); }
});

// ===========================================================================
// [LINK 2026-10-18] Pairing perangkat baru lewat QR — sisi server.
// ===========================================================================
//
// Sebelum ini hanya ada separuh fitur (`auth:request_linking_qr` membuat token
// lalu meng-emit QR yang tidak bisa dipakai siapa pun). Sekarang:
//   POST /api/auth/link/claim     (publik)  → bakar token, buat pending
//   GET  /api/auth/link/status/:id (publik) → pending | approved | expired
//   POST /api/auth/link/approve   (auth)    → buat Device row untuk perangkat baru
//   POST /api/auth/link/deny      (auth)    → batalkan
//   POST /api/auth/link/complete  (publik)  → { deviceId, usernameHash }
//
// `complete` SENGAJA tidak menerbitkan token sesi: klien lalu memakai alur
// `/login` yang sudah ada (verifikasi password + dekripsi kunci lokal), jadi
// hanya ada SATU jalur pembuatan sesi — tidak ada jalur token kedua yang harus
// diaudit. Kunci privat perangkat baru dibuat & dienkripsi di klien; server
// hanya menyimpan bundel terenkripsi (sama seperti /register).

const linkStore: LinkingStore = {
  get: (key) => redisClient.get(key),
  setEx: (key, ttlSeconds, value) => redisClient.setEx(key, ttlSeconds, value),
  del: async (...keys) => {
    if (keys.length === 0) return 0;
    return redisClient.del(keys);
  },
  // [audit F-11] Baca-bakar atomik untuk token QR (cek+lalu dihapus bisa balapan).
  getDel: (key) => redisClient.getDel(key),
};

const linkSealer: LinkingSealer = { seal: sealAtRest, open: openAtRest };

router.post('/link/claim', authLimiter, zodValidate({
  body: z.object({
    token: z.string().regex(LINK_TOKEN_PATTERN),
    publicKey: validateKey(32),
    pqPublicKey: validateKey(1216).optional(),
    signingKey: validateKey(32),
    signingKeyV2: validateKey(ML_DSA_65_PUBLIC_KEY_BYTES).optional(),
    encryptedPrivateKey: z.string().min(1),
    deviceName: z.string().max(64).optional(),
  })
}), async (req, res, next) => {
  try {
    const { token, publicKey, pqPublicKey, signingKey, signingKeyV2, encryptedPrivateKey, deviceName } = req.body;
    // [docs/35 Fase 8 residual] Perangkat baru tanpa kunci verifikasi ML-DSA =
    // klien v1 yang masih menautkan device; penghapusan fallback ini harus
    // menunggu angka ini nol.
    if (!signingKeyV2) incCounter(LEGACY_V1_USAGE, { path: 'device-link' });

    // Token sekali pakai: dibakar walaupun langkah berikutnya gagal. Tanpa ini,
    // token yang sempat terlihat (mis. screenshot QR) bisa dipakai ulang.
    const owner = await consumeLinkToken(linkStore, linkSealer, token);
    if (!owner) throw new ApiError(401, 'Invalid or expired linking token.');

    // Binding hardware diambil dari PERANGKAT BARU (request claim ini), bukan
    // dari perangkat yang menyetujui — kalau tertukar, login berikutnya di
    // perangkat baru akan dianggap "hardware mismatch" dan dipaksa recovery.
    const newDeviceInstallationId = typeof req.headers['x-nyx-installation-id'] === 'string'
      ? req.headers['x-nyx-installation-id']
      : undefined;

    const pendingId = await createPendingLink(linkStore, linkSealer, {
      userId: owner.userId,
      requestDeviceId: owner.deviceId,
      deviceName: deviceName || undefined,
      publicKey,
      pqPublicKey: pqPublicKey || undefined,
      signingKey,
      signingKeyV2: signingKeyV2 || undefined,
      encryptedPrivateKey,
      fingerprint: indexDeviceFingerprint(req.headers['x-nyx-fingerprint']),
      installationTag: newDeviceInstallationId ? deviceInstallationTag(newDeviceInstallationId) : null,
    });

    // Beri tahu perangkat yang menampilkan QR (scoped deviceId-nya). Kegagalan
    // relay bukan alasan menggagalkan klaim — perangkat baru tetap polling.
    try {
      await sendJsonToUser(owner.userId, TransportOpCode.KEY_SYNC, {
        event: 'auth:linking_request',
        data: {
          pendingId,
          deviceName: deviceName || 'Perangkat baru',
          publicKey,
          // [docs/40] Kunci X-Wing perangkat baru WAJIB sampai ke perangkat lama:
          // arsip riwayat diseal ke kunci ini (`pq_box_seal_v2`). Tanpa field
          // ini, perangkat lama tidak punya tujuan untuk kunci arsip dan fitur
          // riwayat tidak mungkin jalan. Kunci publik, bukan rahasia.
          ...(pqPublicKey ? { pqPublicKey } : {}),
          signingKey,
          ...(signingKeyV2 ? { signingKeyV2 } : {}),
        },
      }, false, owner.deviceId || undefined);
    } catch (notifyError) {
      console.warn('[Link] Gagal mengirim auth:linking_request:', notifyError);
    }

    res.json({ pendingId });
  } catch (e) { next(e) }
});

// [docs/40 §40.4] Status juga membawa kesiapan arsip riwayat. Perangkat baru
// WAJIB menunggu `history !== 'preparing'` sebelum `complete`: login-nya
// mencabut sesi perangkat lama, dan unggahan yang masih berjalan akan terpotong
// di tengah jalan.
router.get('/link/status/:pendingId', authLimiter, async (req, res, next) => {
  try {
    const pendingId = req.params.pendingId;
    if (typeof pendingId !== 'string' || pendingId.length < 8) throw new ApiError(400, 'pendingId is required.');
    const state = await getLinkState(linkStore, pendingId);
    if (state !== 'approved') return res.json({ state, history: 'none' });

    const deviceId = await getApprovedDeviceId(linkStore, pendingId);
    let history: 'none' | 'preparing' | 'ready' = 'none';
    if (deviceId) {
      if (await readHistoryState(linkStore, linkSealer, deviceId)) {
        history = 'ready';
      } else if (await hasHistoryIntent(linkStore, deviceId)) {
        // Perangkat lama sudah berkomitmen mengunggah tetapi belum `ready`.
        history = 'preparing';
      }
    }
    res.json({ state, history });
  } catch (e) { next(e) }
});

router.post('/link/approve', requireAuth, zodValidate({
  body: z.object({
    pendingId: z.string().min(8),
    // [docs/40] Perangkat lama berkomitmen mengirim arsip riwayat sesudah
    // approve. Tanpa flag ini perangkat baru langsung `complete` (perilaku lama).
    expectHistory: z.boolean().optional(),
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized');
    const { pendingId, expectHistory } = req.body as { pendingId: string; expectHistory?: boolean };

    const pending = await readPendingLink(linkStore, linkSealer, pendingId);
    if (!pending) throw new ApiError(404, 'Link request not found or expired.');
    // Persetujuan hanya sah dari akun pemilik pending — perangkat lama mana pun
    // milik user itu boleh menyetujui (token sudah membuktikan kepemilikan).
    if (pending.userId !== req.user.id) throw new ApiError(403, 'This link request belongs to another account.');
    if (await getLinkState(linkStore, pendingId) !== 'pending') {
      throw new ApiError(409, 'Link request has already been handled.');
    }

    const device = await prisma.device.create({
      data: {
        userId: pending.userId,
        publicKey: Buffer.from(pending.publicKey, 'base64url'),
        pqPublicKey: pending.pqPublicKey ? Buffer.from(pending.pqPublicKey, 'base64url') : null,
        signingKey: Buffer.from(pending.signingKey, 'base64url'),
        ...(pending.signingKeyV2
          ? {
              signingKeyV2: Buffer.from(pending.signingKeyV2, 'base64url'),
              cryptoVersion: CRYPTO_VERSION_V2,
            }
          : {}),
        encryptedPrivateKey: Buffer.from(pending.encryptedPrivateKey, 'utf8'),
        nameSealed: await sealAtRest(pending.deviceName || 'Linked Device'),
        // Binding milik PERANGKAT BARU (dikumpulkan saat claim).
        fingerprint: pending.fingerprint || null,
        installationTag: pending.installationTag || null,
      }
    });

    const approved = await approvePendingLink(linkStore, linkSealer, pendingId, req.user.id, device.id);
    if (!approved) {
      // Race: approve lain menang lebih dulu → jangan tinggalkan device yatim.
      await prisma.device.delete({ where: { id: device.id } }).catch(() => {});
      throw new ApiError(409, 'Link request has already been handled.');
    }

    if (expectHistory) {
      // [docs/40 §40.4] Sinyal ke perangkat baru: `status.history` menjadi
      // `preparing` sampai `ready`. Perangkat baru menunggu (maks 60 dtk) supaya
      // unggahan tidak terpotong oleh login yang mencabut sesi perangkat ini.
      await markHistoryIntent(linkStore, device.id);
    }

    // Perangkat tertaut bisa menjadi device terakhir di record PIR user ini.
    void markPirSnapshotDirty('device-link')

    // [docs/30 §30.5 WS-A] Kunci identitas perangkat baru = perubahan yang harus
    // terlihat di log KT (paritas dengan login yang meregenerasi kunci).
    try {
      const owner = await prisma.user.findUnique({
        where: { id: pending.userId },
        select: { usernameHash: true }
      });
      if (owner?.usernameHash) {
        void publishIdentityKeyChange({
          userId: pending.userId,
          usernameHash: owner.usernameHash,
          identityKey: Buffer.from(pending.publicKey, 'base64url'),
          pqIdentityKey: pending.pqPublicKey ? Buffer.from(pending.pqPublicKey, 'base64url') : null,
          signingKey: Buffer.from(pending.signingKey, 'base64url'),
          ...(pending.signingKeyV2
            ? { signingKeyV2: Buffer.from(pending.signingKeyV2, 'base64url') }
            : {}),
        });
      }
    } catch (ktError) {
      console.warn('[Link] Gagal menerbitkan entri KT untuk perangkat baru:', ktError);
    }

    res.json({ ok: true, deviceId: device.id });
  } catch (e) { next(e) }
});

router.post('/link/deny', requireAuth, zodValidate({
  body: z.object({ pendingId: z.string().min(8) })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized');
    const { pendingId } = req.body;
    const pending = await readPendingLink(linkStore, linkSealer, pendingId);
    if (!pending) throw new ApiError(404, 'Link request not found or expired.');
    if (pending.userId !== req.user.id) throw new ApiError(403, 'This link request belongs to another account.');
    await denyPendingLink(linkStore, pendingId);
    res.json({ ok: true });
  } catch (e) { next(e) }
});

router.post('/link/complete', authLimiter, zodValidate({
  // Password ikut diverifikasi DI SINI (bukan hanya di /login sesudahnya):
  // `takeApprovedLink` membakar state, jadi tanpa cek ini salah ketik password
  // akan menghabiskan tautan sekaligus meninggalkan Device row yang tidak pernah
  // dipakai. Verifikasi dulu → baru state dibakar.
  body: z.object({ pendingId: z.string().min(8), password: z.string().min(1) })
}), async (req, res, next) => {
  try {
    const { pendingId, password } = req.body;

    if (await getLinkState(linkStore, pendingId) !== 'approved') {
      throw new ApiError(409, 'Link request is not approved or has expired.');
    }
    const pending = await readPendingLink(linkStore, linkSealer, pendingId);
    if (!pending) throw new ApiError(409, 'Link request is not approved or has expired.');

    const user = await prisma.user.findUnique({
      where: { id: pending.userId },
      select: { usernameHash: true, bannedAt: true, passwordHash: true }
    });
    if (!user) throw new ApiError(404, 'Account not found.');
    if (user.bannedAt) throw new ApiError(403, 'ACCESS DENIED: Your account has been suspended.');
    if (!await verifyPassword(password, user.passwordHash)) {
      throw new ApiError(401, 'Invalid credentials');
    }

    const taken = await takeApprovedLink(linkStore, linkSealer, pendingId);
    if (!taken) throw new ApiError(409, 'Link request is not approved or has expired.');

    // Tidak ada token sesi di sini — klien melanjutkan dengan POST /login
    // memakai password akun + kunci lokal yang baru dibuatnya.
    res.json({ deviceId: taken.deviceId, usernameHash: user.usernameHash });
  } catch (e) { next(e) }
});

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized');
    const userDevices = await prisma.device.findMany({ where: { userId: req.user.id }, select: { id: true } });
    const deviceIds = userDevices.map(d => d.id);
    
    // Fetch active tokens BEFORE updating them (for Redis blacklist)
    const tokensToRevoke = await prisma.refreshToken.findMany({
      where: { deviceId: { in: deviceIds }, revokedAt: null },
      select: { jti: true, expiresAt: true }
    });
    
    // Use updateMany to set revokedAt instead of deleteMany to preserve audit trail
    const updated = await prisma.refreshToken.updateMany({
      where: { deviceId: { in: deviceIds }, revokedAt: null },
      data: { revokedAt: new Date() }
    });

    // Blacklist all revoked tokens in Redis
    for (const t of tokensToRevoke) {
      const expiresIn = Math.floor((new Date(t.expiresAt).getTime() - Date.now()) / 1000);
      if (expiresIn > 0) {
        await redisClient.setEx(`revoked_jti:${t.jti}`, expiresIn, '1').catch(() => {});
      }
    }
    
    clearAuthCookies(res)

    // Clear active device cache from Redis
    // [ROBUSTNESS] Buang juga cache lokal 60s di semua instance.
    try {
      await redisClient.del(identityKey('active_device', req.user.id));
      await invalidateActiveDeviceCache(req.user.id, redisClient);
    } catch (_re) {}

    // [AUDIT 2026-10-24] Revokasi token saja TIDAK memutus sesi yang sedang
    // hidup: relay realtime tidak membaca daftar blacklist per frame, jadi
    // socket yang sudah terbuka terus mengirim & menerima pesan setelah
    // "All N sessions terminated". Mirror `DELETE /api/sessions/:jti`
    // (routes/sessions.ts): beri tahu klien lalu tutup socket-nya.
    try {
      const { emitEventToUser, sendJsonToUser } = await import('../network/redisBridge.js');
      await emitEventToUser(req.user.id, 'force_logout', { reason: 'logout_all' });
      await sendJsonToUser(req.user.id, TransportOpCode.KICK, { reason: 'LOGOUT_ALL' });
    } catch (err) {
      console.error('[Auth] Failed to send KICK/force_logout for logout-all:', err);
    }

    res.json({ message: `All ${updated.count} sessions terminated.` });
  } catch (e) { next(e); }
});

/**
 * [docs/35 Fase 3] Terbitkan token OHTTP untuk carriage di dalam amplop.
 *
 * Endpoint ini tetap di belakang cookie + CSRF (bukan jalur OHTTP), karena
 * tujuannya justru MENGAMBIL token memakai sesi yang sah. Setelah itu token
 * yang dikirim lewat relay tidak membawa identitas jaringan klien.
 */
router.post('/ohttp-token', authLimiter, requireAuth, (req, res) => {
  // Fitur mati = endpoint tidak ada, bukan 403: deployment biasa tidak boleh
  // mengiklankan jalur ini sama sekali.
  if (!isOhttpEnabled()) {
    incCounter(OHTTP_OPS, { route: 'token', result: 'denied' })
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (!req.user?.id) {
    incCounter(OHTTP_OPS, { route: 'token', result: 'denied' })
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const token = signOhttpToken({
    userId: req.user.id,
    deviceId: req.deviceId,
    jti: newJti(),
  })
  incCounter(OHTTP_OPS, { route: 'token', result: 'ok' })
  res.json({ token, expiresInSeconds: OHTTP_TOKEN_TTL_SEC })
})

router.post('/logout', async (req, res) => {
  const { endpoint } = req.body
  if (endpoint) {
    // [docs/28 Tier 1.5 / D10] endpoint tersimpan TER-SEAL → lookup dengan seal.
    // [docs/37 P6] `in` = kandidat kunci aktif + legacy (baris pra-rotasi at-rest).
    try { await prisma.pushSubscription.deleteMany({ where: { endpointSealed: { in: await sealedLookupCandidates(endpoint) } } }) } catch (_e) {}
  }
  try {
    const payload = verifyJwt(String(req.cookies?.rt || '')) as { jti?: string; sub?: string };
    if (payload && typeof payload === 'object' && 'jti' in payload && typeof payload.jti === 'string') {
      // Find the token to get its familyId
      const stored = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } });
      
      if (stored) {
        // Revoke ALL tokens in this family + Redis blacklist (paralel)
        await revokeFamily(stored.familyId);
      } else {
        // Fallback: revoke just this JTI
        await prisma.refreshToken.updateMany({ where: { jti: payload.jti }, data: { revokedAt: new Date() } });
      }
      
      // Clear active device cache if we have the user ID
      // [ROBUSTNESS] Buang juga cache lokal 60s di semua instance.
      if (payload.sub) {
        try {
          await redisClient.del(identityKey('active_device', payload.sub));
          await invalidateActiveDeviceCache(payload.sub, redisClient);
        } catch (_re) {}
      }
    }
  } catch (_e) {}
  clearAuthCookies(res)
  res.json({ ok: true })
})

router.get('/pow/challenge', requireAuth, async (req, res, next) => {
  try {
    const sodium = await getSodium();
    const salt = sodium.to_hex(sodium.randombytes_buf(16));
    const ip = cfAwareClientIp(req);
    const userId = req.user?.id;
    const fingerprint = req.headers['x-nyx-fingerprint'];
    const instId = req.headers['x-nyx-installation-id'];

    // Identitas rate-state dikunci ke userId dulu (route ini requireAuth —
    // selalu tersedia & tidak bisa dipalsukan). Sebelumnya instId (header
    // klien) diprioritaskan → difficulty bisa dipatok minimum dengan
    // rotasi `x-nyx-installation-id` per request.
    const identity = resolvePowIdentity({ userId, instId, fingerprint, ip });
    if (!identity) {
      throw new ApiError(400, 'Cannot determine client identifier for PoW challenge.');
    }
    // [docs/30 §30.12 WS-H] Key = HMAC pepper (`powRateKey`), bukan hash tanpa
    // kunci dari identitas mentah: cabang `pow:ip`/`pow:fp` memakai nilai
    // berentropi rendah, dan hash tanpa kunci bisa dienumerasi dari snapshot
    // Redis. Bentuk key tetap deterministik, jadi counter tetap idempoten.
    const rateKey = powRateKey(identity);

    // INCR+EXPIRE atomik (Lua)
    let count = Number(await redisClient.eval(`
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`, { keys: [rateKey], arguments: ['86400'] }));
    if (Number.isNaN(count) || count < 0) {
        count = 0;
    }

    // AGGRESSIVE SCALING: 
    // Start at 4. 
    // Max 8 (extremely hard, takes minutes to solve).
    // Increment every 1 attempt (more aggressive than before).
    const difficulty = Math.min(4 + Math.floor(count / 1), 8);

    await redisClient.setEx(`pow:challenge:${req.user!.id}`, 300, JSON.stringify({ salt, difficulty }));

    res.json({ salt, difficulty });
  } catch (e) {
    next(e);
  }
});

router.post('/pow/verify',
  requireAuth,
  zodValidate({
    body: z.object({ nonce: z.number() })
  }),
  async (req, res, next) => {
    try {
      const { nonce } = req.body;
      const userId = req.user!.id;

      // Throttle verify per-user SEBELUM kerja Argon2 (16 MB per percobaan).
      // INCR+EXPIRE atomik (Lua), jendela 1 jam.
      const vCount = Number(await redisClient.eval(`
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`, { keys: [`rl:powverify:${identityTag(userId)}`], arguments: ['3600'] }));
      if (!Number.isNaN(vCount) && vCount > 30) {
        throw new ApiError(429, 'Too many verification attempts. Please try again later.');
      }

      const challengeData = await redisClient.get(`pow:challenge:${userId}`);
      if (!challengeData) {
        throw new ApiError(400, 'Challenge expired or invalid. Please request a new one.');
      }

      const { salt, difficulty } = JSON.parse(String(challengeData)) as { salt: string, difficulty: number };

      // ADJUSTED DIFFICULTY MATCHING FRONTEND:
      const targetPrefix = '0'.repeat(Math.max(1, Math.floor(difficulty / 2)));

      const nonceStr = nonce.toString();
      const saltBytes = Buffer.from(salt);
      const nonceBytes = Buffer.from(nonceStr);

      // Combine salt + nonce
      const combinedSalt = Buffer.concat([saltBytes, nonceBytes]);

      // Verify with Argon2 (Node.js version)
      // Note: We use the same parameters as hash-wasm in frontend (16MB, 1 iter)
      const hashBuffer = await argon2.hash("nyx_pow_sequence", {
        salt: combinedSalt,
        type: argon2.argon2id,
        memoryCost: 16384, // 16 MB
        timeCost: 1,      // 1 iteration
        parallelism: 1,
        hashLength: 32,
        raw: true
      });

      const hash = hashBuffer.toString('hex');

      if (hash.startsWith(targetPrefix)) {
          await redisClient.del(`pow:challenge:${userId}`);
          await prisma.user.update({
              where: { id: userId },
              data: { isVerified: true }
          });
          // `isVerified` ikut disalin ke record PIR (badge terverifikasi).
          void markPirSnapshotDirty('verify-pow')
          res.json({ success: true, message: 'Account verified via Proof of Work' });
      } else {
          throw new ApiError(400, 'Invalid Proof of Work. Hash does not meet difficulty target.');
      }
    } catch (e) {
      next(e);
    }
  }
);

router.get('/webauthn/register/options', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized')

    const userAuthenticators = await prisma.authenticator.findMany({
      where: { userId: req.user.id }
    })

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const forceNew = req.query.force === 'true';
    
    type GenOpts = Parameters<typeof generateRegistrationOptions>[0];
    type ExcludeCredential = NonNullable<GenOpts['excludeCredentials']>[number];

    // [2026-10-18] `id` WAJIB `Base64URLString`, bukan Buffer. `simplewebauthn`
    // v13 memvalidasi tiap id lewat `input.replace(...)`; Buffer tidak punya
    // `.replace`, jadi `Buffer` di sini melempar TypeError → 500 di setiap akun
    // yang sudah punya authenticator (mis. kredensial attestation saat daftar).
    // Itulah "internal server error" saat pengguna menekan verify/biometric.
    const excludeCredentials = forceNew ? [] : userAuthenticators.reduce((acc: ExcludeCredential[], auth) => {
        const id = toBase64UrlCredentialId(auth.credentialID);
        if (!id) {
          console.warn('Skipping invalid credential ID:', auth.credentialID);
          return acc;
        }
        acc.push({ id, transports: parseCredentialTransports(auth.transports) as ExcludeCredential['transports'] });
        return acc;
      }, []);

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(req.user.id)),
      userName: user?.usernameHash || "Anonymous User", 
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        // `required` juga di sini: credential yang dibuat harus bisa memenuhi
        // UV, karena `/webauthn/login/options` kini menuntut `required`. Kalau
        // create() mengizinkan `preferred`, lahir kredensial yang bisa dibuat
        // tetapi tidak bisa dipakai login.
        userVerification: 'required',
        authenticatorAttachment: 'platform'
      }
    })

    await prisma.user.update({
      where: { id: req.user.id },
      data: { currentChallenge: options.challenge }
    })

    res.json(options)
  } catch (e) { next(e) }
})

router.post('/webauthn/register/verify', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized')
    const { body } = req

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user || !user.currentChallenge) throw new ApiError(400, 'No challenge found.')

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: user.currentChallenge,
      expectedOrigin,
      expectedRPID: rpID
    })

    if (verification.verified && verification.registrationInfo) {
      const { credential, credentialDeviceType, credentialBackedUp, userVerified } = verification.registrationInfo
      const { id: credentialID, publicKey: credentialPublicKey, counter } = credential

      await prisma.authenticator.create({
        data: {
          id: nanoid(),
          credentialID,
          userId: user.id,
          credentialPublicKey: isoBase64URL.fromBuffer(credentialPublicKey),
          counter: BigInt(counter),
          credentialDeviceType,
          credentialBackedUp,
          transports: body.response.transports ? body.response.transports.join(',') : null
        }
      })

      // [2026-10-18] `isVerified` berarti "ada bukti perangkat", bukan "punya
      // authenticator". Passkey tersinkron (`credentialBackedUp=true`) bisa
      // dipakai di perangkat lain dan tidak membawa bukti perangkat — sama
      // seperti jalur attestation, akun tidak boleh naik status karenanya.
      // Device-bound + user verification (Windows Hello/TPM, security key,
      // kredensial "this device only") tetap memenuhi kriteria.
      const deviceBound = credentialBackedUp === false && userVerified === true

      await prisma.user.update({
        where: { id: user.id },
        data: { currentChallenge: null, ...(deviceBound ? { isVerified: true } : {}) }
      })
      if (deviceBound) void markPirSnapshotDirty('verify-webauthn')
      res.json({ verified: true, isVerified: user.isVerified || deviceBound, deviceBound })
    } else {
      res.status(400).json({ verified: false, error: 'Verification failed' })
    }
  } catch (e) { next(e) }
})

/**
 * [2026-10-18] Daftar credential milik user yang sedang login.
 *
 * Dipakai untuk **enroll PRF unlock pada credential yang sudah ada** (mis.
 * credential attestation saat pendaftaran) alih-alih membuat passkey kedua di
 * Google/Apple Password Manager. Tanpa endpoint ini, satu-satunya cara adalah
 * `register/options` yang selalu membuat kredensial baru.
 *
 * Yang dikembalikan hanya metadata publik: credential ID, transports, jenis
 * perangkat, dan status backup — tidak ada kunci publik/privat.
 */
router.get('/webauthn/credentials', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized')
    const rows = await prisma.authenticator.findMany({
      where: { userId: req.user.id },
      select: { credentialID: true, transports: true, credentialDeviceType: true, credentialBackedUp: true }
    })
    res.json({
      rpID,
      credentials: rows.map((row) => ({
        id: row.credentialID,
        transports: row.transports ? row.transports.split(',') : undefined,
        deviceType: row.credentialDeviceType,
        backedUp: row.credentialBackedUp
      }))
    })
  } catch (e) { next(e) }
})

router.get('/webauthn/login/options', async (req, res, next) => {
  try {
    // [2026-10-18] `required`: assertion ini mencetak sesi. Dengan `preferred`,
    // authenticator yang hanya mengirim user presence (sentuhan) bisa login,
    // sehingga klaim "login dengan biometric" hanya dijaga dekripsi PRF di
    // klien — bukan oleh server. Klien memang butuh UV untuk PRF, tapi sesi
    // tidak boleh bergantung pada langkah lokal yang bisa dilewati.
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required'
    })
    res.cookie('webauthn_challenge', options.challenge, { httpOnly: true, maxAge: 60000, secure: env.nodeEnv === 'production' })
    res.json(options)
  } catch (e) { next(e) }
})

router.post('/webauthn/login/verify', async (req, res, next) => {
  try {
    const { body } = req
    const challenge = req.cookies.webauthn_challenge
    if (!challenge) throw new ApiError(400, 'Challenge expired or missing.')

    const credentialID = body.id
    const userAuthenticator = await prisma.authenticator.findUnique({
      where: { credentialID },
      include: { user: true }
    })

    if (!userAuthenticator) throw new ApiError(400, 'Unknown device.')

    type VerifyOpts = Parameters<typeof verifyAuthenticationResponse>[0];

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: userAuthenticator.credentialID,
        publicKey: isoBase64URL.toBuffer(userAuthenticator.credentialPublicKey),
        counter: Number(userAuthenticator.counter),
        transports: userAuthenticator.transports ? (userAuthenticator.transports.split(',') as NonNullable<VerifyOpts['credential']>['transports']) : undefined
      },
      // [2026-10-18] Wajib UV: sesi tidak boleh lahir dari presence-only
      // assertion (lihat komentar di /webauthn/login/options).
      requireUserVerification: true
    } as VerifyOpts)

    if (verification.verified) {
      // Challenge sekali pakai: cookie dibersihkan setelah verifikasi sukses
      // supaya assertion berikutnya tidak bisa memakai challenge yang sama.
      res.clearCookie('webauthn_challenge');
      const { authenticationInfo } = verification

      await prisma.authenticator.update({
        where: { id: userAuthenticator.id },
        data: { counter: BigInt(authenticationInfo.newCounter) }
      })

      const safeUser = await prisma.user.findUnique({
        where: { id: userAuthenticator.user.id },
        select: {
          id: true,
          usernameHash: true,
          shareId: true,
          encryptedProfile: true,
          isVerified: true,
          role: true,
          subscriptionTier: true,
          bannedAt: true,
          banReason: true,
          devices: { orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }], take: 1 }
        }
      })

      if (!safeUser) throw new ApiError(404, 'User not found')
      if (safeUser.bannedAt) return res.status(403).json({ error: 'ACCESS DENIED: Your account has been suspended.', reason: safeUser.banReason })

      const fingerprint = indexDeviceFingerprint(req.headers['x-nyx-fingerprint']);
      const _iid = req.headers['x-nyx-installation-id'];
      const installationId = typeof _iid === 'string' ? _iid : undefined;

      const latestDevice = safeUser.devices[0];
      let activeDeviceId = latestDevice?.id;
      let encryptedPrivKeyStr = null;

      if (latestDevice) {
         if (latestDevice.fingerprint && fingerprint && latestDevice.fingerprint !== fingerprint) {
             // [docs/28 Tier 1.5] kolom menyimpan TAG → bandingkan nilai ter-tag.
             if (latestDevice.installationTag && installationId && latestDevice.installationTag === deviceInstallationTag(installationId)) {
                 await prisma.device.update({
                     where: { id: latestDevice.id },
                     data: { fingerprint, lastActiveAt: deviceActivityBucket() }
                 });
             } else {
                 console.warn(`[Security] Hardware/Anchor mismatch for device ${latestDevice.id} via WebAuthn. Forcing recovery flow.`);
                 activeDeviceId = '';
             }
         } else {
             await prisma.device.update({
                 where: { id: latestDevice.id },
                 data: { 
                     lastActiveAt: deviceActivityBucket(), 
                     fingerprint: fingerprint || latestDevice.fingerprint, 
                     installationTag: installationId ? deviceInstallationTag(installationId) : latestDevice.installationTag 
                 }
             });
         }
      }

      if (!activeDeviceId) {
          // Force recovery flow by not sending tokens or keys.
          // The client will see a 200 OK without keys and throw IDENTITY_RECOVERY_REQUIRED.
      } else {
          encryptedPrivKeyStr = latestDevice?.encryptedPrivateKey
            ? Buffer.from(latestDevice.encryptedPrivateKey).toString('utf8')
            : null;
      }

      let tokens: { access: string; refresh: string } | null = null;
      if (activeDeviceId) {
          tokens = await issueTokens({ id: safeUser.id, role: safeUser.role }, activeDeviceId, req);
          setAuthCookies(res, tokens);
      }
      res.clearCookie('webauthn_challenge')

      res.json({
        verified: true,
        user: { id: safeUser.id, usernameHash: safeUser.usernameHash, shareId: await ensureUserShareId(safeUser), encryptedProfile: safeUser.encryptedProfile, isVerified: safeUser.isVerified, role: safeUser.role, subscriptionTier: safeUser.subscriptionTier },
        accessToken: tokens?.access || undefined,
        encryptedPrivateKey: encryptedPrivKeyStr || undefined
      })    } else {
      res.status(400).json({ verified: false })
    }
  } catch (e) { next(e) }
})

export default router