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
import { clearAuthCookies, isEphemeralGuestSubject, revokeFamily } from '../utils/sessionUtils.js'
import { powRateKey, resolvePowIdentity } from '../utils/powIdentity.js'
import { cfAwareClientIp } from '../utils/clientIp.js'
import { env } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { authLimiter } from '../middleware/rateLimiter.js'
import { getSodium } from '../lib/sodium.js'
import { invalidateActiveDeviceCache } from '../utils/redisResilience.js'
import {
  deviceInstallationTag,
  identifierLookupCandidates,
  pepperedIdentifier,
  sealAtRest,
} from '../utils/atRestSecrets.js'
// [docs/28 Tier 1.5 / D14] key Redis memakai tag, bukan userId asli (Redis = artefak setara dump).
// [docs/28 Tier 4] identitas at-rest: key Redis tidak menyematkan userId asli.
import { identityKey, identityTag } from '../utils/redisIdentity.js'
// [docs/30 §30.12 WS-H] Guard burst registrasi (per sumber IP-hash & instalasi).
import { enforceRegistrationBurst } from '../utils/registrationGuard.js'
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
import { identityKeysChanged, publishIdentityKeyChange } from '../utils/ktIdentityLog.js'
// [docs/30 §30.12 WS-H] Attestation perangkat untuk akun baru (gerbang sybil).
import {
  attestationPolicyFromEnv,
  consumeAttestationChallenge,
  storeAttestationChallenge,
  verifyNewAccountAttestation
} from '../utils/webauthnAttestation.js'
import { Buffer } from 'buffer'
import { redisClient } from '../lib/redis.js'
// ✅ FIX: Import tipe JWT Payload dari shared
import type { AuthJwtPayload } from '@nyx/shared'

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
  const isProd = env.nodeEnv === 'production'
  const cookieOptions: CookieOptions = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', path: '/' }
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
    // Check if user is in Migration Mode
    const isMigrating = await redisClient.exists(identityKey('is_migrating', user.id));

    if (!isMigrating) {
        // Enforce "One User, One Active Device": Revoke all existing sessions for this user
        await prisma.refreshToken.deleteMany({
            where: {
                device: { userId: user.id }
            }
        });
    } else {
        console.log(`[Migration] Bypassing session revocation for user ${user.id} due to active migration flag.`);
    }

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
    encryptedPrivateKeys: z.string().optional(),
    deviceName: z.string().optional(),
    turnstileToken: z.string().optional(),
    // [docs/30 §30.12 WS-H] Bukti attestation (diminta hanya bila gerbang menyala).
    attestation: z.object({
      challenge: z.string().min(1).max(256),
      response: z.unknown()
    }).optional()
  })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password, encryptedProfile, publicKey, pqPublicKey, signingKey, encryptedPrivateKeys, deviceName, turnstileToken } = req.body

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
      if (!proof) throw new ApiError(428, 'ATTESTATION_REQUIRED');

      const challengeAlive = await consumeAttestationChallenge(redisClient, proof.challenge);
      if (!challengeAlive) throw new ApiError(403, 'ATTESTATION_CHALLENGE_INVALID');

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
        throw new ApiError(403, 'ATTESTATION_INVALID');
      }

      if (!verification.verified || !verification.credentialId || !verification.credentialPublicKey) {
        throw new ApiError(403, `ATTESTATION_REJECTED: ${verification.reason ?? 'UNKNOWN'}`);
      }

      attestedCredential = {
        credentialId: verification.credentialId,
        publicKey: verification.credentialPublicKey,
        counter: verification.counter,
        deviceType: verification.credentialDeviceType ?? 'singleDevice',
        backedUp: verification.credentialBackedUp,
        tier: verification.tier
      };
    }

    const user = await prisma.user.create({
      data: {
        usernameHash: pepperedIdentifier(usernameHash),
        passwordHash,
        // [docs/28 Tier 2 — B4] hari pendaftaran (bucket harian), bukan detik.
        lastActiveDay: dayBucket(),
        encryptedProfile,
        // [WS-H] Akun yang lolos attestation perangkat langsung terverifikasi
        // (setara menambahkan passkey), jadi ia bisa memakai fitur yang butuh
        // verifikasi tanpa langkah tambahan.
        isVerified: attestedCredential !== null,
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

    // [docs/30 §30.5 WS-A] Catat kunci publik di log KT (no-op tanpa KT_SERVER_URL).
    // Fire-and-forget: latensi registrasi tidak bergantung pada log; kegagalan
    // terlihat sebagai metrik `nyx_kt_writes_total{result="error"}` + log
    // (search key ter-hash, tanpa identitas).
    void publishKeyTransparencyEntry({
      usernameHash,
      identityKey: Buffer.from(publicKey, 'base64url'),
      pqIdentityKey: Buffer.from(pqPublicKey ?? '', 'base64url'),
      signingKey: Buffer.from(signingKey, 'base64url'),
      keyVersion: KT_KEY_VERSION_REGISTRATION,
      updatedAtDay: Math.floor(dayBucket().getTime() / 86_400_000),
    });
    const tokens = await issueTokens(user, deviceId, req)
    setAuthCookies(res, tokens)

    res.status(201).json({
      message: 'Registration successful.',
      user: { id: user.id, usernameHash: user.usernameHash, encryptedProfile: user.encryptedProfile, isVerified: user.isVerified, subscriptionTier: user.subscriptionTier },
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

    let activeDeviceId = '';
    let activeEncryptedPrivateKey = '';

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
        ? { publicKey: device.publicKey, signingKey: device.signingKey }
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
      if (
        identityKeysChanged(previousIdentity, {
          identityKey: Buffer.from(publicKey, 'base64url'),
          signingKey: Buffer.from(signingKey, 'base64url'),
        })
      ) {
        void publishIdentityKeyChange({
          userId: user.id,
          usernameHash,
          identityKey: Buffer.from(publicKey, 'base64url'),
          pqIdentityKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : null,
          signingKey: Buffer.from(signingKey, 'base64url'),
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

    const safeUser = { id: user.id, usernameHash: user.usernameHash, encryptedProfile: user.encryptedProfile, isVerified: user.isVerified, role: user.role, subscriptionTier: user.subscriptionTier }

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
router.post('/burner', async (req, res, next) => {
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
      const FRESH_ROTATION_GRACE_MS = 5000;
      const newest = await prisma.refreshToken.findFirst({
        where: { familyId: basis.familyId, deviceId: basis.deviceId, revokedAt: null, replacedById: null },
        orderBy: { createdAt: 'desc' },
      });

      const isFreshDuplicate =
        !!newest &&
        basis.deviceId === payload.deviceId &&
        (Date.now() - newest.createdAt.getTime()) < FRESH_ROTATION_GRACE_MS;

      if (isFreshDuplicate) {
        // Benign: another tab/window already rotated this token moments ago.
        // Continue the chain from the freshest valid token instead of revoking.
        console.info(`[Auth] Concurrent refresh detected (token ${payload.jti} superseded within ${FRESH_ROTATION_GRACE_MS}ms) — continuing session.`);
        basis = newest;
      } else {
        console.warn(`[Security] Refresh token reuse detected! JTI: ${payload.jti}, Family: ${basis.familyId}, User: ${payload.sub}`);

        // Revoke ALL tokens in this family (compromise containment) + Redis blacklist
        await revokeFamily(basis.familyId)

        // Clear cookies
        clearAuthCookies(res)

        // Alert the user via their active WebSocket connection
        try {
          const { emitEventToUser } = await import('../network/redisBridge.js');
          await emitEventToUser(payload.sub, 'force_logout', { reason: 'session_hijacked', message: 'Your session was compromised. Please login again.' });
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
    signature: z.string(),
    timestamp: z.number(),
    nonce: z.string()
  })
}), async (req, res, next) => {
  try {
    const { identifier: usernameHash, newPassword, newEncryptedKeys, publicKey, pqPublicKey, signingKey, signature, timestamp, nonce } = req.body;

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
    const signatureBytes = sodium.from_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING);
    
    let isValid = false;
    for (const device of user.devices) {
        try {
            const publicKeyBytes = new Uint8Array(device.signingKey);
            if (sodium.crypto_sign_verify_detached(signatureBytes, messageBytes, publicKeyBytes)) {
                isValid = true;
                break;
            }
        } catch(e) { console.warn("[Auth] Recovery signature verification error:", e); }
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
      keyVersion: KT_KEY_VERSION_RECOVERY,
      updatedAtDay: Math.floor(dayBucket().getTime() / 86_400_000),
    });

    const tokens = await issueTokens(updatedUser, newDevice.id, req);    
    setAuthCookies(res, tokens);
    res.json({ message: "Account recovered successfully.", accessToken: tokens.access });
  } catch (e) { next(e); }
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

    res.json({ message: `All ${updated.count} sessions terminated.` });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res) => {
  const { endpoint } = req.body
  if (endpoint) {
    // [docs/28 Tier 1.5 / D10] endpoint tersimpan TER-SEAL → lookup dengan seal.
    try { await prisma.pushSubscription.deleteMany({ where: { endpointSealed: await sealAtRest(endpoint) } }) } catch (_e) {}
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

    const excludeCredentials = forceNew ? [] : userAuthenticators.reduce((acc: ExcludeCredential[], auth) => {
        try {
          if (!auth.credentialID) return acc;
          const base64 = String(auth.credentialID).replace(/-/g, '+').replace(/_/g, '/');
          const idBuffer = Buffer.from(base64, 'base64');
          acc.push({
            id: idBuffer as unknown as ExcludeCredential['id'],
            transports: auth.transports ? (auth.transports.split(',') as ExcludeCredential['transports']) : undefined
          });
        } catch (e) {
          console.warn(`Skipping invalid credential ID: ${auth.credentialID}`, e);
        }
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
        userVerification: 'preferred',
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
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
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

      await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null, isVerified: true } })
      res.json({ verified: true })
    } else {
      res.status(400).json({ verified: false, error: 'Verification failed' })
    }
  } catch (e) { next(e) }
})

router.get('/webauthn/login/options', async (req, res, next) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred'
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
      requireUserVerification: false
    } as VerifyOpts)

    if (verification.verified) {
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
        user: { id: safeUser.id, usernameHash: safeUser.usernameHash, encryptedProfile: safeUser.encryptedProfile, isVerified: safeUser.isVerified, role: safeUser.role, subscriptionTier: safeUser.subscriptionTier },
        accessToken: tokens?.access || undefined,
        encryptedPrivateKey: encryptedPrivKeyStr || undefined
      })    } else {
      res.status(400).json({ verified: false })
    }
  } catch (e) { next(e) }
})

export default router