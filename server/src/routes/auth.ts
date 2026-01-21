import { Router, Response, CookieOptions } from "express";
import { prisma } from "../lib/prisma.js";
import bcrypt from "bcrypt";
import { ApiError } from "../utils/errors.js";
import { newJti, refreshExpiryDate, signAccessToken, verifyJwt } from "../utils/jwt.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { env } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { nanoid } from "nanoid";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { Buffer } from "buffer";
import { redisClient } from '../lib/redis.js';

const router: Router = Router();

const rpName = "Chat Lite";
const getRpID = () => {
  try {
    return env.nodeEnv === "production" ? new URL(env.corsOrigin).hostname : "localhost";
  } catch (e) {
    return "localhost";
  }
};
const rpID = getRpID();
const expectedOrigin = env.corsOrigin || "http://localhost:5173";

function setAuthCookies(res: Response, { access, refresh }: { access: string; refresh: string }) {
  const isProd = env.nodeEnv === "production";
  
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: isProd, 
    sameSite: isProd ? "none" : "lax",
    path: "/",
  };

  res.cookie("at", access, {
    ...cookieOptions,
    maxAge: 1000 * 60 * 15, // 15 mins
  });
  
  res.cookie("rt", refresh, {
    ...cookieOptions,
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  });
}

async function issueTokens(user: any, req: any) {
  const access = signAccessToken({ id: user.id, email: user.email, username: user.username });
  const jti = newJti();
  const refresh = signAccessToken({ sub: user.id, jti }, { expiresIn: "30d" });
  
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  await prisma.refreshToken.create({
    data: { jti, userId: user.id, expiresAt: refreshExpiryDate(), ipAddress, userAgent },
  });
  return { access, refresh };
}

// === STANDARD AUTH ROUTES ===

router.post("/register", authLimiter, zodValidate({
    body: z.object({
      email: z.string().email().max(200),
      username: z.string().min(3).max(32),
      password: z.string().min(8).max(128),
      name: z.string().min(1).max(80),
      publicKey: z.string().optional(),
      signingKey: z.string().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { email, username, password, name, publicKey, signingKey } = req.body;
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: { email, username, passwordHash, name, publicKey, signingKey },
      });
      const tokens = await issueTokens(user, req);
      setAuthCookies(res, tokens);
      res.status(201).json({ user, accessToken: tokens.access });
    } catch (e: any) {
      if (e?.code === "P2002") {
        return next(new ApiError(409, "Email or username already in use."));
      }
      next(e);
    }
  }
);

router.post("/login", authLimiter, zodValidate({
    body: z.object({ emailOrUsername: z.string().min(1), password: z.string().min(8) }),
  }),
  async (req, res, next) => {
    try {
      const { emailOrUsername, password } = req.body;
      const user = await prisma.user.findFirst({ where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] } });
      if (!user) throw new ApiError(401, "Invalid credentials");
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) throw new ApiError(401, "Invalid credentials");
      const tokens = await issueTokens(user, req);
      setAuthCookies(res, tokens);
      res.json({ user, accessToken: tokens.access });
    } catch (e) {
      next(e);
    }
  }
);

router.post("/refresh", async (req, res, next) => {
  try {
    const token = req.cookies?.rt;
    if (!token) throw new ApiError(401, "No refresh token");
    const payload = verifyJwt(token);
    if (typeof payload === 'string' || !payload?.jti || !payload?.sub) throw new ApiError(401, "Invalid refresh token");

    const stored = await prisma.refreshToken.findUnique({ where: { jti: payload.jti } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) throw new ApiError(401, "Refresh token expired/revoked");

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new ApiError(401, "User not found");
    const tokens = await issueTokens(user, req);
    setAuthCookies(res, tokens);
    res.json({ ok: true, accessToken: tokens.access });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", async (req, res) => {
  const { endpoint } = req.body;

  if (endpoint) {
    try {
      await prisma.pushSubscription.deleteMany({
        where: { endpoint: endpoint }
      });
    } catch (e) {
      console.error("Failed to remove push subscription:", e);
    }
  }

  const r = req.cookies?.rt;
  if (r) {
    try {
      const payload = verifyJwt(r);
      if (typeof payload === 'object' && payload?.jti) {
        await prisma.refreshToken.updateMany({ where: { jti: payload.jti }, data: { revokedAt: new Date() } });
      }
    } catch (e) {}
  }
  
  const isProd = env.nodeEnv === "production";
  const cookieOpts: CookieOptions = { 
    path: "/", 
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax"
  };
  
  res.clearCookie("at", cookieOpts);
  res.clearCookie("rt", cookieOpts);
  res.json({ ok: true });
});

// === WEBAUTHN ROUTES ===

router.get("/webauthn/register/options", requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Unauthorized");
    
    const userAuthenticators = await prisma.authenticator.findMany({
      where: { userId: req.user.id }
    });

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(req.user.id)),
      userName: req.user.username,
      attestationType: 'none',
      excludeCredentials: userAuthenticators.map(auth => ({
        id: isoBase64URL.toBuffer(auth.credentialID),
        type: 'public-key',
        transports: auth.transports ? (auth.transports.split(',') as any) : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform',
      },
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { currentChallenge: options.challenge }
    });

    res.json(options);
  } catch (e) { next(e); }
});

