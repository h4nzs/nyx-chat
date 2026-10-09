// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { emitEventToUser, sendJsonToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { ApiError } from '../utils/errors.js'
import { verifyJwt } from '../utils/jwt.js'
import { redisClient } from '../lib/redis.js'
import { revokeFamily } from '../utils/sessionUtils.js'
// [docs/28 Tier 1.5] label perangkat tersimpan ter-seal.
import { openAtRest } from '../utils/atRestSecrets.js'

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
    // [docs/28 Tier 1.5] label perangkat ter-seal → dibuka untuk daftar sesi.
    const userDevices = await prisma.device.findMany({
      where: { userId: req.user.id },
      select: { id: true, nameSealed: true }
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

    // [docs/28 Tier 0 — D5] ipAddress & userAgent tidak lagi disimpan di
    // RefreshToken (hash IP tanpa kunci = enumerable; UA = fingerprint perangkat).
    // Label sesi diambil dari Device.name (di-set klien saat login) + flag isCurrent
    // dari JTI cookie — jadi server tidak perlu tahu IP/UA untuk menampilkan sesi.
    const parsedSessions = await Promise.all(sessions.map(async s => {
      const dbDevice = userDevices.find(d => d.id === s.deviceId);
      const deviceName = (await openAtRest(dbDevice?.nameSealed)) || 'Unknown Device';

      return {
        id: s.id, // Pastikan mengirim ID untuk keperluan key/revocation di frontend
        jti: s.jti,
        deviceId: s.deviceId,
        deviceName,
        ipAddress: 'Hidden for privacy',
        isCurrent: s.jti === currentJti,
        deviceInfo: deviceName,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt
      }
    }))

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

    // Revoke ALL tokens in this family (prevents reuse of rotated tokens)
    await prisma.refreshToken.updateMany({
      where: { familyId: token.familyId, revokedAt: null },
      data: { revokedAt: new Date() }
    });

    // Add all JTIs in this family to Redis blacklist
    const familyTokens = await prisma.refreshToken.findMany({
      where: { familyId: token.familyId },
      select: { jti: true, expiresAt: true }
    });
    for (const ft of familyTokens) {
      const expiresIn = Math.floor((new Date(ft.expiresAt).getTime() - Date.now()) / 1000);
      if (expiresIn > 0) {
        await redisClient.setEx(`revoked_jti:${ft.jti}`, expiresIn, '1').catch(() => {});
      }
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
