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
    try {
      const payload = verifyJwt(String(req.cookies?.rt || ''))
      if (payload && typeof payload === 'object' && 'jti' in payload && typeof payload.jti === 'string') {
        currentJti = payload.jti
      }
    } catch (_e) {
      // Invalid or empty token, ignore safely
    }

    // FIX 1: Cari device milik user dulu, karena RefreshToken sekarang terikat ke Device, bukan User
    const userDevices = await prisma.device.findMany({
      where: { userId: req.user.id },
      select: { id: true, name: true }
    });

    const deviceIds = userDevices.map(d => d.id);

    const sessions = await prisma.refreshToken.findMany({
      where: {
        deviceId: { in: deviceIds }, // Cari token yang deviceId-nya ada di daftar device milik user
        revokedAt: null // Only show active sessions
      },
      orderBy: {
        lastUsedAt: 'desc'
      }
    })

    const rawIp = req.ip || '';
    const currentIpHash = crypto.createHash('sha256').update(rawIp).digest('hex').substring(0, 16);

    const parsedSessions = sessions.map(s => {
      const parser = new UAParser(s.userAgent || "")
      const browser = parser.getBrowser()
      const os = parser.getOS()
      const parsedDevice = parser.getDevice()

      const deviceInfo = [
        parsedDevice.vendor,
        parsedDevice.model,
        os.name,
        browser.name
      ].filter(Boolean).join(' ') || 'Unknown Device'

      let displayIp = s.ipAddress;
      if (s.ipAddress === currentIpHash) {
          displayIp = rawIp;
          if (displayIp === '::1') displayIp = '127.0.0.1';
          if (displayIp.startsWith('::ffff:')) displayIp = displayIp.replace('::ffff:', '');
      } else {
          if (s.ipAddress) {
             displayIp = `HIDDEN (${s.ipAddress.substring(0, 6)}...)`;
          } else {
             displayIp = 'UNKNOWN';
          }
      }

      // Ambil nama device dari database jika ada
      const dbDevice = userDevices.find(d => d.id === s.deviceId);

      return {
        id: s.id, // Pastikan mengirim ID untuk keperluan key/revocation di frontend
        jti: s.jti,
        deviceId: s.deviceId,
        deviceName: dbDevice?.name || 'Unknown Device', // Tambahkan nama device
        ipAddress: displayIp,
        isCurrent: s.jti === currentJti,
        deviceInfo,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt
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

    // FIX 2: Verifikasi kepemilikan melalui Device
    const userDevices = await prisma.device.findMany({
      where: { userId },
      select: { id: true }
    });
    const deviceIds = userDevices.map(d => d.id);

    const token = await prisma.refreshToken.findFirst({
      where: { 
        jti: jti as string, 
        deviceId: { in: deviceIds } // Pastikan token milik salah satu device user
      }
    })

    if (!token) {
      return res.status(404).json({ error: 'Session not found or you do not have permission to revoke it.' })
    }

    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() }
    })

    const socketServer = getIo()
    if (socketServer) {
      socketServer.to(userId).emit('force_logout', { jti: jti as string })
    }

    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
