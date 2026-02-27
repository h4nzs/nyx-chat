import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { ApiError } from '../utils/errors.js'
import { UAParser } from 'ua-parser-js'
import { verifyJwt } from '../utils/jwt.js'
import crypto from 'crypto'

const router: Router = Router()

// Get all active sessions for the current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    
    let currentJti: string | null = null
    if (req.cookies.rt) {
      const payload = verifyJwt(req.cookies.rt)
      if (typeof payload === 'object' && payload?.jti) {
        currentJti = payload.jti
      }
    }

    const sessions = await prisma.refreshToken.findMany({
      where: {
        userId: req.user.id,
        revokedAt: null // Only show active sessions
      },
      orderBy: {
        lastUsedAt: 'desc'
      }
    })

    // Calculate hash of current requester's IP to match against DB
    const rawIp = req.ip || '';
    const currentIpHash = crypto.createHash('sha256').update(rawIp).digest('hex').substring(0, 16);

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

      // Check if this session is from the same IP as the current request
      let displayIp = s.ipAddress;
      if (s.ipAddress === currentIpHash) {
          // It's a match! Show the real IP.
          displayIp = rawIp;
          // Clean up IPv6 prefix if local
          if (displayIp === '::1') displayIp = '127.0.0.1';
          if (displayIp.startsWith('::ffff:')) displayIp = displayIp.replace('::ffff:', '');
      } else {
          // Mask the hash so it doesn't look scary/ugly
          displayIp = `HIDDEN (${s.ipAddress.substring(0, 6)}...)`;
      }

      return {
        ...s,
        ipAddress: displayIp,
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
