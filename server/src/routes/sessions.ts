// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { emitEventToUser, sendJsonToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { ApiError } from '../utils/errors.js'
import { UAParser } from 'ua-parser-js'
import { verifyJwt } from '../utils/jwt.js'
import { getSodium } from '../lib/sodium.js'
import { redisClient } from '../lib/redis.js'

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
    const sodium = await getSodium();
    const currentIpHash = sodium.to_hex(sodium.crypto_generichash(32, Buffer.from(rawIp), null)).substring(0, 16);

    const parsedSessions = sessions.map(s => {
      const dbDevice = userDevices.find(d => d.id === s.deviceId);
      const ua = new UAParser(s.userAgent || '').getResult()
      const deviceInfo = `${ua.browser.name || 'Unknown'} on ${ua.os.name || 'Unknown'}`
      
      // Masking IP (hanya tampilkan jika hash IP cocok dengan session atau jika admin)
      const sessionIpHash = sodium.to_hex(sodium.crypto_generichash(32, Buffer.from(s.ipAddress || ''), null)).substring(0, 16);
      const displayIp = (sessionIpHash === currentIpHash) ? s.ipAddress : 'Hidden for privacy';

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

    // Validasi kepemilikan session
    const token = await prisma.refreshToken.findUnique({
      where: { jti: String(jti) },
      include: { device: { select: { userId: true } } }
    })

    if (!token || token.device?.userId !== userId) {
      throw new ApiError(404, 'Session not found or unauthorized')
    }

    // Mark as revoked in DB
    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() }
    })

    // Add to Redis blacklist (jti based)
    const expiresIn = Math.floor((new Date(token.expiresAt).getTime() - Date.now()) / 1000)
    try {
      if (expiresIn > 0) {
        await redisClient.setEx(`revoked_jti:${String(jti)}`, expiresIn, '1')
      }
    } catch (err) {
      console.error("[Session] Failed to set revoked flag in Redis:", err)
    }

    try {
      await emitEventToUser(userId, 'force_logout', { jti });
      await sendJsonToUser(userId, TransportOpCode.KICK, { deviceId: token.deviceId }, false, token.deviceId);
    } catch (err) {
      console.error("[Session] Failed to send KICK or force_logout:", err)
    }

    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
