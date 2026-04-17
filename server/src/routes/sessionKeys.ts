import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { rotateAndDistributeSessionKeys } from '../utils/sessionKeys.js'
import { ApiError } from '../utils/errors.js'

const router: Router = Router()
router.use(requireAuth)

// GET all encrypted session keys for a user's device in a conversation
router.get('/:conversationId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const { deviceId } = req.query

    // Kunci sesi sekarang spesifik per-perangkat (Multi-Device E2EE)
    if (!deviceId || typeof deviceId !== 'string') {
      throw new ApiError(400, 'deviceId query parameter is required.')
    }

    // Verifikasi kepemilikan perangkat untuk keamanan tambahan
    const device = await prisma.device.findFirst({
      where: { id: deviceId, userId: req.user.id }
    })

    if (!device) {
      throw new ApiError(403, 'Device not found or unauthorized.')
    }

    // Cari SessionKey berdasarkan deviceId, bukan userId
    const sessionKeys = await prisma.sessionKey.findMany({
      where: { conversationId, deviceId },
      select: { sessionId: true, encryptedKey: true },
      orderBy: { createdAt: 'asc' }
    })

    // Konversi Prisma Bytes (Buffer) kembali menjadi string Base64 untuk JSON response
    const formattedKeys = sessionKeys.map(sk => ({
      sessionId: sk.sessionId,
      encryptedKey: Buffer.from(sk.encryptedKey).toString('base64')
    }))

    res.json({ keys: formattedKeys })
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
      throw new ApiError(404, 'Conversation not found or you are not a participant.')
    }

    // Fungsi ini akan membuat SessionKey baru dan mendistribusikannya
    // ke semua device partisipan yang valid, lalu mengembalikan kunci 
    // dalam bentuk string Base64 untuk inisiator.
    const { sessionId, encryptedKey } = await rotateAndDistributeSessionKeys(conversationId, userId)

    if (!sessionId || !encryptedKey) {
      throw new ApiError(500, 'Failed to create and retrieve session key for initiator.')
    }

    res.status(201).json({
      sessionId,
      encryptedKey 
    })
  } catch (error) {
    next(error)
  }
})

export default router
