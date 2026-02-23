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
import { sendVerificationEmail } from '../utils/mailer.js' // Pastikan file utils/mailer.ts sudah ada
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
  const access = signAccessToken({ 
    id: user.id, 
    email: user.email, 
    username: user.username,
    role: user.role 
  })
  const jti = newJti()
  const refresh = signAccessToken({ sub: user.id, jti }, { expiresIn: '30d' })

  // Privacy: Hash IP address to prevent long-term logging of raw IPs
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
  // Jika di development dan tidak ada key, kita bisa bypass atau return true untuk testing
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

// === STANDARD AUTH ROUTES ===

router.post('/register', authLimiter, zodValidate({
  body: z.object({
    email: z.string().email().max(200),
    username: z.string().min(3).max(32),
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(80),
    publicKey: z.string().optional(),
    signingKey: z.string().optional(),
    encryptedPrivateKeys: z.string().optional(), // New: Accept encrypted keys blob
    turnstileToken: z.string().optional() // Token dari frontend
  })
}),
async (req, res, next) => {
  try {
    const { email, username, password, name, publicKey, signingKey, encryptedPrivateKeys, turnstileToken } = req.body

    // 1. Verifikasi Captcha
    const isHuman = await verifyTurnstileToken(turnstileToken || '')
    if (!isHuman) throw new ApiError(400, 'Bot detected. Please try again.')

    // 2. Cek Duplikat
    const existingUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] }
    })
    if (existingUser) throw new ApiError(409, 'Email or username already exists.')

    // 3. Buat User (Unverified)
    const passwordHash = await hashPassword(password)
    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        name,
        publicKey,
        signingKey,
        encryptedPrivateKey: encryptedPrivateKeys, // Store the encrypted blob
        isEmailVerified: false // Default false
      }
    })

    // 4. Generate & Kirim OTP
    const otp = crypto.randomInt(100000, 999999).toString()
    await redisClient.setEx(`verify:${user.id}`, 300, otp) // Expire 5 menit

    // Kirim email background (jangan await agar response cepat)
    sendVerificationEmail(email, otp).catch(err => console.error('Email fail:', err))

    // 5. Response (TIDAK login dulu)
    res.status(201).json({
      message: 'Registration successful. Please verify your email.',
      userId: user.id,
      email: user.email,
      needVerification: true // Flag untuk frontend pindah ke halaman OTP
    })
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return next(new ApiError(409, 'Email or username already in use.'))
    }
    next(e)
  }
}
)

// Route Baru: Verifikasi Email
router.post('/verify-email', otpLimiter, zodValidate({
  body: z.object({
    userId: z.string(),
    code: z.string().length(6)
  })
}),
async (req, res, next) => {
  try {
    const { userId, code } = req.body

    // Cek OTP di Redis
    const storedOtp = await redisClient.get(`verify:${userId}`)
    if (!storedOtp) throw new ApiError(400, 'Verification code has expired. Please request a new one.')
    if (storedOtp !== code) throw new ApiError(400, 'Invalid verification code. Please try again.')

    // Update User jadi Verified
    const user = await prisma.user.update({
      where: { id: userId },
      data: { isEmailVerified: true },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        showEmailToOthers: true,
        description: true,
        hasCompletedOnboarding: true,
        isEmailVerified: true
      }
    })

    // Hapus OTP dari Redis
    await redisClient.del(`verify:${userId}`)

    // Login otomatis setelah verifikasi
    // Ambil user tanpa field sensitif untuk response
    const safeUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        isEmailVerified: true,
        description: true,
        hasCompletedOnboarding: true,
        showEmailToOthers: true
      }
    })

    if (!safeUser) throw new ApiError(404, 'User not found after verification.')

    const tokens = await issueTokens(safeUser, req)
    setAuthCookies(res, tokens)

    res.json({ message: 'Email verified successfully.', user: safeUser, accessToken: tokens.access })
  } catch (e) {
    next(e)
  }
}
)

// Route Baru: Kirim Ulang OTP
router.post('/resend-verification', authLimiter, zodValidate({
  body: z.object({ email: z.string().email() })
}), async (req, res, next) => {
  try {
    const { email } = req.body
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        isEmailVerified: true
      }
    })

    if (!user) throw new ApiError(404, 'User not found.')
    if (user.isEmailVerified) throw new ApiError(400, 'Email already verified.')

    const otp = crypto.randomInt(100000, 999999).toString()
    await redisClient.setEx(`verify:${user.id}`, 300, otp)

    sendVerificationEmail(email, otp).catch(console.error)

    res.json({ message: 'Verification code sent.' })
  } catch (e) { next(e) }
})

