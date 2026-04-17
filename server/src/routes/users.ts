// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router, CookieOptions } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'
import { getIo } from '../socket.js'
import type { UserId, AuthJwtPayload } from '@nyx/shared'
import { Buffer } from 'buffer'

const router = Router()

router.use(requireAuth)

// ========================================================
// 1. SPECIFIC ROUTES (Harus di atas agar tidak ditangkap /:id)
// ========================================================

// Cari User (Exact Match pada Blind Index)
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query
    if (!q || typeof q !== 'string') return res.json([])

    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { isVerified: true } });
    if (!user?.isVerified) throw new ApiError(403, 'SANDBOX_SEARCH_RESTRICTION: Unverified users cannot search for other users.');
    
    const users = await prisma.user.findMany({
      where: { usernameHash: q },
      select: { id: true, encryptedProfile: true, isVerified: true, devices: { orderBy: { lastActiveAt: 'desc' }, take: 1, select: { publicKey: true, pqPublicKey: true, signingKey: true } } },
      take: 20
    })

    const mappedUsers = users.map(u => {
      const device = u.devices[0];
      return {
        id: u.id,
        encryptedProfile: u.encryptedProfile,
        isVerified: u.isVerified,
        publicKey: device?.publicKey ? Buffer.from(device.publicKey).toString('base64url') : undefined,
        pqPublicKey: device?.pqPublicKey ? Buffer.from(device.pqPublicKey).toString('base64url') : undefined,
        signingKey: device?.signingKey ? Buffer.from(device.signingKey).toString('base64url') : undefined
      };
    })

    res.json(mappedUsers)

  } catch (e) { next(e) }
})

// GET User Profile (Me)
router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { lastActiveAt: new Date() },
      select: { id: true, usernameHash: true, encryptedProfile: true, isVerified: true, hasCompletedOnboarding: true, role: true, autoDestructDays: true }
    })
    res.json(user)
  } catch (error) { next(error) }
})

// GET List Blocked (Me)
router.get('/me/blocked', async (req, res, next) => {
  try {
    const blocked = await prisma.blockedUser.findMany({
      where: { blockerId: req.user!.id },
      include: { blocked: { select: { id: true, encryptedProfile: true } } }
    })
    res.json(blocked.map(b => b.blocked))
  } catch (error) { next(error) }
})

router.get('/me/devices', requireAuth, async (req, res, next) => {
  try {
    const authUser = req.user as AuthJwtPayload;
    
    const devices = await prisma.device.findMany({
      where: { userId: authUser.id },
      orderBy: { lastActiveAt: 'desc' },
      select: { id: true, name: true, lastActiveAt: true, createdAt: true }
    });
    
    // Tandai perangkat mana yang sedang digunakan saat ini
    const mapped = devices.map(d => ({ 
        ...d, 
        isCurrent: d.id === authUser.deviceId 
    }));
    
    res.json(mapped);
  } catch (e) { 
      next(e); 
  }
});

// DELETE: Cabut akses (Logout) perangkat tertentu dari jarak jauh
router.delete('/me/devices/:deviceId', requireAuth, async (req, res, next) => {
  try {
    const authUser = req.user as AuthJwtPayload;
    const targetDeviceId = String(req.params.deviceId);

    if (targetDeviceId === authUser.deviceId) {
       throw new ApiError(400, "Cannot revoke the current device from here. Use the Logout button instead.");
    }

    // 1. Hapus device (Cascade akan menghapus PreKeys, SessionKeys, dll)
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

    res.json({ message: "Device access revoked successfully." });
  } catch (e) { 
      next(e); 
  }
});

// UPDATE User Profile (Me)
router.put('/me',
  zodValidate({
    body: z.object({
      encryptedProfile: z.string().min(1).optional(),
      autoDestructDays: z.number().int().min(1).nullable().optional()
    }).refine(data => data.encryptedProfile !== undefined || data.autoDestructDays !== undefined, { message: "Body cannot be empty" })
  }),
  async (req, res, next) => {
    try {
      const userId = req.user!.id
      const { encryptedProfile, autoDestructDays } = req.body
      const existingUser = await prisma.user.findUnique({ where: { id: userId }, select: { encryptedProfile: true } });

      const dataToUpdate: { encryptedProfile?: string; autoDestructDays?: number | null } = {};
      if (encryptedProfile !== undefined) dataToUpdate.encryptedProfile = encryptedProfile;
      if (autoDestructDays !== undefined) dataToUpdate.autoDestructDays = autoDestructDays;

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: dataToUpdate,
        select: { id: true, encryptedProfile: true, isVerified: true, hasCompletedOnboarding: true, autoDestructDays: true }
      })

      if (encryptedProfile !== undefined && (!existingUser || encryptedProfile !== existingUser.encryptedProfile)) {
        getIo().to(userId).emit('user:updated', { id: updatedUser.id as UserId, encryptedProfile: updatedUser.encryptedProfile })

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

        recipients.forEach(recipientId => {
          getIo().to(recipientId).emit('user:updated', { id: updatedUser.id as UserId, encryptedProfile: updatedUser.encryptedProfile })
        })
      }

      res.json(updatedUser)
    } catch (error) { next(error) }
  }
)

