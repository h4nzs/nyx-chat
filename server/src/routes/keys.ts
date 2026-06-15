// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { requireAuth } from '../middleware/auth.js'
import { generalLimiter } from '../middleware/rateLimiter.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { ApiError } from '../utils/errors.js'
import { Buffer } from 'buffer'
import { redisClient } from '../lib/redis.js'
// ✅ Menggunakan AuthJwtPayload dari paket shared
import type { AuthJwtPayload, IDeviceTemplate, IPreKeyBundle } from '@nyx/shared'

const router: Router = Router()

const base64UrlRegex = /^[A-Za-z0-9_-]+$/;

router.post(
  '/prekey-bundle',
  requireAuth,
  zodValidate({
    body: z.object({
      identityKey: z.string().regex(base64UrlRegex, 'Invalid identity key format'),
      pqIdentityKey: z.string().regex(base64UrlRegex, 'Invalid pq identity key format'),
      signingKey: z.string().regex(base64UrlRegex, 'Invalid signing key format'),
      signedPreKey: z.object({
        key: z.string().regex(base64UrlRegex, 'Invalid pre-key format'),
        pqKey: z.string().regex(base64UrlRegex, 'Invalid pq pre-key format'),
        signature: z.string().regex(base64UrlRegex, 'Invalid signature format'),
        pqSignature: z.string().regex(base64UrlRegex, 'Invalid pq signature format')
      })
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.');
      
      const authUser = req.user as AuthJwtPayload;
      if (!authUser.deviceId) throw new ApiError(400, 'Device ID missing from session.');
      
      const deviceId = String(authUser.deviceId);
      const { identityKey, pqIdentityKey, signedPreKey, signingKey } = req.body;

      await prisma.$transaction(async (tx) => {
        // 1. Bersihkan sisa OTPK lama untuk mencegah "Identity Crisis"
        await tx.oneTimePreKey.deleteMany({
          where: { deviceId } 
        });

        // 2. Perbarui atau Buat Bundle Baru
        await tx.preKeyBundle.upsert({
          where: { deviceId },
          update: {
            identityKey: Buffer.from(identityKey, 'base64url'),
            pqIdentityKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null,
            key: Buffer.from(signedPreKey.key, 'base64url'),
            pqKey: signedPreKey.pqKey ? Buffer.from(signedPreKey.pqKey, 'base64url') : null,
            signature: Buffer.from(signedPreKey.signature, 'base64url'),
            pqSignature: signedPreKey.pqSignature ? Buffer.from(signedPreKey.pqSignature, 'base64url') : null
          },
          create: {
            deviceId,
            identityKey: Buffer.from(identityKey, 'base64url'),
            pqIdentityKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null,
            key: Buffer.from(signedPreKey.key, 'base64url'),
            pqKey: signedPreKey.pqKey ? Buffer.from(signedPreKey.pqKey, 'base64url') : null,
            signature: Buffer.from(signedPreKey.signature, 'base64url'),
            pqSignature: signedPreKey.pqSignature ? Buffer.from(signedPreKey.pqSignature, 'base64url') : null
          }
        });

        // 3. Perbarui Identitas Perangkat (Konversi aman dari base64 ke Buffer)
        await tx.device.update({
          where: { id: deviceId },
          data: {
            ...(identityKey !== undefined && { publicKey: Buffer.from(identityKey, 'base64url') }),
            ...(pqIdentityKey !== undefined && { pqPublicKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null }),
            ...(signingKey !== undefined && { signingKey: Buffer.from(signingKey, 'base64url') })
          }
        });
      });

      res.status(201).json({ message: 'Pre-key bundle updated successfully.' });

      // Invalidate Redis cache
      try {
        const userId = authUser.id;
        await redisClient.del(`cache:keys:bundle:${userId}`);
        await redisClient.del(`cache:keys:public:${userId}`);
      } catch (cacheError) {
        console.error('[Cache] Failed to invalidate bundle cache:', cacheError);
      }
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
        publicKey: z.string().regex(base64UrlRegex, 'Must be base64url'),
        pqPublicKey: z.string().regex(base64UrlRegex, 'Must be base64url').optional()
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
        data: keys.map((k: { keyId: number; publicKey: string; pqPublicKey?: string }) => ({
          deviceId,
          keyId: k.keyId,
          publicKey: Buffer.from(k.publicKey, 'base64url'),
          pqPublicKey: k.pqPublicKey ? Buffer.from(k.pqPublicKey, 'base64url') : null
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

      // 1. Try to get device template from Redis
      let deviceTemplate: IDeviceTemplate | null = null;
      const cacheKey = `cache:keys:bundle:${userId}`;

      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          deviceTemplate = JSON.parse(cached);
        }
      } catch (cacheError) {
        console.error('[Cache] Redis get error in prekey-bundle:', cacheError);
      }

      // 2. Fetch from DB if not in cache
      if (!deviceTemplate) {
        const devices = await prisma.device.findMany({
          where: { userId: String(userId) },
          include: { preKeyBundle: true },
          orderBy: { lastActiveAt: 'desc' },
          take: 1
        })

        if (devices.length === 0) {
          throw new ApiError(404, 'User does not have any active devices.')
        }

        const device = devices[0];
        if (!device.signingKey || !device.publicKey) {
          throw new ApiError(404, 'Device identity not fully initialized.');
        }

        deviceTemplate = {
          id: device.id,
          identityKey: Buffer.isBuffer(device.publicKey) || device.publicKey instanceof Uint8Array ? Buffer.from(device.publicKey).toString('base64url') : String(device.publicKey),
          pqIdentityKey: device.pqPublicKey ? Buffer.from(device.pqPublicKey).toString('base64url') : null,
          signingKey: Buffer.isBuffer(device.signingKey) || device.signingKey instanceof Uint8Array ? Buffer.from(device.signingKey).toString('base64url') : String(device.signingKey),
          signedPreKey: device.preKeyBundle ? {
            key: Buffer.isBuffer(device.preKeyBundle.key) || device.preKeyBundle.key instanceof Uint8Array ? Buffer.from(device.preKeyBundle.key).toString('base64url') : String(device.preKeyBundle.key),
            pqKey: device.preKeyBundle.pqKey ? (Buffer.isBuffer(device.preKeyBundle.pqKey) || device.preKeyBundle.pqKey instanceof Uint8Array ? Buffer.from(device.preKeyBundle.pqKey).toString('base64url') : String(device.preKeyBundle.pqKey)) : null,
            signature: Buffer.isBuffer(device.preKeyBundle.signature) || device.preKeyBundle.signature instanceof Uint8Array ? Buffer.from(device.preKeyBundle.signature).toString('base64url') : String(device.preKeyBundle.signature),
            pqSignature: device.preKeyBundle.pqSignature ? (Buffer.isBuffer(device.preKeyBundle.pqSignature) || device.preKeyBundle.pqSignature instanceof Uint8Array ? Buffer.from(device.preKeyBundle.pqSignature).toString('base64url') : String(device.preKeyBundle.pqSignature)) : null
          } : null
        };

        // Save to Redis
        try {
          await redisClient.set(cacheKey, JSON.stringify(deviceTemplate), { EX: 3600 });
        } catch (cacheError) {
          console.error('[Cache] Redis set error in prekey-bundle:', cacheError);
        }
      }

      // 3. Fetch and DELETE one OTPK from DB (Atomic)
      let otpk = null;
      try {
        otpk = await prisma.$queryRaw`
          DELETE FROM "OneTimePreKey"
          WHERE id = (
            SELECT id FROM "OneTimePreKey"
            WHERE "deviceId" = ${deviceTemplate.id}
            ORDER BY "createdAt" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING id, "keyId", "publicKey", "pqPublicKey"
        `.then((res: unknown) => (Array.isArray(res) && res.length > 0 ? res[0] : null) as { id: string; keyId: number; publicKey: unknown; pqPublicKey: string | null } | null);
      } catch (dbError) {
        console.error('[DB] Failed to consume OTPK:', dbError);
      }

      // 4. Combine and return
      const bundle: IPreKeyBundle = {
        deviceId: deviceTemplate.id,
        identityKey: deviceTemplate.identityKey,
        pqIdentityKey: deviceTemplate.pqIdentityKey,
        signingKey: deviceTemplate.signingKey,
        signedPreKey: deviceTemplate.signedPreKey
      };

      if (otpk) {
        bundle.oneTimePreKey = {
          keyId: otpk.keyId,
          key: Buffer.isBuffer(otpk.publicKey) || otpk.publicKey instanceof Uint8Array ? Buffer.from(otpk.publicKey).toString('base64url') : String(otpk.publicKey),
          pqKey: otpk.pqPublicKey ? (Buffer.isBuffer(otpk.pqPublicKey) || (otpk.pqPublicKey as unknown) instanceof Uint8Array ? Buffer.from(otpk.pqPublicKey as unknown as Uint8Array).toString('base64url') : String(otpk.pqPublicKey)) : null
        };
      }

      res.json(bundle);
    } catch (e: unknown) {
      next(e)
    }
  }
)

// === POST: Get ALL public keys for MULTIPLE users (Without consuming OTPK) ===
router.post(
  '/public-keys',
  requireAuth,
  generalLimiter,
  zodValidate({ body: z.object({ userIds: z.array(z.string().min(1)).max(50) }) }),
  async (req, res, next) => {
    try {
      const { userIds } = req.body;

      if (!userIds || userIds.length === 0) {
        return res.json({});
      }

      const responseMap = new Map<string, Record<string, unknown>[]>();
      const missingUserIds: string[] = [];

      // 1. Try to get from Redis first
      try {
        const cacheResults = await Promise.all(
          userIds.map((uid: string) => redisClient.get(`cache:keys:public:${uid}`))
        );

        for (let i = 0; i < userIds.length; i++) {
          const uid = userIds[i];
          const cached = cacheResults[i];
          if (cached) {
            responseMap.set(uid, JSON.parse(cached));
          } else {
            missingUserIds.push(uid);
          }
        }
      } catch (cacheError) {
        console.error('[Cache] Redis get error in public-keys:', cacheError);
        missingUserIds.push(...userIds);
      }

      // 2. Fetch missing from DB
      if (missingUserIds.length > 0) {
        const devices = await prisma.device.findMany({
          where: { userId: { in: missingUserIds } },
          select: { id: true, userId: true, publicKey: true, pqPublicKey: true, signingKey: true }
        });

        const dbResults = new Map<string, Record<string, unknown>[]>();
        for (const uid of missingUserIds) {
          dbResults.set(uid, []);
        }

        for (const device of devices) {
          if (!device.signingKey || !device.publicKey) continue;

          const bundle: Record<string, unknown> = {
            deviceId: device.id,
            identityKey: Buffer.isBuffer(device.publicKey) || device.publicKey instanceof Uint8Array ? Buffer.from(device.publicKey).toString('base64url') : String(device.publicKey),
            pqIdentityKey: device.pqPublicKey ? Buffer.from(device.pqPublicKey).toString('base64url') : null,
            signingKey: Buffer.isBuffer(device.signingKey) || device.signingKey instanceof Uint8Array ? Buffer.from(device.signingKey).toString('base64url') : String(device.signingKey)
          };

          const arr = dbResults.get(device.userId) || [];
          arr.push(bundle);
          dbResults.set(device.userId, arr);
        }

        // 3. Cache results in Redis and merge into responseMap
        try {
          await Promise.all(
            Array.from(dbResults.entries()).map(([uid, data]) => 
              redisClient.set(`cache:keys:public:${uid}`, JSON.stringify(data), { EX: 3600 }) // Cache for 1 hour
            )
          );
        } catch (cacheError) {
          console.error('[Cache] Redis set error in public-keys:', cacheError);
        }

        for (const [uid, data] of dbResults.entries()) {
          responseMap.set(uid, data);
        }
      }

      res.json(Object.fromEntries(responseMap));
    } catch (e) {
      next(e);
    }
  }
);

// === POST: Get ALL pre-key bundles for MULTIPLE users (Bulk Fetch) ===
router.post(
  '/prekey-bundles',
  requireAuth,
  generalLimiter,
  zodValidate({ body: z.object({ userIds: z.array(z.string().min(1)).max(50) }) }),
  async (req, res, next) => {
    try {
      const { userIds } = req.body

      if (!userIds || userIds.length === 0) {
        return res.json({});
      }

      const responseMap = new Map<string, Record<string, unknown>[]>();
      for (const uid of userIds) {
          responseMap.set(uid, []);
      }

      // 1. Try to get cached bundles from Redis first
      const missingUserIds: string[] = [];
      try {
        const cacheResults = await Promise.all(
          userIds.map((uid: string) => redisClient.get(`cache:keys:bundle:${uid}`))
        );

        for (let i = 0; i < userIds.length; i++) {
          const uid = userIds[i];
          const cached = cacheResults[i];
          if (cached) {
            // Redis stores deviceTemplate (one device per user usually for PQC)
            const template = JSON.parse(cached);
            responseMap.set(uid, [template]);
          } else {
            missingUserIds.push(uid);
          }
        }
      } catch (cacheError) {
        console.error('[Cache] Redis get error in prekey-bundles:', cacheError);
        missingUserIds.push(...userIds);
      }

      // 2. Fetch missing from DB
      if (missingUserIds.length > 0) {
        const devices = await prisma.device.findMany({
          where: { userId: { in: missingUserIds } },
          include: { preKeyBundle: true }
        });

        for (const device of devices) {
          if (!device.signingKey || !device.publicKey) continue;

          const template = {
            id: device.id,
            identityKey: Buffer.isBuffer(device.publicKey) || device.publicKey instanceof Uint8Array ? Buffer.from(device.publicKey).toString('base64url') : String(device.publicKey),
            pqIdentityKey: device.pqPublicKey ? Buffer.from(device.pqPublicKey).toString('base64url') : null,
            signingKey: Buffer.isBuffer(device.signingKey) || device.signingKey instanceof Uint8Array ? Buffer.from(device.signingKey).toString('base64url') : String(device.signingKey),
            signedPreKey: device.preKeyBundle ? {
              key: Buffer.isBuffer(device.preKeyBundle.key) || device.preKeyBundle.key instanceof Uint8Array ? Buffer.from(device.preKeyBundle.key).toString('base64url') : String(device.preKeyBundle.key),
              pqKey: device.preKeyBundle.pqKey ? (Buffer.isBuffer(device.preKeyBundle.pqKey) || device.preKeyBundle.pqKey instanceof Uint8Array ? Buffer.from(device.preKeyBundle.pqKey).toString('base64url') : String(device.preKeyBundle.pqKey)) : null,
              signature: Buffer.isBuffer(device.preKeyBundle.signature) || device.preKeyBundle.signature instanceof Uint8Array ? Buffer.from(device.preKeyBundle.signature).toString('base64url') : String(device.preKeyBundle.signature),
              pqSignature: device.preKeyBundle.pqSignature ? (Buffer.isBuffer(device.preKeyBundle.pqSignature) || device.preKeyBundle.pqSignature instanceof Uint8Array ? Buffer.from(device.preKeyBundle.pqSignature).toString('base64url') : String(device.preKeyBundle.pqSignature)) : null
            } : null
          };

          // Cache individually
          await redisClient.set(`cache:keys:bundle:${device.userId}`, JSON.stringify(template), { EX: 3600 });
          
          const arr = responseMap.get(device.userId) || [];
          arr.push(template);
          responseMap.set(device.userId, arr);
        }
      }

      // 3. ATOMICALLY consume OTPKs for each device (Must ALWAYS come from DB)
      const finalResults = new Map<string, IPreKeyBundle[]>();
      for (const [uid, templates] of responseMap.entries()) {
          const userBundles: IPreKeyBundle[] = [];
          
          for (const template of templates as unknown as IDeviceTemplate[]) {
            let otpk = null;
            try {
              otpk = await prisma.$queryRaw`
                DELETE FROM "OneTimePreKey"
                WHERE id = (
                  SELECT id FROM "OneTimePreKey"
                  WHERE "deviceId" = ${template.id}
                  ORDER BY "createdAt" ASC
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
                )
                RETURNING id, "keyId", "publicKey", "pqPublicKey"
              `.then((res: unknown) => (Array.isArray(res) && res.length > 0 ? res[0] : null) as { id: string; keyId: number; publicKey: unknown; pqPublicKey: string | null } | null);
            } catch (e) {}

            const bundle: IPreKeyBundle = {
              deviceId: template.id,
              identityKey: template.identityKey,
              pqIdentityKey: template.pqIdentityKey,
              signingKey: template.signingKey,
              signedPreKey: template.signedPreKey
            };

            if (otpk) {
              bundle.oneTimePreKey = {
                keyId: otpk.keyId,
                key: Buffer.isBuffer(otpk.publicKey) || otpk.publicKey instanceof Uint8Array ? Buffer.from(otpk.publicKey).toString('base64url') : String(otpk.publicKey),
                pqKey: otpk.pqPublicKey ? (Buffer.isBuffer(otpk.pqPublicKey) || (otpk.pqPublicKey as unknown) instanceof Uint8Array ? Buffer.from(otpk.pqPublicKey as unknown as Uint8Array).toString('base64url') : String(otpk.pqPublicKey)) : null
              };
            }
            userBundles.push(bundle);
          }
          finalResults.set(uid, userBundles);
      }

      res.json(Object.fromEntries(finalResults))
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

      if (!keyRecord || !keyRecord.initiatorCiphertexts) {
        return res.status(404).json({ error: 'Initial session data not found for this device.' })
      }

      const initiatorRecord = await prisma.sessionKey.findFirst({
        where: { conversationId, sessionId, isInitiator: true },
        include: { device: { select: { id: true, publicKey: true, signingKey: true } } }
      })

      if (!initiatorRecord?.device?.publicKey) {
        return res.status(404).json({ error: "Initiator's public key could not be found." })
      }

      if (!initiatorRecord.device.signingKey) {
        return res.status(404).json({ error: "Initiator's signing key could not be found." })
      }

      res.json({
        // FIX 5: Konversi encryptedKey ke Base64
        encryptedKey: Buffer.isBuffer(keyRecord.encryptedKey) || keyRecord.encryptedKey instanceof Uint8Array ? Buffer.from(keyRecord.encryptedKey).toString('base64url') : String(keyRecord.encryptedKey),
        initiatorCiphertextsStr: Buffer.from(keyRecord.initiatorCiphertexts!).toString('base64url'),
        initiatorSigningKey: Buffer.from(initiatorRecord.device.signingKey).toString('base64url')
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