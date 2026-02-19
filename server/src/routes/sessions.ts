import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { ApiError } from '../utils/errors.js'
import { UAParser } from 'ua-parser-js'

const router: Router = Router()

// Get all active sessions for the current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const currentJti = req.cookies.rt ? req.jwtPayload?.jti : null
    const sessions = await prisma.refreshToken.findMany({
      where: {
        userId: req.user.id,
        revokedAt: null // Only show active sessions
      },
      orderBy: {
        lastUsedAt: 'desc'
      }
    })

    const parsedSessions = sessions.map(s => {
      const parser = new UAParser(s.userAgent || "")
      const browser = parser.getBrowser()
      const os = parser.getOS()
      const device = parser.getDevice()
      
      const deviceInfo = [
        device.vendor,
        device.model,
        os.name,
        browser.name
      ].filter(Boolean).join(' ') || 'Unknown Device'

      return {
        ...s,
        isCurrent: s.jti === currentJti,
        deviceInfo
      }
    })

    res.json({ sessions: parsedSessions })
  } catch (e) {
    next(e)
  }
})

// Revoke a specific session (remote logout)
router.delete('/:jti', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { jti } = req.params
    const userId = req.user.id

    // For security, ensure the token being revoked belongs to the user making the request
    const token = await prisma.refreshToken.findFirst({
      where: { jti, userId }
    })

    if (!token) {
      return res.status(404).json({ error: 'Session not found or you do not have permission to revoke it.' })
    }

    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() }
    })

    // Emit a force_logout event to the specific session if socket is available
    const socketServer = getIo()
    if (socketServer) {
      // We need a way to map jti to a socket id. This is a complex problem.
      // For now, we will broadcast to all sockets for this user.
      // A better solution would involve a mapping of jti -> socket.id in Redis or memory.
      socketServer.to(userId).emit('force_logout', { jti })
    }

    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
