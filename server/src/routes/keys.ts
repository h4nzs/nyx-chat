import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'

const router: Router = Router()

// === POST: Upload/update a user's pre-key bundle ===
router.post(
  '/prekey-bundle',
  requireAuth,
  zodValidate({
    body: z.object({
      identityKey: z.string(),
      signingKey: z.string().optional(), // New: Accept signingKey update
      signedPreKey: z.object({
        key: z.string(),
        signature: z.string()
      })
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const userId = req.user.id
      const { identityKey, signedPreKey, signingKey } = req.body

      // Prepare user update data
      const userUpdateData: any = { publicKey: identityKey }
      if (signingKey) {
        userUpdateData.signingKey = signingKey
      }

      // Use a transaction to ensure both operations succeed or fail together
      await prisma.$transaction([
        prisma.preKeyBundle.upsert({
          where: { userId },
          update: {
            identityKey,
            key: signedPreKey.key,
            signature: signedPreKey.signature
          },
          create: {
            userId,
            identityKey,
            key: signedPreKey.key,
            signature: signedPreKey.signature
          }
        }),
        prisma.user.update({
          where: { id: userId },
          data: userUpdateData
        })
      ])

      res.status(201).json({ message: 'Pre-key bundle updated successfully.' })
    } catch (e) {
      next(e)
    }
  }
)

// === POST: Upload One-Time Pre-Keys (OTPK) ===
router.post(
  '/upload-otpk',
  requireAuth,
  zodValidate({
    body: z.object({
      keys: z.array(z.object({
        keyId: z.number(),
        publicKey: z.string()
      })).min(1).max(100)
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const userId = req.user.id
      const { keys } = req.body

      // Use createMany for efficiency
      // Note: If keyId conflict exists (unique constraint), this might fail.
      // We assume client manages keyIds correctly (e.g. rolling counter).
      await prisma.oneTimePreKey.createMany({
        data: keys.map(k => ({
          userId,
          keyId: k.keyId,
          publicKey: k.publicKey
        })),
        skipDuplicates: true // Ignore duplicates if client retries
      })

      res.status(201).json({ message: `Uploaded ${keys.length} One-Time Pre-Keys.` })
    } catch (e) {
      next(e)
    }
  }
)

// === GET: Count One-Time Pre-Keys ===
router.get('/count-otpk', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const count = await prisma.oneTimePreKey.count({
      where: { userId: req.user.id }
    })
    res.json({ count })
  } catch (e) {
    next(e)
  }
})

// === GET: Get a pre-key bundle for another user ===
router.get(
  '/prekey-bundle/:userId',
  requireAuth,
  zodValidate({ params: z.object({ userId: z.string().cuid() }) }),
  async (req, res, next) => {
    try {
      const { userId } = req.params

      // 1. Fetch User and Bundle
      const userWithBundle = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          signingKey: true,
          preKeyBundle: true
        }
      })

      if (!userWithBundle?.preKeyBundle || !userWithBundle.signingKey) {
        throw new Error('User does not have a valid pre-key bundle available.')
      }

      // 2. Atomic Pop: Fetch ONE OTPK and Delete it
      // Prisma doesn't support "DELETE RETURNING" directly in standard API easily for this logic without raw query or transaction.
      // We use a transaction: Find First -> Delete ID.
      
      const otpk = await prisma.$transaction(async (tx) => {
        const key = await tx.oneTimePreKey.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' }, // Use oldest first
          select: { id: true, keyId: true, publicKey: true }
        })

        if (key) {
          await tx.oneTimePreKey.delete({ where: { id: key.id } })
        }
        return key
      })

      const { preKeyBundle, signingKey } = userWithBundle

      // Assemble the response bundle
      const responseBundle: any = {
        identityKey: preKeyBundle.identityKey,
        signedPreKey: {
          key: preKeyBundle.key,
          signature: preKeyBundle.signature
        },
        signingKey // Include the public signing key for verification
      }

      // 3. Attach One-Time Pre-Key if available
      if (otpk) {
        responseBundle.oneTimePreKey = {
          keyId: otpk.keyId,
          key: otpk.publicKey
        }
      }

      res.json(responseBundle)
    } catch (e: any) {
      if (e.message.includes('pre-key bundle')) {
        return res.status(404).json({ error: e.message })
      }
      next(e)
    }
  }
)

// === GET: Get an initial session key record for a recipient ===
router.get(
  '/initial-session/:conversationId/:sessionId',
  requireAuth,
  zodValidate({
    params: z.object({
      conversationId: z.string(),
      sessionId: z.string()
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const { conversationId, sessionId } = req.params
      const userId = req.user.id

      const keyRecord = await prisma.sessionKey.findFirst({
        where: {
          conversationId,
          sessionId,
          userId
        }
      })

      if (!keyRecord || !keyRecord.initiatorEphemeralKey) {
        return res.status(404).json({ error: 'Initial session data not found for this user.' })
      }

      // Find the initiator to get their public identity key
      const initiatorRecord = await prisma.sessionKey.findFirst({
        where: {
          conversationId,
          sessionId,
          isInitiator: true
        },
        include: { user: { select: { id: true, publicKey: true } } }
      })

      if (!initiatorRecord?.user?.publicKey) {
        return res.status(404).json({ error: "Initiator's public key could not be found for this session." })
      }

      res.json({
        encryptedKey: keyRecord.encryptedKey,
        initiatorEphemeralKey: keyRecord.initiatorEphemeralKey,
        initiatorIdentityKey: initiatorRecord.user.publicKey
      })
    } catch (e) {
      next(e)
    }
  }
)

export default router
