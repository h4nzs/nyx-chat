import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { rotateAndDistributeSessionKeys } from '../utils/sessionKeys.js'
import { ApiError } from '../utils/errors.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'

const router: Router = Router()
router.use(requireAuth)

// GET all encrypted session keys for a user in a conversation
router.get('/:conversationId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const userId = req.user.id

    const sessionKeys = await prisma.sessionKey.findMany({
      where: { conversationId, userId },
      select: { sessionId: true, encryptedKey: true },
      orderBy: { createdAt: 'asc' }
    })

    // This endpoint is now primarily for fetching historical keys.
    // If no keys exist, it's not necessarily an error, the client can ratchet a new one.
    res.json({ keys: sessionKeys })
  } catch (error) {
    next(error)
  }
})

// POST: Force create a new session key for a conversation (ratcheting)
router.post('/:conversationId/ratchet', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const userId = req.user.id

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        participants: { some: { userId } }
      }
    })

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found or you are not a participant.' })
    }

    // This function now handles distribution to all participants and returns the key
    // specifically for the initiator.
    const { sessionId, encryptedKey } = await rotateAndDistributeSessionKeys(conversationId, userId)

    if (!sessionId || !encryptedKey) {
      return res.status(500).json({ error: 'Failed to create and retrieve session key for initiator.' })
    }

    // The key is already distributed to all members within rotateAndDistributeSessionKeys.
    // The client requesting the ratchet gets the key back directly in this response.
    // Other clients will get the new key when they next fetch messages or via a push.
    // The old proactive push logic is removed for simplicity and robustness.

    res.status(201).json({
      sessionId,
      encryptedKey
    })
  } catch (error) {
    next(error)
  }
})

export default router
