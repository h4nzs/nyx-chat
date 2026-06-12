import { sendJsonToUser, broadcastToUsers, emitEventToUser, emitEventToUsers } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router, CookieOptions } from 'express'
import jwt from 'jsonwebtoken'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { env } from '../config.js'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'
import { asUserId, type UserId } from '@nyx/shared'
import { AuthJwtPayload } from '../types/auth.js';

const router: Router = Router()
router.use(requireAuth)

// --- STATIC ROUTES (Must be before /:id) ---

// GET authenticated user details (Me)
router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id
    
    let user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, usernameHash: true, role: true, encryptedProfile: true, isVerified: true, hasCompletedOnboarding: true, autoDestructDays: true, subscriptionTier: true, subscriptionExpiresAt: true }
    })

    if (!user) throw new ApiError(404, 'User not found');

    // RESTORE: Lazy Expiration Check
    if (user.subscriptionTier === 'SUBSCRIBER' && user.subscriptionExpiresAt && new Date() > user.subscriptionExpiresAt) {
        console.log(`[Auth] Subscription expired for user ${userId}. Downgrading to FREE.`);
        user = await prisma.user.update({
            where: { id: userId },
            data: { subscriptionTier: 'FREE' },
            select: { id: true, usernameHash: true, role: true, encryptedProfile: true, isVerified: true, hasCompletedOnboarding: true, autoDestructDays: true, subscriptionTier: true, subscriptionExpiresAt: true }
        });
    }

    res.json(user)
  } catch (error) { next(error) }
})

// GET devices (Me)
router.get('/me/devices', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id
    const authUser = req.user as AuthJwtPayload;

    const devices = await prisma.device.findMany({
      where: { userId },
      orderBy: { lastActiveAt: 'desc' },
      select: { id: true, name: true, lastActiveAt: true, createdAt: true }
    })

    res.json(devices.map(d => ({
      ...d,
      isCurrent: d.id === authUser.deviceId
    })))
  } catch (error) { next(error) }
})

// GET blocked users (Me)
router.get('/me/blocked', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id

    const blocked = await prisma.blockedUser.findMany({
      where: { blockerId: userId },
      include: {
        blocked: {
          select: { id: true, encryptedProfile: true, isVerified: true }
        }
      }
    })

    res.json(blocked.map(b => b.blocked))
  } catch (error) { next(error) }
})

// --- MUTATION ROUTES (Me) ---

// UPDATE user profile (Me)
router.put('/me', 
  zodValidate({
    body: z.object({
      encryptedProfile: z.string().optional(),
      autoDestructDays: z.number().min(0).max(365).optional()
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const userId = req.user.id
      const { encryptedProfile, autoDestructDays } = req.body

      const existingUser = await prisma.user.findUnique({ where: { id: userId } })
      const dataToUpdate: { encryptedProfile?: string, autoDestructDays?: number } = {}
      if (encryptedProfile !== undefined) dataToUpdate.encryptedProfile = encryptedProfile
      if (autoDestructDays !== undefined) dataToUpdate.autoDestructDays = autoDestructDays

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: dataToUpdate,
        select: { id: true, encryptedProfile: true, isVerified: true, hasCompletedOnboarding: true, autoDestructDays: true }
      })

      if (encryptedProfile !== undefined && (!existingUser || encryptedProfile !== existingUser.encryptedProfile)) {
        await emitEventToUser(userId, 'user:updated', { id: updatedUser.id as UserId, encryptedProfile: updatedUser.encryptedProfile })

        const conversations = await prisma.conversation.findMany({
          where: { participants: { some: { userId } } },
          include: { participants: { select: { userId: true } } }
        })

        const recipients = new Set<string>()
        for (const c of conversations) {
          for (const p of c.participants) {
            if (p.userId !== userId) recipients.add(p.userId);
          }
        }

        for (const recipientId of recipients) {
          await emitEventToUser(recipientId, 'user:updated', { id: updatedUser.id as UserId, encryptedProfile: updatedUser.encryptedProfile })
        }
      }

      res.json(updatedUser)
    } catch (error) { next(error) }
  }
)

