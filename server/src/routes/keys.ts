// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { requireAuth } from '../middleware/auth.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'
// ✅ FIX: Menggunakan AuthJwtPayload dari paket shared
import type { AuthJwtPayload } from '@nyx/shared'

const router: Router = Router()

// === POST: Upload/update a device's pre-key bundle ===
router.post(
  '/prekey-bundle',
  requireAuth,
  zodValidate({
    body: z.object({
      identityKey: z.string(),
      signingKey: z.string().optional(),
      signedPreKey: z.object({
        key: z.string(),
        signature: z.string()
      })
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      
      const authUser = req.user as AuthJwtPayload;
      if (!authUser.deviceId) throw new ApiError(400, 'Device ID missing from session.')
      
      // Pastikan deviceId murni string
      const deviceId = String(authUser.deviceId);

      const { identityKey, signedPreKey, signingKey } = req.body

      // ✅ FIX: Gunakan Interactive Transaction agar lebih kebal dari deadlock
      await prisma.$transaction(async (tx) => {
        // 1. Bersihkan sisa OTPK lama untuk mencegah "Identity Crisis"
        await tx.oneTimePreKey.deleteMany({
          where: { deviceId } 
        });

        // 2. Perbarui atau Buat Bundle Baru
        await tx.preKeyBundle.upsert({
          where: { deviceId },
          update: {
            identityKey,
            key: signedPreKey.key,
            signature: signedPreKey.signature
          },
          create: {
            deviceId,
            identityKey,
            key: signedPreKey.key,
            signature: signedPreKey.signature
          }
        });

        // 3. Perbarui Identitas Perangkat (Conditional Update yang bersih)
        await tx.device.update({
          where: { id: deviceId },
          data: {
            publicKey: identityKey,
            ...(signingKey && { signingKey }) // Menyisipkan signingKey hanya jika ada nilainya
          }
        });
      });

      res.status(201).json({ message: 'Pre-key bundle updated successfully.' })
    } catch (e) {
      next(e)
    }
  }
)

// === POST: Upload One-Time Pre-Keys (OTPK) ===
router.post(
  '/upload-otpk',
  requireAuth,
  zodValidate({
    body: z.object({
      keys: z.array(z.object({
        keyId: z.number(),
        publicKey: z.string()
      })).min(1).max(100)
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      const authUser = req.user as AuthJwtPayload;
      const deviceId = authUser.deviceId;
      if (!deviceId) throw new ApiError(400, 'Device ID missing from session.')

      const { keys } = req.body;

      await prisma.oneTimePreKey.createMany({
        data: keys.map((k: { keyId: number; publicKey: string }) => ({
          deviceId,
          keyId: k.keyId,
          publicKey: k.publicKey
        })),
        skipDuplicates: true
      })

      res.status(201).json({ message: `Uploaded ${keys.length} One-Time Pre-Keys.` })
    } catch (e) {
      next(e)
    }
  }
)

// === GET: Count OTPK ===
router.get('/count-otpk', requireAuth, async (req, res, next) => {
  try {
    const authUser = req.user as AuthJwtPayload;
    const deviceId = authUser.deviceId;
    if (!deviceId) throw new ApiError(400, 'Device ID missing from session.')

    const count = await prisma.oneTimePreKey.count({ where: { deviceId } })
    res.json({ count })
  } catch (e) { next(e) }
})

// === DELETE: Clear OTPK ===
router.delete('/otpk', requireAuth, async (req, res, next) => {
  try {
    const authUser = req.user as AuthJwtPayload;
    const deviceId = authUser.deviceId;
    if (!deviceId) throw new ApiError(400, 'Device ID missing from session.')

    await prisma.oneTimePreKey.deleteMany({ where: { deviceId } })
    res.status(204).send()
  } catch (e) { next(e) }
})

// === GET: Get ALL pre-key bundles for another user ===
router.get(
  '/prekey-bundle/:userId',
  requireAuth,
  zodValidate({ params: z.object({ userId: z.string().cuid() }) }),
  async (req, res, next) => {
    try {
      const { userId } = req.params

      const devices = await prisma.device.findMany({
        where: { userId: String(userId) },
        include: { preKeyBundle: true }
      })

      if (devices.length === 0) {
        throw new ApiError(404, 'User does not have any active devices.')
      }

      const responseBundles = await Promise.all(devices.map(async (device) => {
          if (!device.preKeyBundle || !device.signingKey) return null;

          const otpk = await prisma.$transaction(async (tx) => {
            const key = await tx.oneTimePreKey.findFirst({
              where: { deviceId: device.id },
              orderBy: { createdAt: 'asc' },
              select: { id: true, keyId: true, publicKey: true }
            })
            if (key) await tx.oneTimePreKey.delete({ where: { id: key.id } })
            return key
          })

          const bundle: Record<string, unknown> = {
            deviceId: device.id,
            identityKey: device.preKeyBundle.identityKey,
            signedPreKey: {
              key: device.preKeyBundle.key,
              signature: device.preKeyBundle.signature
            },
            signingKey: device.signingKey
          }

          if (otpk) {
            bundle.oneTimePreKey = {
              keyId: otpk.keyId,
              key: otpk.publicKey
            }
          }
          return bundle;
      }));

      const validBundles = responseBundles.filter(b => b !== null);
      if (validBundles.length === 0) throw new ApiError(404, 'No valid key bundles found for this user.');

      res.json(validBundles)
    } catch (e: unknown) {
      next(e)
    }
  }
)

// === POST: Get ALL pre-key bundles for MULTIPLE users (Bulk Fetch) ===
router.post(
  '/prekey-bundles',
  requireAuth,
  zodValidate({ body: z.object({ userIds: z.array(z.string().cuid()) }) }),
  async (req, res, next) => {
    try {
      const { userIds } = req.body

      if (!userIds || userIds.length === 0) {
        return res.json({});
      }

      // Fetch devices for all requested users in one query
      const devices = await prisma.device.findMany({
        where: { userId: { in: userIds } },
        include: { preKeyBundle: true }
      })

      if (devices.length === 0) {
        return res.json({});
      }

      // Group devices by userId to form the response map
      const responseMap: Record<string, Record<string, unknown>[]> = {};
      for (const uid of userIds) {
          responseMap[uid] = [];
      }

      // Process devices: we still need to atomically pop OTPKs per device.
      // This is a mapping over devices, which is generally fast in parallel.
      const processedBundles = await Promise.all(devices.map(async (device) => {
          if (!device.preKeyBundle || !device.signingKey) return null;

          const otpk = await prisma.$transaction(async (tx) => {
            const key = await tx.oneTimePreKey.findFirst({
              where: { deviceId: device.id },
              orderBy: { createdAt: 'asc' },
              select: { id: true, keyId: true, publicKey: true }
            })
            if (key) await tx.oneTimePreKey.delete({ where: { id: key.id } })
            return key
          })

          const bundle: Record<string, unknown> = {
            deviceId: device.id,
            identityKey: device.preKeyBundle.identityKey,
            signedPreKey: {
              key: device.preKeyBundle.key,
              signature: device.preKeyBundle.signature
            },
            signingKey: device.signingKey
          }

          if (otpk) {
            bundle.oneTimePreKey = {
              keyId: otpk.keyId,
              key: otpk.publicKey
            }
          }
          return { userId: device.userId, bundle };
      }));

      // Populate response map
      for (const result of processedBundles) {
          if (result) {
              responseMap[result.userId].push(result.bundle);
          }
      }

      res.json(responseMap)
    } catch (e: unknown) {
      next(e)
    }
  }
)

// === GET: Get an initial session key record for a recipient ===
router.get(
  '/initial-session/:conversationId/:sessionId',
  requireAuth,
  zodValidate({ params: z.object({ conversationId: z.string(), sessionId: z.string() }) }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.')
      
      const authUser = req.user as AuthJwtPayload;
      const deviceId = authUser.deviceId;
      if (!deviceId) throw new ApiError(400, 'Device ID missing from session.')

      const conversationId = String(req.params.conversationId);
      const sessionId = String(req.params.sessionId);

      const keyRecord = await prisma.sessionKey.findFirst({
        where: { conversationId, sessionId, deviceId }
      })

      if (!keyRecord || !keyRecord.initiatorEphemeralKey) {
        return res.status(404).json({ error: 'Initial session data not found for this device.' })
      }

      const initiatorRecord = await prisma.sessionKey.findFirst({
        where: { conversationId, sessionId, isInitiator: true },
        include: { device: { select: { id: true, publicKey: true } } }
      })

      if (!initiatorRecord?.device?.publicKey) {
        return res.status(404).json({ error: "Initiator's public key could not be found." })
      }

      res.json({
        encryptedKey: keyRecord.encryptedKey,
        initiatorEphemeralKey: keyRecord.initiatorEphemeralKey,
        initiatorIdentityKey: initiatorRecord.device.publicKey
      })
    } catch (e) { next(e) }
  }
)

interface TurnResponse {
  iceServers?: Array<{ urls: string; username?: string; credential?: string }>;
}

router.get('/turn', requireAuth, async (req, res): Promise<unknown> => {
  try {
    const { env } = await import('../config.js');
    if (!env.cfAccountId || !env.cfTurnKeyId || !env.cfTurnApiToken) {
      return res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    }

    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.cfTurnKeyId}/credentials/generate-ice-servers`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.cfTurnApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 86400 })
    });

    const data = await response.json() as unknown as TurnResponse;

    if (data.iceServers) {
      return res.json({ iceServers: data.iceServers });
    }

    return res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  } catch (error) {
    console.error('[TURN] Failed to fetch credentials:', error);
    return res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  }
});

export default router