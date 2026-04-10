// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router, Response, CookieOptions, Request } from 'express'
import { prisma } from '../lib/prisma.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { ApiError } from '../utils/errors.js'
import { newJti, refreshExpiryDate, signAccessToken, verifyJwt } from '../utils/jwt.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { env } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { authLimiter } from '../middleware/rateLimiter.js'
import { nanoid } from 'nanoid'
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

const router: Router = Router()

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
  const ipAddress = crypto.createHash('sha256').update(rawIp).digest('hex').substring(0, 16);
  const userAgent = req.headers['user-agent']

  await prisma.refreshToken.create({
    data: { jti, deviceId, expiresAt: refreshExpiryDate(), ipAddress, userAgent }
  })
  return { access, refresh }
}

async function verifyTurnstileToken (token: string): Promise<boolean> {
  if (env.nodeEnv !== 'production' && !process.env.TURNSTILE_SECRET_KEY) return true
  if (!token) return false

  const formData = new FormData()
  formData.append('secret', process.env.TURNSTILE_SECRET_KEY || '')
  formData.append('response', token)

  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: formData })
    const outcome = await result.json() as { success: boolean }
    return outcome.success
  } catch (e) {
    return false
  }
}

router.post('/register', authLimiter, zodValidate({
  body: z.object({
    usernameHash: z.string().min(10),
    password: z.string().min(8).max(128),
    encryptedProfile: z.string().optional(),
    publicKey: z.string().optional(),
    signingKey: z.string().optional(),
    encryptedPrivateKeys: z.string().optional(),
    deviceName: z.string().optional(),
    turnstileToken: z.string().optional()
  })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password, encryptedProfile, publicKey, signingKey, encryptedPrivateKeys, deviceName, turnstileToken } = req.body

    const isHuman = await verifyTurnstileToken(turnstileToken || '')
    if (!isHuman) throw new ApiError(400, 'Bot detected. Please try again.')

    const existingUser = await prisma.user.findUnique({ where: { usernameHash } })
    if (existingUser) throw new ApiError(409, 'Username already taken (Hash Collision).')

    const passwordHash = await hashPassword(password)
    
    const user = await prisma.user.create({
      data: {
        usernameHash,
        passwordHash,
        encryptedProfile,
        isVerified: false,
        devices: {
          create: {
            publicKey: publicKey || '',
            signingKey: signingKey || '',
            encryptedPrivateKey: encryptedPrivateKeys,
            name: deviceName || 'Primary Device'
          }
        }
      },
      include: { devices: true }
    })

    const deviceId = user.devices[0].id
    const tokens = await issueTokens(user, deviceId, req)
    setAuthCookies(res, tokens)

    res.status(201).json({
      message: 'Registration successful.',
      user: { id: user.id, usernameHash: user.usernameHash, encryptedProfile: user.encryptedProfile, isVerified: user.isVerified },
      accessToken: tokens.access,
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
    publicKey: z.string().optional(),
    signingKey: z.string().optional(),
    encryptedPrivateKey: z.string().optional(),
    deviceName: z.string().optional()
  })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password, publicKey, signingKey, encryptedPrivateKey, deviceName } = req.body
    
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
      let device = await prisma.device.findFirst({
         where: { userId: user.id, publicKey }
      });
      
      if (device) {
          device = await prisma.device.update({
              where: { id: device.id },
              data: { lastActiveAt: new Date(), signingKey, encryptedPrivateKey, name: getGenericDeviceName(req.headers['user-agent']) }
          });
      } else {
          device = await prisma.device.create({
            data: {
              userId: user.id,
              publicKey,
              signingKey,
              encryptedPrivateKey,
              name: getGenericDeviceName(req.headers['user-agent'])
            }
          });
      }
      activeDeviceId = device.id;
      activeEncryptedPrivateKey = device.encryptedPrivateKey!;
    } else {
      const explicitDeviceId = req.body.deviceId;
      if (explicitDeviceId) {
          const device = user.devices.find(d => d.id === explicitDeviceId);
          if (!device) throw new ApiError(404, 'Specified device not found.');
          activeDeviceId = device.id;
          activeEncryptedPrivateKey = device.encryptedPrivateKey!;
          await prisma.device.update({ where: { id: device.id }, data: { lastActiveAt: new Date() } });
      } else {
          if (user.devices.length === 0) throw new ApiError(404, 'No device found. Please recover your account.');
          activeDeviceId = user.devices[0].id;
          activeEncryptedPrivateKey = user.devices[0].encryptedPrivateKey!;
          await prisma.device.update({ where: { id: activeDeviceId }, data: { lastActiveAt: new Date() } });
      }
    }

    const safeUser = { id: user.id, usernameHash: user.usernameHash, encryptedProfile: user.encryptedProfile, isVerified: user.isVerified, role: user.role }

    const tokens = await issueTokens(safeUser, activeDeviceId, req)
    setAuthCookies(res, tokens)

    res.json({ 
      user: safeUser, 
      accessToken: tokens.access,
      encryptedPrivateKey: activeEncryptedPrivateKey 
    })
  } catch (e) {
    next(e)
  }
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
    const nonce = crypto.randomBytes(32).toString('hex');
    await redisClient.setEx(`recover_nonce:${identifier}`, 300, nonce);
    res.json({ nonce });
  } catch (e) { next(e); }
});