router.post('/login', authLimiter, zodValidate({
  body: z.object({ emailOrUsername: z.string().min(1), password: z.string().min(8) })
}),
async (req, res, next) => {
  try {
    const { emailOrUsername, password } = req.body
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        isEmailVerified: true,
        showEmailToOthers: true,
        description: true,
        passwordHash: true, // Tetap diperlukan untuk verifikasi password
        hasCompletedOnboarding: true,
        encryptedPrivateKey: true, // Retrieve the encrypted keys blob
        role: true,
        bannedAt: true,
        banReason: true
      }
    })

    if (!user) throw new ApiError(401, 'Invalid credentials')
    
    // Cek Banned
    if (user.bannedAt) {
      return res.status(403).json({ 
        error: 'ACCESS DENIED: Your account has been suspended.',
        reason: user.banReason 
      })
    }

    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) throw new ApiError(401, 'Invalid credentials')

    // Cek Status Verifikasi
    if (!user.isEmailVerified) {
      throw new ApiError(403, 'Email not verified. Please verify your email first.')
    }

    // Ambil ulang user tanpa passwordHash untuk response
    // Note: We already selected encryptedPrivateKey above, so we can pass it directly
    const safeUser = {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isEmailVerified: user.isEmailVerified,
        hasCompletedOnboarding: user.hasCompletedOnboarding,
        description: user.description,
        showEmailToOthers: user.showEmailToOthers,
        role: user.role
    }

    const tokens = await issueTokens(safeUser, req)
    setAuthCookies(res, tokens)

    // Return encryptedPrivateKey separately so client can restore it
    res.json({ 
      user: safeUser, 
      accessToken: tokens.access,
      encryptedPrivateKey: user.encryptedPrivateKey 
    })
  } catch (e) {
    next(e)
  }
}
)

router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.rt
    if (!token) throw new ApiError(401, 'No refresh token')
    const payload = verifyJwt(token)
    if (typeof payload === 'string' || !payload?.jti || !payload?.sub) {
      // Jika token tidak valid, hapus cookie untuk mencegah kondisi tidak konsisten
      const isProd = env.nodeEnv === 'production'
      const cookieOpts: CookieOptions = {
        path: '/',
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax'
      }

      res.clearCookie('at', cookieOpts)
      res.clearCookie('rt', cookieOpts)
      throw new ApiError(401, 'Invalid refresh token')
    }

    const stored = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } })
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Jika token tidak ditemukan, dicabut, atau kadaluarsa, hapus cookie
      const isProd = env.nodeEnv === 'production'
      const cookieOpts: CookieOptions = {
        path: '/',
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax'
      }

      res.clearCookie('at', cookieOpts)
      res.clearCookie('rt', cookieOpts)
      throw new ApiError(401, 'Refresh token expired/revoked')
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        isEmailVerified: true,
        role: true,
        bannedAt: true,
        banReason: true
      }
    })
    if (!user) throw new ApiError(401, 'User not found')
    
    if (user.bannedAt) {
      throw new ApiError(403, `ACCESS DENIED: ${user.banReason || 'Account suspended'}`)
    }

    // Refresh Token Rotation: Hapus token lama agar tidak menumpuk & mencegah Replay Attack
    await prisma.refreshToken.delete({
      where: { jti: payload.jti }
    });

    const tokens = await issueTokens(user, req)
    setAuthCookies(res, tokens)
    res.json({ ok: true, accessToken: tokens.access })
  } catch (e) {
    console.error('Refresh token error:', e)
    next(e)
  }
})

router.post('/logout', async (req, res) => {
  const { endpoint } = req.body

  if (endpoint) {
    try {
      await prisma.pushSubscription.deleteMany({
        where: { endpoint }
      })
    } catch (e) {
      console.error('Failed to remove push subscription:', e)
    }
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
  const cookieOpts: CookieOptions = {
    path: '/',
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax'
  }

  res.clearCookie('at', cookieOpts)
  res.clearCookie('rt', cookieOpts)
  res.json({ ok: true })
})

// === WEBAUTHN ROUTES ===

router.get('/webauthn/register/options', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Unauthorized')

    const userAuthenticators = await prisma.authenticator.findMany({
      where: { userId: req.user.id }
    })

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(req.user.id)),
      userName: req.user.username,
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

      await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null } })

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

      // Ambil user tanpa field sensitif untuk response
      const safeUser = await prisma.user.findUnique({
        where: { id: userAuthenticator.user.id },
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          avatarUrl: true,
          isEmailVerified: true,
          showEmailToOthers: true,
          description: true,
          hasCompletedOnboarding: true,
          encryptedPrivateKey: true, // Include encrypted key blob
          role: true,
          bannedAt: true,
          banReason: true
        }
      })

      if (!safeUser) throw new ApiError(404, 'User not found')

      if (safeUser.bannedAt) {
        return res.status(403).json({ error: 'ACCESS DENIED: Your account has been suspended.', reason: safeUser.banReason })
      }

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

// === DEVICE LINKING ===
router.post(
  '/finalize-linking',
  zodValidate({ body: z.object({ linkingToken: z.string() }) }),
  async (req, res, next) => {
    try {
      const { linkingToken } = req.body
      const userId = await redisClient.get(linkingToken)
      if (!userId) throw new ApiError(401, 'Invalid or expired linking token.')

      await redisClient.del(linkingToken)
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          avatarUrl: true,
          isEmailVerified: true
        }
      })
      if (!user) throw new ApiError(404, 'User not found.')

      const tokens = await issueTokens(user, req)
      setAuthCookies(res, tokens)
      res.json({ user, accessToken: tokens.access })
    } catch (e) {
      next(e)
    }
  }
)

export default router
