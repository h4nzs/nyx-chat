import { Router, Response } from "express";
import { prisma } from "../lib/prisma.js";
import bcrypt from "bcrypt";
import { ApiError } from "../utils/errors.js";
import { newJti, refreshExpiryDate, signAccessToken, verifyJwt } from "../utils/jwt.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { env } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/types";
import type { VerifiedRegistrationResponse, VerifiedAuthenticationResponse } from "@simplewebauthn/server";
import { Buffer } from "buffer";
import { redisClient } from '../lib/redis.js';

const router = Router();

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
  res.cookie("at", access, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 15,
  });
  res.cookie("rt", refresh, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

async function issueTokens(user: any, req: import('express').Request) {
  const access = signAccessToken({ id: user.id, email: user.email, username: user.username });
  const jti = newJti();
  const refresh = signAccessToken({ sub: user.id, jti }, { expiresIn: "30d" });
  await prisma.refreshToken.create({
    data: { jti, userId: user.id, expiresAt: refreshExpiryDate(), ipAddress: req.ip, userAgent: req.headers['user-agent'] },
  });
  return { access, refresh };
}

router.post("/register", zodValidate({
    body: z.object({
      email: z.string().email().max(200),
      username: z.string().min(3).max(32),
      password: z.string().min(8).max(128),
      name: z.string().min(1).max(80),
      publicKey: z.string(),
      signingKey: z.string(),
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
      res.status(201).json({ user });
    } catch (e: any) {
      if (e?.code === "P2002") {
        return next(new ApiError(409, "Email or username already in use."));
      }
      next(e);
    }
  }
);

router.post("/login", zodValidate({
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
      res.json({ user });
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
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", async (req, res) => {
  const r = req.cookies?.rt;
  if (r) {
    try {
      const payload = verifyJwt(r);
      if (typeof payload === 'object' && payload?.jti) {
        await prisma.refreshToken.updateMany({ where: { jti: payload.jti }, data: { revokedAt: new Date() } });
      }
    } catch (e) {
      // Ignore errors on logout
    }
  }
  res.clearCookie("at", { path: "/" });
  res.clearCookie("rt", { path: "/" });
  res.json({ ok: true });
});

// === WEBAUTHN ===
router.get("/webauthn/register-options", requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Auth required");
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) throw new ApiError(404, "User not found");

    const userAuthenticators = await prisma.authenticator.findMany({ where: { userId: user.id } });
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.username,
      userID: Buffer.from(user.id, 'utf-8'),
      excludeCredentials: userAuthenticators.map(auth => ({
        id: auth.credentialID,
        type: 'public-key',
        transports: auth.transports?.split(',') as AuthenticatorTransportFuture[],
      })),
      attestationType: 'none',
    });
    await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: options.challenge } });
    res.json(options);
  } catch (e) {
    next(e);
  }
});

router.post("/webauthn/register-verify", requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Auth required");
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.currentChallenge) throw new ApiError(400, "No challenge for this user.");
    
    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body as RegistrationResponseJSON,
        expectedChallenge: user.currentChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false
      });
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    const { verified, registrationInfo } = verification;
    if (verified && registrationInfo) {
      // PERBAIKAN: Akses credentialID, credentialPublicKey, dan counter dari properti 'credential'
      const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
      
      const newAuthData = {
        id: Buffer.from(credential.id).toString('base64url'),
        userId: user.id,
        credentialID: Buffer.from(credential.id).toString('base64url'),
        credentialPublicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        transports: req.body.response.transports?.join(','),
      };
      await prisma.authenticator.create({ data: newAuthData });
      await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null } });
      return res.json({ verified });
    }
    res.status(400).json({ error: "Could not verify registration." });
  } catch (e) {
    next(e);
  }
});

router.post("/webauthn/auth-options", async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username is required." });
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: username }, { username }] },
      include: { authenticators: true },
    });
    if (!user || user.authenticators.length === 0) return res.status(404).json({ error: "User or authenticators not found." });

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: user.authenticators.map((auth) => ({
        id: auth.credentialID,
        type: 'public-key',
        transports: auth.transports?.split(',') as AuthenticatorTransportFuture[],
      })),
      userVerification: 'preferred',
    });
    await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: options.challenge } });
    res.json(options);
  } catch (e) {
    next(e);
  }
});

router.post("/webauthn/auth-verify", async (req, res, next) => {
  try {
    const { username, webauthnResponse } = req.body as { username: string, webauthnResponse: AuthenticationResponseJSON };
    if (!username || !webauthnResponse) return res.status(400).json({ error: "Missing fields." });

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: username }, { username }] },
      include: { authenticators: true },
    });
    if (!user || !user.currentChallenge) return res.status(400).json({ error: "User or challenge not found." });

    const authenticator = user.authenticators.find((auth) => auth.credentialID === webauthnResponse.id);
    if (!authenticator) return res.status(404).json({ error: "Authenticator not found." });

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response: webauthnResponse,
        expectedChallenge: user.currentChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        authenticator: {
          id: Buffer.from(authenticator.credentialID, 'base64url'),
          publicKey: Buffer.from(authenticator.credentialPublicKey, 'base64url'),
          counter: authenticator.counter,
          transports: authenticator.transports?.split(',') as AuthenticatorTransportFuture[],
        },
        requireUserVerification: false,
      });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }


    if (!verification.verified) return res.status(400).json({ error: "Verification failed." });
    
    await prisma.authenticator.update({ where: { id: authenticator.id }, data: { counter: verification.authenticationInfo.newCounter } });
    await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null } });

    const tokens = await issueTokens(user, req);
    setAuthCookies(res, tokens);
    res.json({ verified: true, user: { id: user.id, username: user.username, name: user.name, avatarUrl: user.avatarUrl, description: user.description } });
  } catch (e) {
    next(e);
  }
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
      res.json({ user });
    } catch (e) {
      next(e);
    }
  }
);

export default router;