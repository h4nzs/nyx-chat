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
// [docs/30 WS-G(4)] Logika revokasi sesi dipindah ke util teruji (fake Prisma).
import { revokeSessionFamily, type SessionRevocationDb } from '../utils/sessionRevocation.js'

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

    // [docs/30 WS-G(4)] Validasi kepemilikan + revokasi seluruh family + isi
    // blacklist JTI dikerjakan util yang diuji perilakunya (`sessionRevocation`).
    const revocation = await revokeSessionFamily(
      prisma as unknown as SessionRevocationDb,
      { jti: String(jti), userId },
      async (tokenJti, ttlSeconds) => {
        await redisClient.setEx(`revoked_jti:${tokenJti}`, ttlSeconds, '1').catch(() => {});
      }
    );

    try {
      // [BUGFIX 2026-10-18] Sertakan deviceId DAN targetkan hanya device itu.
      // Dulu `force_logout` tanpa deviceId dikirim ke semua socket milik user →
      // mencabut satu sesi me-logout seluruh perangkat.
      await emitEventToUser(
        userId,
        'force_logout',
        { jti, deviceId: revocation.deviceId },
        revocation.deviceId ?? undefined,
      );
      await sendJsonToUser(userId, TransportOpCode.KICK, { deviceId: revocation.deviceId }, false, revocation.deviceId ?? undefined);
    } catch (err) {
      console.error("[Session] Failed to send KICK or force_logout:", err)
    }

    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