// UPDATE Public Keys (Me)
const base64UrlRegex = /^[A-Za-z0-9_-]+$/
router.put('/me/keys',
  zodValidate({
    body: z.object({
      publicKey: z.string().min(43).max(256).regex(base64UrlRegex, { message: 'Invalid public key format.' }),
      signingKey: z.string().min(43).max(256).regex(base64UrlRegex, { message: 'Invalid signing key format.' })
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      
      const authUser = req.user as AuthJwtPayload;
      const deviceId = authUser.deviceId;
      if (!deviceId) throw new ApiError(400, 'Device ID missing from session.')
        
      const userId = authUser.id
      const { publicKey, signingKey } = req.body

      // FIX 2: Konversi String Base64 dari Client menjadi Buffer untuk Prisma Bytes
      await prisma.device.update({
        where: { id: deviceId },
        data: {
            publicKey: Buffer.from(publicKey, 'base64url'),
            signingKey: Buffer.from(signingKey, 'base64url')
        }      })

      const conversations = await prisma.conversation.findMany({
        where: { participants: { some: { userId } } },
        include: { participants: { select: { userId: true } } }
      })

      const recipients = new Set<string>()
      conversations.forEach(c => c.participants.forEach(p => {
        if (p.userId !== userId) recipients.add(p.userId)
      }))

      recipients.forEach(recipientId => {
        getIo().to(recipientId).emit('user:identity_changed', { userId })
      })

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

// DELETE Account (Me)
router.delete('/me',
  zodValidate({
    body: z.object({
      password: z.string().min(1),
      fileKeys: z.array(z.string()).max(1000).optional() 
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const { password, fileKeys } = req.body
      const userId = req.user.id

      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) throw new ApiError(404, 'User not found')

      const isPasswordValid = await import('../utils/password.js').then(m => m.verifyPassword(password, user.passwordHash))
      if (!isPasswordValid) throw new ApiError(401, 'Invalid password. Account deletion aborted.')

      if (fileKeys && Array.isArray(fileKeys) && fileKeys.length > 0) {
         try {
             const validKeys = fileKeys.filter(key => {
                 if (typeof key !== 'string') return false;
                 const parts = key.split('/');
                 if (parts.length < 2) return false;
                 return parts[parts.length - 1].startsWith(`${userId}-`);
             });

             if (validKeys.length > 0) {
                 const { deleteR2Files } = await import('../utils/r2.js')
                 await deleteR2Files(validKeys)
             }
         } catch (e) { console.error("Failed to cleanup R2 files:", e) }
      }

      await prisma.user.delete({ where: { id: userId } })

      const { env } = await import('../config.js')
      const isProd = env.nodeEnv === 'production'
      const cookieOpts: CookieOptions = { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' }
      res.clearCookie('at', cookieOpts)
      res.clearCookie('rt', cookieOpts)

      res.json({ message: 'Account permanently deleted.' })
    } catch (error) { next(error) }
  }
)

// ========================================================
// 2. DYNAMIC ROUTES (Harus di bawah agar tidak menangkap /me)
// ========================================================

// GET Other User Profile by ID
router.get('/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, encryptedProfile: true, createdAt: true, isVerified: true, devices: { orderBy: { lastActiveAt: 'desc' }, take: 1, select: { publicKey: true, pqPublicKey: true, signingKey: true } } }
    })

    if (!user) return res.status(404).json({ error: 'User not found' })
    
    const device = user.devices[0];
    
    const mappedUser = {
        id: user.id,
        encryptedProfile: user.encryptedProfile,
        createdAt: user.createdAt,
        isVerified: user.isVerified,
        publicKey: device?.publicKey ? Buffer.from(device.publicKey).toString('base64url') : undefined,
        pqPublicKey: device?.pqPublicKey ? Buffer.from(device.pqPublicKey).toString('base64url') : undefined,
        signingKey: device?.signingKey ? Buffer.from(device.signingKey).toString('base64url') : undefined
    }
    
    res.json(mappedUser)
  } catch (error) { next(error) }
})

// BLOCK User
router.post('/:id/block', async (req, res, next) => {
  try {
    const blockerId = req.user!.id
    const blockedId = req.params.id
    if (blockerId === blockedId) throw new ApiError(400, 'You cannot block yourself')
    await prisma.blockedUser.create({ data: { blockerId, blockedId } })
    res.json({ success: true, message: 'User blocked' })
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as Record<string, unknown>).code === 'P2002') return res.json({ success: true, message: 'User already blocked' })
    next(error)
  }
})

// UNBLOCK User
router.delete('/:id/block', async (req, res, next) => {
  try {
    const blockerId = req.user!.id
    const blockedId = req.params.id
    await prisma.blockedUser.deleteMany({ where: { blockerId, blockedId } })
    res.json({ success: true, message: 'User unblocked' })
  } catch (error) { next(error) }
})

export default router