// BLOCK User
router.post('/:id/block', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.');
    const blockerId = req.user.id;
    const blockedId = req.params.id;
    
    if (blockerId === blockedId) throw new ApiError(400, 'You cannot block yourself.');
    
    const targetUser = await prisma.user.findUnique({ where: { id: blockedId } });
    if (!targetUser) throw new ApiError(404, 'User not found.');

    await prisma.blockedUser.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {}
    });

    res.json({ message: 'User blocked successfully', blockedId });
  } catch (error) {
    next(error);
  }
});

// UNBLOCK User
router.delete('/:id/block', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.');
    const blockerId = req.user.id;
    const blockedId = req.params.id;

    await prisma.blockedUser.deleteMany({
      where: { blockerId, blockedId }
    });

    res.json({ message: 'User unblocked successfully', blockedId });
  } catch (error) {
    next(error);
  }
});

// REMOVE device (Session Revocation)
router.delete('/me/devices/:deviceId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.');
    const authUser = req.user as AuthJwtPayload;
    const targetDeviceId = req.params.deviceId;

    // 1. Validasi kepemilikan dan Hapus perangkat
    const deletedInfo = await prisma.device.deleteMany({
        where: { id: targetDeviceId, userId: authUser.id }
    });

    if (deletedInfo.count === 0) {
        throw new ApiError(404, "Device not found or already removed.");
    }

    // 2. Hapus Refresh Token (Memutus sesi JWT perangkat tersebut secara paksa)
    await prisma.refreshToken.deleteMany({
        where: { deviceId: targetDeviceId }
    });

    // 3. Kick WebTransport Connection
    try {
      await sendJsonToUser(authUser.id, TransportOpCode.KICK, { deviceId: targetDeviceId }, false, targetDeviceId);
    } catch (err) {
      console.error("[Users] Failed to send KICK to device:", err);
    }

    res.json({ message: "Device access revoked successfully." });
  } catch (e) { 
      next(e); 
  }
});

// UPDATE Public Keys (Me)
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

const base64UrlRegex = /^[A-Za-z0-9_-]+$/
router.put('/me/keys',
  zodValidate({
    body: z.object({
      publicKey: z.string().min(43).max(256).regex(base64UrlRegex, { message: 'Invalid public key format.' }),
      pqPublicKey: validateKey(1216),
      signingKey: z.string().min(43).max(256).regex(base64UrlRegex, { message: 'Invalid signing key format.' })
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')

      const authUser = req.user as AuthJwtPayload;
      const userId = authUser.id;
      const deviceId = authUser.deviceId;
      if (!deviceId) throw new ApiError(400, 'Device ID missing from session.')

      const { publicKey, pqPublicKey, signingKey } = req.body

      // FIX 2: Konversi String Base64 dari Client menjadi Buffer untuk Prisma Bytes
      await prisma.device.update({
        where: { id: deviceId },
        data: {
            publicKey: Buffer.from(publicKey, 'base64url'),
            pqPublicKey: Buffer.from(pqPublicKey, 'base64url'),
            signingKey: Buffer.from(signingKey, 'base64url')
        }
      })

      const conversations = await prisma.conversation.findMany({
        where: { participants: { some: { userId } } },
        include: { participants: { select: { userId: true } } }
      })

      const recipients = new Set<string>()
      conversations.forEach(c => c.participants.forEach(p => {
        if (p.userId !== userId) recipients.add(p.userId)
      }))

      for (const recipientId of recipients) {
        await emitEventToUser(recipientId, 'user:identity_changed', { userId })
      }

      res.status(200).json({ message: 'Keys updated successfully.' })
    } catch (error) { next(error) }
  }
)

// COMPLETE Onboarding (Me)
router.post('/me/complete-onboarding', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    await prisma.user.update({ where: { id: req.user.id }, data: { hasCompletedOnboarding: true } })
    res.status(200).json({ success: true })
  } catch (error) { next(error) }
})

