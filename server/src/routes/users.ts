import { Router, CookieOptions } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'
import { getIo } from '../socket.js'

const router = Router()

router.use(requireAuth)

// Cari User (Exact Match pada Blind Index)
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query
    if (!q || typeof q !== 'string') {
      return res.json([])
    }

    // q adalah usernameHash yang dikirim client

    // SANDBOX CHECK
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { isVerified: true } });
    const limit = user?.isVerified ? 20 : 3;

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: req.user!.id } },
          { usernameHash: q } // Blind Index Exact Match
        ]
      },
      select: {
        id: true,
        encryptedProfile: true,
        isVerified: true,
        publicKey: true
      },
      take: limit
    })

    res.json(users)
  } catch (e) {
    next(e)
  }
})

// GET User Profile (Me)
router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        encryptedProfile: true,
        isVerified: true,
        hasCompletedOnboarding: true,
        role: true
      }
    })
    res.json(user)
  } catch (error) {
    next(error)
  }
})

// UPDATE User Profile
router.put('/me',
  zodValidate({
    body: z.object({
      encryptedProfile: z.string().min(1)
    })
  }),
  async (req, res, next) => {
    try {
      const userId = req.user!.id
      const { encryptedProfile } = req.body

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { encryptedProfile },
        select: {
          id: true,
          encryptedProfile: true,
          isVerified: true,
          hasCompletedOnboarding: true
        }
      })

      // Notify the user themselves (all their active devices)
      getIo().to(userId).emit('user:updated', { id: updatedUser.id, encryptedProfile: updatedUser.encryptedProfile })

      // Notify contacts
      const conversations = await prisma.conversation.findMany({
        where: { participants: { some: { userId } } },
        include: { participants: { select: { userId: true } } }
      })

      const recipients = new Set<string>()
      conversations.forEach(c => c.participants.forEach(p => {
        if (p.userId !== userId) recipients.add(p.userId)
      }))

      recipients.forEach(recipientId => {
        getIo().to(recipientId).emit('user:updated', { id: updatedUser.id, encryptedProfile: updatedUser.encryptedProfile })
      })

      res.json(updatedUser)
    } catch (error) {
      next(error)
    }
  }
)

// UPDATE Public Keys (E2EE)
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
      const userId = req.user.id
      const { publicKey, signingKey } = req.body

      const user = await prisma.user.update({
        where: { id: userId },
        data: { publicKey, signingKey },
        select: { id: true }
      })

      // Notify contacts
      const conversations = await prisma.conversation.findMany({
        where: { participants: { some: { userId } } },
        include: { participants: { select: { userId: true } } }
      })

      const recipients = new Set<string>()
      conversations.forEach(c => c.participants.forEach(p => {
        if (p.userId !== userId) recipients.add(p.userId)
      }))

      recipients.forEach(recipientId => {
        getIo().to(recipientId).emit('user:identity_changed', { userId: user.id })
      })

      res.status(200).json({ message: 'Keys updated successfully.' })
    } catch (error) {
      next(error)
    }
  }
)

// GET Other User Profile by ID
router.get('/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        encryptedProfile: true,
        createdAt: true,
        publicKey: true,
        isVerified: true
      }
    })

    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json(user)
  } catch (error) {
    next(error)
  }
})

// COMPLETE Onboarding
router.post('/me/complete-onboarding', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    await prisma.user.update({
      where: { id: req.user.id },
      data: { hasCompletedOnboarding: true }
    })
    res.status(200).json({ success: true })
  } catch (error) {
    next(error)
  }
})

// BLOCK/UNBLOCK/LIST BLOCKED (Unchanged logic, just ensure imports are clean)
router.post('/:id/block', async (req, res, next) => {
  try {
    const blockerId = req.user!.id
    const blockedId = req.params.id
    if (blockerId === blockedId) throw new ApiError(400, 'You cannot block yourself')
    await prisma.blockedUser.create({ data: { blockerId, blockedId } })
    res.json({ success: true, message: 'User blocked' })
  } catch (error: any) {
    if (error.code === 'P2002') return res.json({ success: true, message: 'User already blocked' })
    next(error)
  }
})

router.delete('/:id/block', async (req, res, next) => {
  try {
    const blockerId = req.user!.id
    const blockedId = req.params.id
    await prisma.blockedUser.deleteMany({ where: { blockerId, blockedId } })
    res.json({ success: true, message: 'User unblocked' })
  } catch (error) { next(error) }
})

router.get('/me/blocked', async (req, res, next) => {
  try {
    const blocked = await prisma.blockedUser.findMany({
      where: { blockerId: req.user!.id },
      include: { blocked: { select: { id: true, encryptedProfile: true } } }
    })
    res.json(blocked.map(b => b.blocked))
  } catch (error) { next(error) }
})

// DELETE Account (Self-Destruct)
router.delete('/me',
  zodValidate({
    body: z.object({
      password: z.string().min(1),
      fileKeys: z.array(z.string()).optional() // Client provides keys to delete (Zero-Knowledge cleanup)
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const { password, fileKeys } = req.body
      const userId = req.user.id

      // 1. Re-verify Password (Security Check)
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) throw new ApiError(404, 'User not found')

      const isPasswordValid = await import('../utils/password.js').then(m => m.verifyPassword(password, user.passwordHash))
      if (!isPasswordValid) throw new ApiError(401, 'Invalid password. Account deletion aborted.')

      // 2. Cleanup Storage (R2)
      // Since we don't store file keys in DB, we rely on the client to tell us what to delete.
      if (fileKeys && Array.isArray(fileKeys) && fileKeys.length > 0) {
         try {
             // VALIDATION: Ensure the user is only deleting their OWN files.
             // Our R2 object keys always start with: `${targetFolder}/${userId}-...`
             const validKeys = fileKeys.filter(key => {
                 if (typeof key !== 'string') return false;
                 // Split by folder, e.g., "images/cl123456-abcdef.png" -> ["images", "cl123456-abcdef.png"]
                 const parts = key.split('/');
                 if (parts.length < 2) return false;
                 const filename = parts[parts.length - 1];
                 return filename.startsWith(`${userId}-`);
             });

             if (validKeys.length > 0) {
                 const { deleteR2Files } = await import('../utils/r2.js')
                 await deleteR2Files(validKeys)
             } else {
                 console.warn(`User ${userId} attempted to delete invalid or unauthorized R2 keys.`);
             }
         } catch (e) {
             console.error("Failed to cleanup R2 files:", e)
             // Continue deletion anyway
         }
      }

      // 3. Nuke Database
      await prisma.user.delete({ where: { id: userId } })

      // 4. Clear Cookies
      const { env } = await import('../config.js')
      const isProd = env.nodeEnv === 'production'
      const cookieOpts: CookieOptions = { 
          path: '/', 
          httpOnly: true, 
          secure: isProd, 
          sameSite: isProd ? 'none' : 'lax' 
      }
      res.clearCookie('at', cookieOpts)
      res.clearCookie('rt', cookieOpts)

      res.json({ message: 'Account permanently deleted.' })
    } catch (error) {
      next(error)
    }
  }
)

export default router