router.post("/webauthn/register/verify", requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Unauthorized");
    const { body } = req;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.currentChallenge) throw new ApiError(400, "No challenge found.");

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: user.currentChallenge,
      expectedOrigin,
      expectedRPID: rpID,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      const { id: credentialID, publicKey: credentialPublicKey, counter } = credential;

      await prisma.authenticator.create({
        data: {
          id: nanoid(),
          credentialID: credentialID, 
          userId: user.id,
          credentialPublicKey: isoBase64URL.fromBuffer(credentialPublicKey),
          counter: BigInt(counter),
          credentialDeviceType,
          credentialBackedUp,
          transports: body.response.transports ? body.response.transports.join(',') : null,
        }
      });

      await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null } });

      res.json({ verified: true });
    } else {
      res.status(400).json({ verified: false, error: "Verification failed" });
    }
  } catch (e) { next(e); }
});

router.get("/webauthn/login/options", async (req, res, next) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
    });

    res.cookie('webauthn_challenge', options.challenge, { httpOnly: true, maxAge: 60000, secure: env.nodeEnv === 'production' });
    
    res.json(options);
  } catch (e) { next(e); }
});

router.post("/webauthn/login/verify", async (req, res, next) => {
  try {
    const { body } = req;
    const challenge = req.cookies.webauthn_challenge;

    if (!challenge) throw new ApiError(400, "Challenge expired or missing.");

    const credentialID = body.id;
    // FIX: Ubah nama variabel jadi userAuthenticator biar gak bentrok sama nama properti di bawah
    const userAuthenticator = await prisma.authenticator.findUnique({
      where: { credentialID: credentialID },
      include: { user: true }
    });

    if (!userAuthenticator) throw new ApiError(400, "Unknown device.");

    // FIX: Gunakan properti 'credential' (BUKAN authenticator)
    // Library mengharapkan { credential: { id, publicKey, counter, ... } }
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: userAuthenticator.credentialID,
        publicKey: isoBase64URL.toBuffer(userAuthenticator.credentialPublicKey),
        counter: Number(userAuthenticator.counter),
        transports: userAuthenticator.transports ? (userAuthenticator.transports.split(',') as any) : undefined,
      }, 
      requireUserVerification: false,
    } as any);

    if (verification.verified) {
      const { authenticationInfo } = verification;
      
      await prisma.authenticator.update({
        where: { id: userAuthenticator.id },
        data: { counter: BigInt(authenticationInfo.newCounter) }
      });

      const tokens = await issueTokens(userAuthenticator.user, req);
      setAuthCookies(res, tokens);
      
      res.clearCookie('webauthn_challenge');
      
      res.json({ verified: true, user: userAuthenticator.user, accessToken: tokens.access });
    } else {
      res.status(400).json({ verified: false });
    }
  } catch (e) { next(e); }
});

// === DEVICE LINKING ===
router.post(
  "/finalize-linking",
  zodValidate({ body: z.object({ linkingToken: z.string() }) }),
  async (req, res, next) => {
    try {
      const { linkingToken } = req.body;
      const userId = await redisClient.get(linkingToken);
      if (!userId) throw new ApiError(401, "Invalid or expired linking token.");

      await redisClient.del(linkingToken);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new ApiError(404, "User not found.");
      
      const tokens = await issueTokens(user, req);
      setAuthCookies(res, tokens);
      res.json({ user, accessToken: tokens.access });
    } catch (e) {
      next(e);
    }
  }
);

export default router;