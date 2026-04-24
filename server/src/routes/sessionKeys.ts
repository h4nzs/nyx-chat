import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { relaySessionKeys, ClientSessionKeyPayload } from '../utils/sessionKeys.js'
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

    const isParticipant = await prisma.participant.findFirst({
      where: { conversationId, userId: req.user.id }
    })

    if (!isParticipant) {
      throw new ApiError(403, 'You are not a participant in this conversation.')
    }

    // Cari SessionKey berdasarkan deviceId, bukan userId
    const sessionKeys = await prisma.sessionKey.findMany({
      where: { conversationId, deviceId },
      select: { sessionId: true, encryptedKey: true, initiatorCiphertexts: true },
      orderBy: { createdAt: 'asc' }
    })

    // Konversi Prisma Bytes (Buffer) kembali menjadi string Base64 untuk JSON response
    const formattedKeys = sessionKeys.map(sk => ({
      sessionId: sk.sessionId,
      encryptedKey: Buffer.from(sk.encryptedKey).toString('base64url'),
      initiatorCiphertexts: sk.initiatorCiphertexts ? Buffer.from(sk.initiatorCiphertexts).toString('base64url') : null
    }))

    res.json({ keys: formattedKeys })
  } catch (error) {
    next(error)
  }
})

// POST: Relay new session keys for a conversation (client-driven ratcheting)
router.post('/:conversationId/ratchet', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const { sessionId, keys } = req.body as { sessionId: string, keys: ClientSessionKeyPayload[] }

    if (!sessionId || !keys || !Array.isArray(keys) || keys.length === 0) {
      throw new ApiError(400, 'sessionId and an array of encrypted keys are required.')
    }

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

    // Relay client-encrypted keys to the database
    await relaySessionKeys(conversationId, sessionId, keys)

    res.status(201).json({
      ok: true,
      sessionId
    })
  } catch (error) {
    next(error)
  }
})

export default router
