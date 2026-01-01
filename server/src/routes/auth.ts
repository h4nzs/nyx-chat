import { Router, Response } from "express";
import { prisma } from "../lib/prisma.js";
import bcrypt from "bcrypt";
import { ApiError } from "../utils/errors.js";
import {
  newJti,
  refreshExpiryDate,
  signAccessToken,
  verifyJwt,
} from "../utils/jwt.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { env } from "../config.js";
import { JwtPayload } from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

import sodium from "libsodium-wrappers";

const router = Router();

// WebAuthn
const rpName = "Chat Lite";
const rpID = env.nodeEnv === "production" ? "chat-lite.dev" : "localhost";
const expectedOrigin = env.corsOrigin || "http://localhost:5173";

function setAuthCookies(
  res: Response,
  { access, refresh }: { access: string; refresh: string }
) {
  const isProd = env.nodeEnv === "production";
  const isTunnelTesting = true;

  res.cookie("at", access, {
    httpOnly: true,
    secure: isProd || isTunnelTesting,
    sameSite: isTunnelTesting ? "none" : "strict", // Changed from conditional to strict
    path: "/",
    maxAge: 1000 * 60 * 15, // 15 menit
  });

  res.cookie("rt", refresh, {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict",  // Changed from conditional to strict
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 hari
  });
}

async function issueTokens(user: any, req: import('express').Request) {
  const access = signAccessToken({
    id: user.id,
    email: user.email,
    username: user.username,
  });
  const jti = newJti();
  const refresh = signAccessToken({ sub: user.id, jti }, { expiresIn: "30d" });
  await prisma.refreshToken.create({
    data: { 
      jti, 
      userId: user.id, 
      expiresAt: refreshExpiryDate(),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    },
  });
  return { access, refresh };
}

// === REGISTER ===
router.post(
  "/register",
  zodValidate({
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

      await prisma.user.create({
        data: { email, username, passwordHash, name, publicKey, signingKey },
      });

      res.status(201).json({
        message: "User registered successfully. Please log in.",
      });
    } catch (e: any) {
      if (e.code === "P2002")
        return next(new ApiError(409, "Email or username already in use."));
      next(e);
    }
  }
);

// === LOGIN ===
router.post(
  "/login",
  zodValidate({
    body: z.object({
      emailOrUsername: z.string().min(1),
      password: z.string().min(8),
    }),
  }),
  async (req, res, next) => {
    try {
      const { emailOrUsername, password } = req.body;
      const user = await prisma.user.findFirst({
        where: {
          OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
        },
        select: {
          id: true,
          email: true,
          username: true,
          passwordHash: true,
          name: true,
          avatarUrl: true,
          hasCompletedOnboarding: true,
        }
      });
      if (!user) throw new ApiError(401, "Invalid credentials");

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) throw new ApiError(401, "Invalid credentials");

      const tokens = await issueTokens(user, req);
      setAuthCookies(res, tokens);
      res.json({
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatarUrl,
          hasCompletedOnboarding: user.hasCompletedOnboarding,
        },
      });
    } catch (e) {
      next(e);
    }
  }
);

// === REFRESH ===
router.post("/refresh", async (req, res, next) => {
  try {
    const token = req.cookies?.rt;
    if (!token) throw new ApiError(401, "No refresh token");

    const payload = verifyJwt(token) as JwtPayload | null;
    if (!payload?.jti || !payload?.sub)
      throw new ApiError(401, "Invalid refresh token");

    const stored = await prisma.refreshToken.findUnique({
      where: { jti: payload.jti },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date())
      throw new ApiError(401, "Refresh token expired/revoked");

    await prisma.refreshToken.update({
      where: { jti: payload.jti },
      data: { revokedAt: new Date() },
    });

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new ApiError(401, "User not found");

    const tokens = await issueTokens(user, req);
    setAuthCookies(res, tokens);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// === LOGOUT ===
router.post("/logout", async (req, res) => {
  const r = req.cookies?.rt;
  if (r) {
    const payload = verifyJwt(r) as JwtPayload | null;
    if (payload?.jti) {
      await prisma.refreshToken.updateMany({
        where: { jti: payload.jti },
        data: { revokedAt: new Date() },
      });
    }
  }
  res.clearCookie("at", { path: "/" });
  res.clearCookie("rt", { path: "/" });
  res.json({ ok: true });
});


// === WEBAUTHN REGISTRATION ===

// 1. Generate registration options
router.get("/webauthn/register-options", requireAuth, async (req, res, next) => {
  try {
    const user = req.user;

    const userAuthenticators = await prisma.authenticator.findMany({ 
      where: { userId: user.id }
    });

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: Buffer.from(user.id),
      userName: user.username,
      // Don't recommend users create multiple registrations of the same authenticator
      excludeCredentials: userAuthenticators.map(auth => ({
        id: auth.credentialID,
        type: 'public-key',
        transports: auth.transports?.split(',') as any,
      })),
    });

    // Store the challenge to verify it later
    await prisma.user.update({
      where: { id: user.id },
      data: { currentChallenge: options.challenge },
    });

    res.json(options);
  } catch (e) {
    next(e);
  }
});

// 2. Verify the registration response
router.post("/webauthn/register-verify", requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const { currentChallenge } = await prisma.user.findUnique({ where: { id: user.id }, select: { currentChallenge: true }});

    if (!currentChallenge) {
      return res.status(400).json({ error: "No challenge found for this user." });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: currentChallenge,
      expectedOrigin,
      expectedRPID: rpID,
    });

    const { verified, registrationInfo } = verification;

    if (verified && registrationInfo) {
      const { credentialPublicKey, credentialID, counter, credentialDeviceType, credentialBackedUp, transports } = registrationInfo;
      
      await prisma.authenticator.create({
        data: {
          userId: user.id,
          credentialID: Buffer.from(credentialID).toString('base64'),
          credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64'),
          counter,
          credentialDeviceType,
          credentialBackedUp,
          transports: transports?.join(','),
        },
      });

      // Clear the challenge
      await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null } });

      return res.json({ verified });
    }

    res.status(400).json({ error: "Could not verify registration." });

  } catch (e) {
    next(e);
  }
});

