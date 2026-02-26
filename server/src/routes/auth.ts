import { Router, Response, CookieOptions } from 'express'
import { prisma } from '../lib/prisma.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { ApiError } from '../utils/errors.js'
import { newJti, refreshExpiryDate, signAccessToken, verifyJwt } from '../utils/jwt.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { env } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { authLimiter, otpLimiter } from '../middleware/rateLimiter.js'
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

const router: Router = Router()

const rpName = 'NYX'
const getRpID = () => {
  try {
    return env.nodeEnv === 'production' ? new URL(env.corsOrigin).hostname : 'localhost'
  } catch (e) {
    return 'localhost'
  }
}
const rpID = getRpID()
const expectedOrigin = env.corsOrigin || 'https://nyx-app.my.id'

function setAuthCookies (res: Response, { access, refresh }: { access: string; refresh: string }) {
  const isProd = env.nodeEnv === 'production'

  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/'
  }

  res.cookie('at', access, {
    ...cookieOptions,
    maxAge: 1000 * 60 * 15 // 15 mins
  })

  res.cookie('rt', refresh, {
    ...cookieOptions,
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
  })
}

async function issueTokens (user: any, req: any) {
  // PURE ANONYMITY: Only store ID and Role in JWT. No Email/Username.
  const access = signAccessToken({ 
    id: user.id, 
    role: user.role 
  })
  const jti = newJti()
  const refresh = signAccessToken({ sub: user.id, jti }, { expiresIn: '30d' })

  const rawIp = req.ip || '';
  const ipAddress = crypto.createHash('sha256').update(rawIp).digest('hex').substring(0, 16);
  const userAgent = req.headers['user-agent']

  await prisma.refreshToken.create({
    data: { jti, userId: user.id, expiresAt: refreshExpiryDate(), ipAddress, userAgent }
  })
  return { access, refresh }
}

// Helper Turnstile
async function verifyTurnstileToken (token: string): Promise<boolean> {
  if (env.nodeEnv !== 'production' && !process.env.TURNSTILE_SECRET_KEY) return true
  if (!token) return false

  const formData = new FormData()
  formData.append('secret', process.env.TURNSTILE_SECRET_KEY || '')
  formData.append('response', token)

  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData
    })
    const outcome = await result.json()
    return outcome.success
  } catch (e) {
    console.error('Turnstile error:', e)
    return false
  }
}

// === ANONYMOUS AUTH ROUTES ===

router.post('/register', authLimiter, zodValidate({
  body: z.object({
    usernameHash: z.string().min(10), // Blind Index
    password: z.string().min(8).max(128),
    encryptedProfile: z.string().optional(),
    publicKey: z.string().optional(),
    signingKey: z.string().optional(),
    encryptedPrivateKeys: z.string().optional(),
    turnstileToken: z.string().optional()
  })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password, encryptedProfile, publicKey, signingKey, encryptedPrivateKeys, turnstileToken } = req.body

    // 1. Verifikasi Captcha
    const isHuman = await verifyTurnstileToken(turnstileToken || '')
    if (!isHuman) throw new ApiError(400, 'Bot detected. Please try again.')

    // 2. Cek Duplikat (Hash Collision Check)
    const existingUser = await prisma.user.findUnique({
      where: { usernameHash }
    })
    if (existingUser) throw new ApiError(409, 'Username already taken (Hash Collision).')

    // 3. Buat User (Verified: False = Sandbox)
    const passwordHash = await hashPassword(password)
    const user = await prisma.user.create({
      data: {
        usernameHash,
        passwordHash,
        encryptedProfile,
        publicKey,
        signingKey,
        encryptedPrivateKey: encryptedPrivateKeys,
        isVerified: false // Sandbox mode by default
      }
    })

    // 4. Issue Tokens Immediately (No OTP)
    const tokens = await issueTokens(user, req)
    setAuthCookies(res, tokens)

    res.status(201).json({
      message: 'Registration successful.',
      user: {
        id: user.id,
        encryptedProfile: user.encryptedProfile,
        isVerified: user.isVerified
      },
      accessToken: tokens.access,
      needVerification: false
    })
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return next(new ApiError(409, 'Username already taken.'))
    }
    next(e)
  }
})

router.post('/login', authLimiter, zodValidate({
  body: z.object({ usernameHash: z.string().min(10), password: z.string().min(8) })
}),
async (req, res, next) => {
  try {
    const { usernameHash, password } = req.body
    
    const user = await prisma.user.findUnique({
      where: { usernameHash },
      select: {
        id: true,
        usernameHash: true,
        encryptedProfile: true,
        isVerified: true,
        passwordHash: true,
        encryptedPrivateKey: true,
        role: true,
        bannedAt: true,
        banReason: true
      }
    })

    if (!user) throw new ApiError(401, 'Invalid credentials')
    
    if (user.bannedAt) {
      return res.status(403).json({ 
        error: 'ACCESS DENIED: Your account has been suspended.',
        reason: user.banReason 
      })
    }

    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) throw new ApiError(401, 'Invalid credentials')

    const safeUser = {
        id: user.id,
        encryptedProfile: user.encryptedProfile,
        isVerified: user.isVerified,
        role: user.role
    }

    const tokens = await issueTokens(safeUser, req)
    setAuthCookies(res, tokens)

    res.json({ 
      user: safeUser, 
      accessToken: tokens.access,
      encryptedPrivateKey: user.encryptedPrivateKey 
    })
  } catch (e) {
    next(e)
  }
})

