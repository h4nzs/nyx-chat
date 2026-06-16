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
import { env } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { authLimiter } from '../middleware/rateLimiter.js'
import { getSodium } from '../lib/sodium.js'
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
import { Buffer } from 'buffer'
import { redisClient } from '../lib/redis.js'
// ✅ FIX: Import tipe JWT Payload dari shared
import type { AuthJwtPayload } from '@nyx/shared'

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

async function issueTokens (user: { id: string, role?: string }, deviceId: string, req: Request) {
  const access = signAccessToken({ id: user.id, role: user.role, deviceId })
  const jti = newJti()
  const refresh = signAccessToken({ sub: user.id, jti, deviceId }, { expiresIn: '30d' })

  const rawIp = req.ip || '';
  const sodium = await getSodium();
  const ipAddress = sodium.to_hex(sodium.crypto_generichash(32, Buffer.from(rawIp), null)).substring(0, 16);
  const userAgent = req.headers['user-agent']

  // GUEST users (Burner Chat) are ephemeral and don't exist in the User/Device tables.
  // We skip DB persistence for their refresh tokens to avoid FK constraint violations.
  if (user.role !== 'GUEST') {
    // Check if user is in Migration Mode
    const isMigrating = await redisClient.exists(`is_migrating:${user.id}`);

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

    await prisma.refreshToken.create({
      data: { jti, deviceId, expiresAt: refreshExpiryDate(), ipAddress, userAgent }
    })

    // Store active device in Redis for instant WebTransport validation (Lapis 1 Security)
    try {
      await redisClient.setEx(`active_device:${user.id}`, 86400 * 30, deviceId); // 30 days
    } catch (redisErr) {
      console.error('[Redis] Failed to set active device cache:', redisErr);
    }
  }
  
  return { access, refresh }
}