// DELETE account (Me)
router.delete('/me', zodValidate({
  body: z.object({
    password: z.string(),
    fileKeys: z.array(z.string()).optional()
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id
    const { password, fileKeys } = req.body

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new ApiError(404, 'User not found')

    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) throw new ApiError(401, 'Invalid password')

    // 1. Delete R2 files if any
    if (fileKeys && fileKeys.length > 0) {
      const { deleteR2Files } = await import('../utils/r2.js')
      // Correctly filter keys that belong to this user. 
      // Key format: folder/userId-nanoid.ext
      const userFileKeys = fileKeys.filter((k: string) => {
        const parts = k.split('/');
        const fileName = parts.length > 1 ? parts[1] : parts[0];
        return fileName.startsWith(`${userId}-`);
      });

      if (userFileKeys.length > 0) {
        await deleteR2Files(userFileKeys).catch(err => console.error('[R2] Cleanup failed:', err))
      }
    }

    // 2. Delete user
    await prisma.user.delete({ where: { id: userId } })

    // 3. Clear cookies
    const options: CookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
    }
    res.clearCookie('at', options)
    res.clearCookie('rt', options)

    // 4. KICK WebTransport connections
    try {
      await emitEventToUser(userId, 'auth:banned', { reason: 'Account deleted' });
      await sendJsonToUser(userId, TransportOpCode.KICK, { reason: 'Account deleted' });
    } catch (err) {
      console.error("[Users] Failed to send KICK on deletion:", err);
    }

    res.status(204).send()
  } catch (error) { next(error) }
})

// LOGOUT (Me)
router.post('/me/logout', async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.rt
    const options: CookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
    }

    if (refreshToken) {
      try {
        const payload = jwt.verify(refreshToken, env.jwtSecret) as { jti: string };
        if (payload.jti) {
          await prisma.refreshToken.deleteMany({ where: { jti: payload.jti } });
        }
      } catch (e) {
        // Token invalid or expired, just proceed
      }
    }

    res.clearCookie('at', options)
    res.clearCookie('rt', options)
    res.status(200).json({ success: true })
  } catch (error) { next(error) }
})

// --- PARAMETERIZED ROUTES (Must be last) ---

// SEARCH users (Blind Indexing)
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query
    if (!q || typeof q !== 'string') throw new ApiError(400, 'Search query is required.')

    if (!req.user) throw new ApiError(401, 'Authentication required.')
    
    // RESTORE: Sandbox Search Restriction
    const requester = await prisma.user.findUnique({ where: { id: req.user.id }, select: { isVerified: true } });
    if (!requester?.isVerified) {
        throw new ApiError(403, 'SANDBOX_SEARCH_RESTRICTION: Unverified users can only find contacts by providing the exact Hash ID.');
    }

    const users = await prisma.user.findMany({
      where: { usernameHash: q },
      take: 20,
      select: { 
        id: true, 
        encryptedProfile: true, 
        isVerified: true, 
        hasCompletedOnboarding: true, 
        devices: { 
          orderBy: { lastActiveAt: 'desc' }, 
          take: 1, 
          select: { publicKey: true, pqPublicKey: true, signingKey: true } 
        } 
      }
    })
    
    const mappedUsers = users.map(user => {
      const latestDevice = user.devices[0];
      return {
        id: user.id,
        encryptedProfile: user.encryptedProfile,
        isVerified: user.isVerified,
        hasCompletedOnboarding: user.hasCompletedOnboarding,
        publicKey: latestDevice?.publicKey ? Buffer.from(latestDevice.publicKey).toString('base64url') : null,
        pqPublicKey: latestDevice?.pqPublicKey ? Buffer.from(latestDevice.pqPublicKey).toString('base64url') : null,
        signingKey: latestDevice?.signingKey ? Buffer.from(latestDevice.signingKey).toString('base64url') : null
      }
    });
    
    res.json(mappedUsers)
  } catch (error) { next(error) }
})

// GET user by ID
router.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, encryptedProfile: true, isVerified: true, hasCompletedOnboarding: true }
    })
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (error) { next(error) }
})

export default router