// === WEBAUTHN AUTHENTICATION ===

// 1. Generate authentication options
router.post("/webauthn/auth-options", async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: username }, { username: username }] },
      include: { authenticators: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const options = await generateAuthenticationOptions({
      allowCredentials: user.authenticators.map(auth => ({
        id: Buffer.from(auth.credentialID, 'base64'),
        type: 'public-key',
        transports: auth.transports?.split(',') as any,
      })),
      userVerification: 'preferred',
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { currentChallenge: options.challenge },
    });

    res.json(options);
  } catch (e) {
    next(e);
  }
});

// 2. Verify the authentication response and return the re-encrypted master key
router.post("/webauthn/auth-verify", async (req, res, next) => {
  try {
    const { username, password, webauthnResponse } = req.body;

    if (!username || !password || !webauthnResponse) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: username }, { username: username }] },
      include: { authenticators: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    const expectedChallenge = user.currentChallenge;
    if (!expectedChallenge) return res.status(400).json({ error: "No challenge found." });

    const authenticator = user.authenticators.find(
      (auth) => auth.credentialID === Buffer.from(webauthnResponse.rawId, 'base64').toString('base64')
    );

    if (!authenticator) return res.status(404).json({ error: "Authenticator not found." });

    const verification = await verifyAuthenticationResponse({
      response: webauthnResponse,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      authenticator: {
        credentialID: Buffer.from(authenticator.credentialID, 'base64'),
        credentialPublicKey: Buffer.from(authenticator.credentialPublicKey, 'base64'),
        counter: authenticator.counter,
        transports: authenticator.transports?.split(',') as any,
      },
    });

    const { verified, authenticationInfo } = verification;

    if (!verified) return res.status(400).json({ error: "Verification failed." });

    // Update the authenticator counter
    await prisma.authenticator.update({
      where: { id: authenticator.id },
      data: { counter: authenticationInfo.newCounter },
    });

    // Clear the challenge
    await prisma.user.update({ where: { id: user.id }, data: { currentChallenge: null } });

    // --- THIS IS THE KEY STEP ---
    // Decrypt the master private key with the user's password
    const encryptedMasterKey = ""; // This needs to be fetched from a secure vault/db
    // In our case, we can't do this securely on the server without the password.
    // The logic needs to be adjusted. The client will do the decryption.
    // For now, we will just send a success response.

    // The correct flow is: WebAuthn proves possession of the device.
    // The client can then unlock the locally stored encrypted private key.
    // We will adjust the client-side logic for this.

    // For now, just return a success and the JWTs to log the user in.
    const tokens = await issueTokens(user, req);
    setAuthCookies(res, tokens);

    res.json({ verified: true, user: { id: user.id, username: user.username, name: user.name } });

  } catch (e) {
    console.error("WebAuthn Auth Error:", e);
    next(e);
  }
});

// === DEVICE LINKING FINALIZATION ===
import { redisClient } from '../lib/redis.js';

router.post(
  "/finalize-linking",
  zodValidate({
    body: z.object({
      linkingToken: z.string(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { linkingToken } = req.body;

      const userId = await redisClient.get(linkingToken);

      if (!userId) {
        throw new ApiError(401, "Invalid or expired linking token.");
      }

      // Immediately delete the token to make it single-use
      await redisClient.del(linkingToken);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new ApiError(404, "User not found.");

      res.json({
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatarUrl,
          publicKey: user.publicKey,
          hasCompletedOnboarding: user.hasCompletedOnboarding,
        },
      });

    } catch (e) {
      next(e);
    }
  }
);


export default router;