async function verifyTurnstileToken (token: string): Promise<boolean> {
  if (env.nodeEnv !== 'production' && !process.env.TURNSTILE_SECRET_KEY) return true
  if (!token) return false

  const verify = async (secret: string) => {
    const formData = new FormData()
    formData.append('secret', secret)
    formData.append('response', token)
    try {
      const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: formData })
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
    turnstileToken: z.string().optional()
  })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password, encryptedProfile, publicKey, pqPublicKey, signingKey, encryptedPrivateKeys, deviceName, turnstileToken } = req.body

    const isHuman = await verifyTurnstileToken(turnstileToken || '')
    if (!isHuman) throw new ApiError(400, 'Bot detected. Please try again or reload page.')

    const existingUser = await prisma.user.findUnique({ where: { usernameHash } })
    if (existingUser) throw new ApiError(409, 'Username already taken (Hash Collision).')

    const passwordHash = await hashPassword(password)
    
    const fingerprint = req.headers['x-nyx-fingerprint'] as string | undefined;
    const installationId = req.headers['x-nyx-installation-id'] as string | undefined;
    
    const user = await prisma.user.create({
      data: {
        usernameHash,
        passwordHash,
        encryptedProfile,
        isVerified: false,
        devices: {
          create: {
            // FIX 1: Safe Buffer conversion for optional inputs
            publicKey: Buffer.from(publicKey, 'base64url'),
            pqPublicKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : null,
            signingKey: Buffer.from(signingKey, 'base64url'),
            encryptedPrivateKey: encryptedPrivateKeys ? Buffer.from(encryptedPrivateKeys, 'utf8') : null,
            name: deviceName || 'Primary Device',
            fingerprint: fingerprint || null,
            installationId: installationId || null
          }
        }
      },
      include: {
        devices: true
      }
    })

    const deviceId = user.devices[0].id
    const tokens = await issueTokens(user, deviceId, req)
    setAuthCookies(res, tokens)

    res.status(201).json({
      message: 'Registration successful.',
      user: { id: user.id, usernameHash: user.usernameHash, encryptedProfile: user.encryptedProfile, isVerified: user.isVerified, subscriptionTier: user.subscriptionTier },
      accessToken: tokens.access,
      deviceId,
      needVerification: false
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
    const fingerprint = req.headers['x-nyx-fingerprint'] as string | undefined;
    const installationId = req.headers['x-nyx-installation-id'] as string | undefined;
    
    const user = await prisma.user.findUnique({
      where: { usernameHash },
      include: {
        devices: { orderBy: { lastActiveAt: 'desc' } }
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
      
      if (device) {
          device = await prisma.device.update({
              where: { id: device.id },
              data: { 
                lastActiveAt: new Date(), 
                // Update hardware binding
                fingerprint: fingerprint || device.fingerprint,
                installationId: installationId || device.installationId,
                // Update keys in case they were regenerated locally
                publicKey: Buffer.from(publicKey, 'base64url'),
                pqPublicKey: pqPublicKey ? Buffer.from(pqPublicKey, 'base64url') : device.pqPublicKey,
                signingKey: Buffer.from(signingKey, 'base64url'), 
                encryptedPrivateKey: Buffer.from(encryptedPrivateKey, 'utf8'), 
                name: deviceName || getGenericDeviceName(req.headers['user-agent']) 
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
              name: deviceName || getGenericDeviceName(req.headers['user-agent']),
              fingerprint: fingerprint || null,
              installationId: installationId || null
            }
          });
      }
      activeDeviceId = device.id;
      activeEncryptedPrivateKey = device.encryptedPrivateKey ? Buffer.from(device.encryptedPrivateKey).toString('utf8') : '';

    } else {
      if (explicitDeviceId) {
          const device = user.devices.find(d => d.id === explicitDeviceId);
          
          // SECURITY CHECK: If device exists but fingerprint MISMATCHES, 
          // it means the browser data (LocalStorage) was cloned to a different hardware.
          if (device && device.fingerprint && fingerprint && device.fingerprint !== fingerprint) {
              // Toleransi: Jika installationId (Anchor) masih cocok, kita izinkan update fingerprint
              if (device.installationId && device.installationId === installationId) {
                  await prisma.device.update({
                      where: { id: device.id },
                      data: { fingerprint, lastActiveAt: new Date() }
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
                  lastActiveAt: new Date(),
                  fingerprint: fingerprint || device.fingerprint,
                  installationId: installationId || device.installationId
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
      const isProd = env.nodeEnv === 'production'
      res.clearCookie('at', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
      res.clearCookie('rt', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
      throw new ApiError(401, 'Invalid refresh token')
    }

    const stored = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } })
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      const isProd = env.nodeEnv === 'production'
      res.clearCookie('at', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
      res.clearCookie('rt', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
      throw new ApiError(401, 'Refresh token expired/revoked')
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) throw new ApiError(401, 'User not found')
    if (user.bannedAt) throw new ApiError(403, `ACCESS DENIED: ${user.banReason || 'Account suspended'}`)

    await prisma.refreshToken.deleteMany({ where: { jti: payload.jti } });

    const tokens = await issueTokens(user, stored.deviceId, req)
    setAuthCookies(res, tokens)
    res.json({ ok: true, accessToken: tokens.access })
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
    await redisClient.setEx(`recover_nonce:${identifier}`, 300, nonce);
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

    const cachedNonce = await redisClient.get(`recover_nonce:${usernameHash}`);
    if (!cachedNonce || cachedNonce !== nonce) throw new ApiError(401, "Invalid or expired recovery challenge.");
    await redisClient.del(`recover_nonce:${usernameHash}`);

    const user = await prisma.user.findUnique({ where: { usernameHash }, include: { devices: true } });
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
        } catch(e) {}
    }

    if (!isValid) throw new ApiError(401, "Cryptographic signature verification failed.");

    if (!publicKey || !signingKey || !newEncryptedKeys) {
      throw new ApiError(400, 'Missing required cryptographic keys or encrypted private keys.');
    }

    const passwordHash = await hashPassword(newPassword);

    const fingerprint = req.headers['x-nyx-fingerprint'] as string | undefined;
    const installationId = req.headers['x-nyx-installation-id'] as string | undefined;

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
            name: 'Recovered Device',
            fingerprint: fingerprint || null,
            installationId: installationId || null
          }
        })
    ]);

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
    
    await prisma.refreshToken.deleteMany({ where: { deviceId: { in: deviceIds } } });
    
    const isProd = env.nodeEnv === 'production'
    res.clearCookie('at', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
    res.clearCookie('rt', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })

    // Clear active device cache from Redis
    try {
      await redisClient.del(`active_device:${req.user.id}`);
    } catch (_re) {}

    res.json({ message: "All sessions terminated." });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res) => {
  const { endpoint } = req.body
  if (endpoint) {
    try { await prisma.pushSubscription.deleteMany({ where: { endpoint } }) } catch (_e) {}
  }
  try {
    const payload = verifyJwt(String(req.cookies?.rt || '')) as { jti?: string; sub?: string };
    if (payload && typeof payload === 'object' && 'jti' in payload && typeof payload.jti === 'string') {
      await prisma.refreshToken.updateMany({ where: { jti: payload.jti }, data: { revokedAt: new Date() } })
      
      // Clear active device cache if we have the user ID
      if (payload.sub) {
        try { await redisClient.del(`active_device:${payload.sub}`); } catch (_re) {}
      }
    }
  } catch (_e) {}
  const isProd = env.nodeEnv === 'production'
  res.clearCookie('at', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
  res.clearCookie('rt', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
  res.json({ ok: true })
})

router.get('/pow/challenge', requireAuth, async (req, res, next) => {
  try {
    const sodium = await getSodium();
    const salt = sodium.to_hex(sodium.randombytes_buf(16));
    const ip = req.ip || req.socket.remoteAddress;
    const userId = req.user?.id;
    const fingerprint = req.headers['x-nyx-fingerprint'];
    const instId = req.headers['x-nyx-installation-id'];

    if (!ip && !userId && !fingerprint && !instId) {
      throw new ApiError(400, 'Cannot determine client identifier for PoW challenge.');
    }

    // MULTI-LAYER IDENTIFICATION: 
    // We prioritize Installation ID (IDB), then Fingerprint, then IP
    const primaryId = instId || fingerprint || ip || userId;
    const stableHash = sodium.to_hex(sodium.crypto_generichash(32, Buffer.from(String(primaryId)), null)).slice(0, 16);

    // Choose prefix based on most reliable available identifier
    const prefix = instId ? 'pow:inst' : (fingerprint ? 'pow:fp' : (ip ? 'pow:ip' : 'pow:user'));
    const rateKey = `${prefix}:${stableHash}`;

    let count = await redisClient.incr(rateKey);
    if (count === 1) {
        await redisClient.expire(rateKey, 86400);
    } else if (Number.isNaN(count) || count < 0) {
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

      const challengeData = await redisClient.get(`pow:challenge:${userId}`);
      if (!challengeData) {
        throw new ApiError(400, 'Challenge expired or invalid. Please request a new one.');
      }

      const { salt, difficulty } = JSON.parse(challengeData as string) as { salt: string, difficulty: number };

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
    } as unknown as VerifyOpts)

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
          devices: { orderBy: { lastActiveAt: 'desc' }, take: 1 }
        }
      })

      if (!safeUser) throw new ApiError(404, 'User not found')
      if (safeUser.bannedAt) return res.status(403).json({ error: 'ACCESS DENIED: Your account has been suspended.', reason: safeUser.banReason })

      const fingerprint = req.headers['x-nyx-fingerprint'] as string | undefined;
      const installationId = req.headers['x-nyx-installation-id'] as string | undefined;

      const latestDevice = safeUser.devices[0];
      let activeDeviceId = latestDevice?.id;
      let encryptedPrivKeyStr = null;

      if (latestDevice) {
         if (latestDevice.fingerprint && fingerprint && latestDevice.fingerprint !== fingerprint) {
             if (latestDevice.installationId && latestDevice.installationId === installationId) {
                 await prisma.device.update({
                     where: { id: latestDevice.id },
                     data: { fingerprint, lastActiveAt: new Date() }
                 });
             } else {
                 console.warn(`[Security] Hardware/Anchor mismatch for device ${latestDevice.id} via WebAuthn. Forcing recovery flow.`);
                 activeDeviceId = '';
             }
         } else {
             await prisma.device.update({
                 where: { id: latestDevice.id },
                 data: { 
                     lastActiveAt: new Date(), 
                     fingerprint: fingerprint || latestDevice.fingerprint, 
                     installationId: installationId || latestDevice.installationId 
                 }
             });
         }
      }

      if (!activeDeviceId) {
          // Force recovery flow by not sending tokens or keys.
          // The client will see a 200 OK without keys and throw IDENTITY_RECOVERY_REQUIRED.
      } else {
          encryptedPrivKeyStr = latestDevice.encryptedPrivateKey
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