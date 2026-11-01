import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { ApiError } from '../utils/errors.js'
import { relaySessionKeys } from '../utils/sessionKeys.js'
// [AUDIT PASS 3 — N3-01] Tanpa gerbang ini, siapa pun yang terautentikasi bisa
// menulis baris `SessionKey` (yang dipakai sebagai bukti peserta) untuk dirinya.
import { authorizeSessionKeyRelay, type SessionKeyRelayGuardDb } from '../utils/sessionKeyRelayGuard.js'

const router: Router = Router()
router.use(requireAuth)

// GET: Fetch session keys for a conversation and device
router.get('/:conversationId/devices/:deviceId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId, deviceId } = req.params

    // Verify device belongs to requester
    const device = await prisma.device.findFirst({
      where: { id: deviceId, userId: req.user.id }
    })

    if (!device) {
      throw new ApiError(403, 'Device not found or unauthorized.')
    }

    // Cari SessionKey berdasarkan deviceId
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

    res.json(formattedKeys)
  } catch (error) {
    next(error)
  }
})

// POST: Relay new session keys for a conversation (client-driven ratcheting)
router.post('/:conversationId/ratchet', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const { sessionId, keys } = req.body as { sessionId: unknown, keys: unknown }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true }
    })

    if (!conversation) {
      throw new ApiError(404, 'Conversation not found')
    }

    // [AUDIT PASS 3 — N3-01] Bukti peserta diperiksa SEBELUM menulis baris:
    // baris `SessionKey` adalah bukti keanggotaan di jalur lain, jadi menulisnya
    // tanpa bukti = mencetak keanggotaan palsu (hapus view-once orang lain,
    // typing ke id sembarang, presence korban). Bentuk payload juga divalidasi
    // di sini (cap 500, deviceId base64url, perangkat harus nyata).
    const decision = await authorizeSessionKeyRelay(
      prisma as unknown as SessionKeyRelayGuardDb,
      { conversationId, callerId: req.user.id, sessionId, keys },
    )
    if (!decision.ok) {
      throw new ApiError(decision.status, decision.error)
    }

    // Relay client-encrypted keys to the database
    await relaySessionKeys(conversationId, sessionId as string, decision.keys)

    res.status(201).json({
      ok: true,
      sessionId
    })
  } catch (error) {
    next(error)
  }
})

export default router