router.post('/recover', authLimiter, zodValidate({
  body: z.object({
    identifier: z.string().min(10),
    newPassword: z.string().min(8),
    newEncryptedKeys: z.string(),
    publicKey: z.string().optional(),
    signingKey: z.string().optional(),
    signature: z.string(),
    timestamp: z.number(),
    nonce: z.string()
  })
}), async (req, res, next) => {
  try {
    const { identifier: usernameHash, newPassword, newEncryptedKeys, publicKey, signingKey, signature, timestamp, nonce } = req.body;

    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) throw new ApiError(400, "Recovery request expired.");

    const cachedNonce = await redisClient.get(`recover_nonce:${usernameHash}`);
    if (!cachedNonce || cachedNonce !== nonce) throw new ApiError(401, "Invalid or expired recovery challenge.");
    await redisClient.del(`recover_nonce:${usernameHash}`);

    const user = await prisma.user.findUnique({ where: { usernameHash }, include: { devices: true } });
    if (!user || user.devices.length === 0) throw new ApiError(404, "User not found or invalid keys.");

    const { getSodium } = await import('../lib/sodium.js');
    const sodium = await getSodium();
    const messageString = `${usernameHash}:${timestamp}:${nonce}:${newPassword}:${newEncryptedKeys}`;
    const messageBytes = Buffer.from(messageString, 'utf-8');
    const signatureBytes = sodium.from_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING);
    
    let isValid = false;
    for (const device of user.devices) {
        try {
            const publicKeyBytes = sodium.from_base64(device.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);
            if (sodium.crypto_sign_verify_detached(signatureBytes, messageBytes, publicKeyBytes)) {
                isValid = true;
                break;
            }
        } catch(e) {}
    }

    if (!isValid) throw new ApiError(401, "Cryptographic signature verification failed.");

    const passwordHash = await hashPassword(newPassword);

    const [updatedUser, _, __, newDevice] = await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
        prisma.device.deleteMany({ where: { userId: user.id } }), // 1. Sapu bersih perangkat lama yang bocor
        prisma.authenticator.deleteMany({ where: { userId: user.id } }), // 2. Bersihkan sesi biometrik lama
        prisma.device.create({ // 3. Buat perangkat yang baru dipulihkan
          data: {
            userId: user.id,
            publicKey: publicKey || '',
            signingKey: signingKey || '',
            encryptedPrivateKey: newEncryptedKeys,
            name: 'Recovered Device'
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
    res.json({ message: "All sessions terminated." });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res) => {
  const { endpoint } = req.body
  if (endpoint) {
    try { await prisma.pushSubscription.deleteMany({ where: { endpoint } }) } catch (_e) {}
  }
  try {
    const payload = verifyJwt(String(req.cookies?.rt || '')) as { jti?: string };
    if (payload && typeof payload === 'object' && 'jti' in payload && typeof payload.jti === 'string') {
      await prisma.refreshToken.updateMany({ where: { jti: payload.jti }, data: { revokedAt: new Date() } })
    }
  } catch (_e) {}
  const isProd = env.nodeEnv === 'production'
  res.clearCookie('at', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
  res.clearCookie('rt', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' })
  res.json({ ok: true })
})

router.get('/pow/challenge', requireAuth, async (req, res, next) => {
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const ip = req.ip || req.socket.remoteAddress;
    const userId = req.user?.id;
    
    if (!ip && !userId) {
      throw new ApiError(400, 'Cannot determine client identifier for PoW challenge.');
    }
    
    const rateKey = ip ? `pow:ip_count:${ip}` : `pow:user_count:${userId}`;
    let count = await redisClient.incr(rateKey);

    if (count === 1) {
        await redisClient.expire(rateKey, 86400);
    } else if (Number.isNaN(count) || count < 0) {
        count = 0;
    }

    const difficulty = Math.min(4 + Math.floor(count / 2), 6);
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
      
      const { salt, difficulty } = JSON.parse(challengeData as string);
      const hash = crypto.createHash('sha256').update(salt + nonce.toString()).digest('hex');
      
      if (hash.startsWith('0'.repeat(difficulty))) {
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
          bannedAt: true,
          banReason: true,
          devices: { orderBy: { lastActiveAt: 'desc' }, take: 1 }
        }
      })

      if (!safeUser) throw new ApiError(404, 'User not found')
      if (safeUser.bannedAt) return res.status(403).json({ error: 'ACCESS DENIED: Your account has been suspended.', reason: safeUser.banReason })

      const activeDeviceId = safeUser.devices[0]?.id;
      if (!activeDeviceId) throw new ApiError(404, 'No device found for this account.');

      const tokens = await issueTokens({ id: safeUser.id, role: safeUser.role }, activeDeviceId, req)
      setAuthCookies(res, tokens)
      res.clearCookie('webauthn_challenge')

      res.json({ 
        verified: true, 
        user: { id: safeUser.id, usernameHash: safeUser.usernameHash, encryptedProfile: safeUser.encryptedProfile, isVerified: safeUser.isVerified, role: safeUser.role }, 
        accessToken: tokens.access,
        encryptedPrivateKey: safeUser.devices[0]?.encryptedPrivateKey 
      })
    } else {
      res.status(400).json({ verified: false })
    }
  } catch (e) { next(e) }
})

export default router