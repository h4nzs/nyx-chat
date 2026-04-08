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

const base64UrlRegex = /^[A-Za-z0-9_-]+$/;

router.post(
  '/prekey-bundle',
  requireAuth,
  zodValidate({
    body: z.object({
      // ✅ FIX 1: Validasi ketat untuk memastikan input benar-benar format kunci kriptografi
      identityKey: z.string().regex(base64UrlRegex, 'Invalid identity key format'),
      signingKey: z.string().regex(base64UrlRegex, 'Invalid signing key format').optional(),
      signedPreKey: z.object({
        key: z.string().regex(base64UrlRegex, 'Invalid pre-key format'),
        signature: z.string().regex(base64UrlRegex, 'Invalid signature format')
      })
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.');
      
      const authUser = req.user as AuthJwtPayload;
      if (!authUser.deviceId) throw new ApiError(400, 'Device ID missing from session.');
      
      const deviceId = String(authUser.deviceId);
      const { identityKey, signedPreKey, signingKey } = req.body;

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

        // 3. Perbarui Identitas Perangkat
        await tx.device.update({
          where: { id: deviceId },
          data: {
            publicKey: identityKey,
            // ✅ FIX 2: Prisma sangat pintar. Jika `signingKey` bernilai `undefined`, 
            // Prisma TIDAK AKAN mengupdatenya (tidak mengubahnya jadi null). 
            // Ini jauh lebih bersih daripada trik spread operator sebelumnya.
            signingKey: signingKey 
          }
        });
      });

      res.status(201).json({ message: 'Pre-key bundle updated successfully.' });
    } catch (e) {
      next(e);
    }
  }
);

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
          if (!device.signingKey || !device.publicKey) return null;

          let otpk = null;
          if (device.preKeyBundle) {
              otpk = await prisma.$queryRaw`
                DELETE FROM "OneTimePreKey" 
                WHERE id = (
                  SELECT id FROM "OneTimePreKey" 
                  WHERE "deviceId" = ${device.id} 
                  ORDER BY "createdAt" ASC 
                  LIMIT 1
                )
                RETURNING id, "keyId", "publicKey"
              `.then((res: unknown) => (Array.isArray(res) && res.length > 0 ? res[0] : null) as { id: string; keyId: number; publicKey: string } | null);
          }

          const bundle: Record<string, unknown> = {
            deviceId: device.id,
            identityKey: device.publicKey,
            signingKey: device.signingKey
          }

          if (device.preKeyBundle) {
              bundle.signedPreKey = {
                key: device.preKeyBundle.key,
                signature: device.preKeyBundle.signature
              };
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
  // ✅ FIX 1: Hapus .cuid() untuk mencegah error jika format ID user berbeda
  zodValidate({ body: z.object({ userIds: z.array(z.string()) }) }),
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

      // ✅ FIX 2: Gunakan Map() untuk mencegah Prototype Pollution (CodeQL Warning)
      const responseMap = new Map<string, Record<string, unknown>[]>();
      for (const uid of userIds) {
          responseMap.set(uid, []);
      }

      if (devices.length === 0) {
        return res.json(Object.fromEntries(responseMap));
      }

      // ✅ FIX 3: Gunakan perulangan For-Of sekuensial alih-alih Promise.all()
      // Ini MENCEGAH server crash (Error 500) akibat kehabisan koneksi Prisma Transaction.
      for (const device of devices) {
          if (!device.signingKey || !device.publicKey) continue;

          let otpk = null;
          if (device.preKeyBundle) {
              otpk = await prisma.$queryRaw`
                DELETE FROM "OneTimePreKey" 
                WHERE id = (
                  SELECT id FROM "OneTimePreKey" 
                  WHERE "deviceId" = ${device.id} 
                  ORDER BY "createdAt" ASC 
                  LIMIT 1
                )
                RETURNING id, "keyId", "publicKey"
              `.then((res: unknown) => (Array.isArray(res) && res.length > 0 ? res[0] : null) as { id: string; keyId: number; publicKey: string } | null);
          }

          const bundle: Record<string, unknown> = {
            deviceId: device.id,
            identityKey: device.publicKey,
            signingKey: device.signingKey
          }

          if (device.preKeyBundle) {
              bundle.signedPreKey = {
                key: device.preKeyBundle.key,
                signature: device.preKeyBundle.signature
              };
          }

          if (otpk) {
            bundle.oneTimePreKey = {
              keyId: otpk.keyId,
              key: otpk.publicKey
            }
          }
          
          // Masukkan bundle ke dalam array milik user yang sesuai di dalam Map
          const userBundles = responseMap.get(device.userId);
          if (userBundles) {
              userBundles.push(bundle);
          }
      }

      // Konversi Map kembali menjadi Object biasa agar bisa dikirim sebagai JSON
      res.json(Object.fromEntries(responseMap))
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