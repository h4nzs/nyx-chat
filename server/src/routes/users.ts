import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'

const router: Router = Router()

// Middleware auth untuk semua route di file ini
router.use(requireAuth)

// GET User Profile (Me)
router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        description: true,
        showEmailToOthers: true,
        hasCompletedOnboarding: true
      }
    })
    res.json(user)
  } catch (error) {
    next(error)
  }
})

// UPDATE User Profile (Text & Avatar URL only)
router.put('/me',
  zodValidate({
    body: z.object({
      name: z.string().min(1).trim().optional(),
      description: z.string().max(200).trim().optional().nullable(),
      showEmailToOthers: z.boolean().optional(),
      avatarUrl: z.string().optional() // Menerima URL string (dari Supabase)
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')

      const { name, description, showEmailToOthers, avatarUrl } = req.body

      // Siapkan object update
      const dataToUpdate: {
        name?: string;
        description?: string | null;
        showEmailToOthers?: boolean;
        avatarUrl?: string;
      } = {}

      if (name) dataToUpdate.name = name
      if (description !== undefined) dataToUpdate.description = description
      if (showEmailToOthers !== undefined) dataToUpdate.showEmailToOthers = showEmailToOthers
      if (avatarUrl !== undefined) dataToUpdate.avatarUrl = avatarUrl

      if (Object.keys(dataToUpdate).length === 0) {
        return res.status(400).json({ error: 'No update data provided.' })
      }

      const updatedUser = await prisma.user.update({
        where: { id: req.user.id },
        data: dataToUpdate,
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          avatarUrl: true,
          description: true,
          showEmailToOthers: true,
          hasCompletedOnboarding: true
        }
      })

      // Hanya sertakan email jika pengguna mengizinkan tampilan email ke orang lain
      const userForBroadcast = {
        ...updatedUser,
        email: updatedUser.showEmailToOthers ? updatedUser.email : undefined
      }

      getIo().emit('user:updated', userForBroadcast)
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
        select: { id: true, name: true }
      })

      // Notify contacts about identity change
      const conversations = await prisma.conversation.findMany({
        where: { participants: { some: { userId } } },
        include: { participants: { select: { userId: true } } }
      })

      const recipients = new Set<string>()
      conversations.forEach(c => c.participants.forEach(p => {
        if (p.userId !== userId) recipients.add(p.userId)
      }))

      recipients.forEach(recipientId => {
        getIo().to(recipientId).emit('user:identity_changed', { userId: user.id, name: user.name })
      })

      res.status(200).json({ message: 'Keys updated successfully.' })
    } catch (error) {
      next(error)
    }
  }
)

// SEARCH Users
router.get('/search',
  zodValidate({ query: z.object({ q: z.string().min(1) }) }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const query = req.query.q as string
      const meId = req.user.id

      const users = await prisma.user.findMany({
        where: {
          AND: [
            { id: { not: meId } },
            {
              OR: [
                { username: { contains: query, mode: 'insensitive' } },
                { name: { contains: query, mode: 'insensitive' } }
              ]
            }
          ]
        },
        take: 10,
        select: { id: true, username: true, name: true, avatarUrl: true }
      })
      res.json(users)
    } catch (e) {
      next(e)
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
        username: true,
        name: true,
        avatarUrl: true,
        description: true,
        createdAt: true,
        publicKey: true,
        email: true,
        showEmailToOthers: true
      }
    })

    if (!user) return res.status(404).json({ error: 'User not found' })

    const publicProfile: Partial<typeof user> & { id: string } = {
      id: user.id,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      description: user.description,
      createdAt: user.createdAt,
      publicKey: user.publicKey
    }

    if (user.showEmailToOthers) {
      publicProfile.email = user.email
    }

    res.json(publicProfile)
  } catch (error) {
    next(error)
  }
}
)

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

// BLOCK USER
router.post('/:id/block', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const blockerId = req.user.id
    const blockedId = req.params.id

    if (blockerId === blockedId) {
      throw new ApiError(400, 'You cannot block yourself')
    }

    await prisma.blockedUser.create({
      data: {
        blockerId,
        blockedId
      }
    })

    res.json({ success: true, message: 'User blocked' })
  } catch (error: any) {
    // Handle unique constraint violation (kalau udah diblokir sebelumnya)
    if (error.code === 'P2002') {
      return res.json({ success: true, message: 'User already blocked' })
    }
    next(error)
  }
})

// UNBLOCK USER
router.delete('/:id/block', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const blockerId = req.user.id
    const blockedId = req.params.id

    await prisma.blockedUser.deleteMany({
      where: {
        blockerId,
        blockedId
      }
    })

    res.json({ success: true, message: 'User unblocked' })
  } catch (error) {
    next(error)
  }
})

// GET BLOCKED USERS LIST (buat list di settings)
router.get('/me/blocked', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const blocked = await prisma.blockedUser.findMany({
      where: { blockerId: req.user.id },
      include: {
        blocked: {
          select: { id: true, username: true, avatarUrl: true, name: true }
        }
      }
    })
    res.json(blocked.map(b => b.blocked))
  } catch (error) {
    next(error)
  }
})

// GET User by Email (for verification purposes) - AUTH REQUIRED
router.get('/by-email/:email', async (req, res, next) => {
  try {
    const { email } = req.params

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        isEmailVerified: true,
        showEmailToOthers: true
      }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const publicProfile: Partial<typeof user> & { id: string } = {
      id: user.id,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isEmailVerified: user.isEmailVerified
    }

    if (user.showEmailToOthers) {
      publicProfile.email = user.email
    }

    res.json(publicProfile)
  } catch (error) {
    next(error)
  }
})

// GET User by Username (for verification purposes) - AUTH REQUIRED
router.get('/by-username/:username', async (req, res, next) => {
  try {
    const { username } = req.params

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        avatarUrl: true,
        isEmailVerified: true,
        showEmailToOthers: true
      }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    const publicProfile: Partial<typeof user> & { id: string } = {
      id: user.id,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isEmailVerified: user.isEmailVerified
    }

    if (user.showEmailToOthers) {
      publicProfile.email = user.email
    }

    res.json(publicProfile)
  } catch (error) {
    next(error)
  }
})

export default router