router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.rt
    if (!token) throw new ApiError(401, 'No refresh token')
    const payload = verifyJwt(token)
    if (typeof payload === 'string' || !payload?.jti || !payload?.sub) {
      const isProd = env.nodeEnv === 'production'
      const cookieOpts: CookieOptions = { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' }
      res.clearCookie('at', cookieOpts)
      res.clearCookie('rt', cookieOpts)
      throw new ApiError(401, 'Invalid refresh token')
    }

    const stored = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } })
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      const isProd = env.nodeEnv === 'production'
      const cookieOpts: CookieOptions = { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' }
      res.clearCookie('at', cookieOpts)
      res.clearCookie('rt', cookieOpts)
      throw new ApiError(401, 'Refresh token expired/revoked')
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        encryptedProfile: true,
        isVerified: true,
        role: true,
        bannedAt: true,
        banReason: true
      }
    })
    if (!user) throw new ApiError(401, 'User not found')
    
    if (user.bannedAt) {
      throw new ApiError(403, `ACCESS DENIED: ${user.banReason || 'Account suspended'}`)
    }

    await prisma.refreshToken.delete({ where: { jti: payload.jti } });

    const tokens = await issueTokens(user, req)
    setAuthCookies(res, tokens)
    res.json({ ok: true, accessToken: tokens.access })
  } catch (e) {
    console.error('Refresh token error:', e)
    next(e)
  }
})

// === ZERO-KNOWLEDGE ACCOUNT RECOVERY ===
router.post('/recover', authLimiter, zodValidate({
  body: z.object({
    identifier: z.string().min(10), // usernameHash
    newPassword: z.string().min(8),
    newEncryptedKeys: z.string(),
    signature: z.string(),
    timestamp: z.number()
  })
}), async (req, res, next) => {
  try {
    const { identifier: usernameHash, newPassword, newEncryptedKeys, signature, timestamp } = req.body;

    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
       throw new ApiError(400, "Recovery request expired.");
    }

    // Match by Hash
    const user = await prisma.user.findUnique({
      where: { usernameHash }
    });
    if (!user || !user.signingKey) throw new ApiError(404, "User not found or invalid keys.");

    const { getSodium } = await import('../lib/sodium.js');
    const sodium = await getSodium();
    
    // Message: HASH:TIMESTAMP
    const messageString = `${usernameHash}:${timestamp}`;
    const messageBytes = Buffer.from(messageString, 'utf-8');
    const signatureBytes = sodium.from_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING);
    const publicKeyBytes = sodium.from_base64(user.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    const isValid = sodium.crypto_sign_verify_detached(signatureBytes, messageBytes, publicKeyBytes);
    if (!isValid) {
       throw new ApiError(401, "Cryptographic signature verification failed.");
    }

    const passwordHash = await hashPassword(newPassword);
    
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { 
        passwordHash, 
        encryptedPrivateKey: newEncryptedKeys 
      }
    });

    const tokens = await issueTokens(updatedUser, req);
    setAuthCookies(res, tokens);

    res.json({ message: "Account recovered successfully.", accessToken: tokens.access });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', async (req, res) => {
  const { endpoint } = req.body
  if (endpoint) {
    try {
      await prisma.pushSubscription.deleteMany({ where: { endpoint } })
    } catch (e) {}
  }
  const r = req.cookies?.rt
  if (r) {
    try {
      const payload = verifyJwt(r)
      if (typeof payload === 'object' && payload?.jti) {
        await prisma.refreshToken.updateMany({ where: { jti: payload.jti }, data: { revokedAt: new Date() } })
      }
    } catch (e) {}
  }
  const isProd = env.nodeEnv === 'production'
  const cookieOpts: CookieOptions = { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' }
  res.clearCookie('at', cookieOpts)
  res.clearCookie('rt', cookieOpts)
  res.json({ ok: true })
})

// === WEBAUTHN ROUTES ===

// === PROOF OF WORK (PoW) ROUTES ===

router.get('/pow/challenge', requireAuth, async (req, res, next) => {
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const difficulty = 4; // Target: Hash starts with '0000'
    
    // Store challenge in Redis (5 mins expiry)
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
      
      // Verify Hash: SHA256(salt + nonce)
      const hash = crypto.createHash('sha256').update(salt + nonce.toString()).digest('hex');
      
      if (hash.startsWith('0'.repeat(difficulty))) {
          // Valid PoW!
          await redisClient.del(`pow:challenge:${userId}`);
          
          // Upgrade User
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

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(req.user.id)),
      userName: user?.name || "Anonymous User", 
      attestationType: 'none',
      excludeCredentials: userAuthenticators.map(auth => ({
        id: isoBase64URL.toBuffer(auth.credentialID),
        type: 'public-key',
        transports: auth.transports ? (auth.transports.split(',') as any) : undefined
      })),
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

      // Upgrade Trust Tier to Verified (VIP)
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

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: userAuthenticator.credentialID,
        publicKey: isoBase64URL.toBuffer(userAuthenticator.credentialPublicKey),
        counter: Number(userAuthenticator.counter),
        transports: userAuthenticator.transports ? (userAuthenticator.transports.split(',') as any) : undefined
      },
      requireUserVerification: false
    } as any)

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
          encryptedProfile: true,
          isVerified: true,
          encryptedPrivateKey: true,
          role: true,
          bannedAt: true,
          banReason: true
        }
      })

      if (!safeUser) throw new ApiError(404, 'User not found')
      if (safeUser.bannedAt) return res.status(403).json({ error: 'ACCESS DENIED: Your account has been suspended.', reason: safeUser.banReason })

      const tokens = await issueTokens(safeUser, req)
      setAuthCookies(res, tokens)
      res.clearCookie('webauthn_challenge')

      res.json({ 
        verified: true, 
        user: safeUser, 
        accessToken: tokens.access,
        encryptedPrivateKey: safeUser.encryptedPrivateKey 
      })
    } else {
      res.status(400).json({ verified: false })
    }
  } catch (e) { next(e) }
})

export default router
