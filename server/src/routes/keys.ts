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
// [docs/28 Tier 1.5 / D14] key cache Redis memakai tag, bukan userId asli.
import { identityKey, identityTag } from '../utils/redisIdentity.js'
// [docs/30 §30.5 WS-A] Rotasi kunci identitas → entri log KT (verifikasi kepemilikan identifier).
import { identityKeysChanged, publishIdentityKeyChange } from '../utils/ktIdentityLog.js'
// [docs/30 §30.9 WS-E(1)] coturn self-host: kredensial TURN time-limited (HMAC).
import {
  buildTurnIceServers,
  isCoturnConfigured,
  mintTurnCredential,
  parseTurnUrls,
  type TurnIceServer,
} from '../utils/turnCredentials.js'
// ✅ Menggunakan AuthJwtPayload dari paket shared
import type { AuthJwtPayload, IDeviceTemplate, IPreKeyBundle } from '@nyx/shared'
import { makeOtpkQuotaGate } from '../utils/otpkQuota.js'
import { validateEncryptedPrivateKeysPayload, toEncryptedPrivateKeyPatch } from '../utils/encryptedKeysSync.js'
// [docs/30 WS-G(4)] Pemetaan perangkat → bundle dipakai di 3 jalur; satu util teruji.
import {
  parseOtpkMode,
  requireBundleDevice,
  toDeviceTemplate,
  toPreKeyBundle,
  toPublicDeviceBundle,
  type OneTimePreKeyRow,
} from '../utils/keyBundle.js'
// [docs/35 Fase 1.3] Bundle v2: verifikasi tanda tangan ML-DSA-65 atas material kunci.
import {
  buildBundleV2Message,
  BUNDLE_V2_FIELD_LENGTHS,
  CRYPTO_VERSION_V2,
  ML_DSA_65_SIGNATURE_BYTES,
  PQ_V2_DOMAINS,
} from '@nyx/shared'
import { verifyMlDsaSignature } from '../utils/mlDsa.js'

// === Kuota harian konsumsi OTPK per pasangan (requester, target) ===
// Lua INCR+EXPIRE atomik — pola yang sama dengan limiter lain di repo.
const OTPK_QUOTA_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

const consumeOtpkQuota = makeOtpkQuotaGate(async (key, ttlSeconds) =>
  Number(
    await redisClient.eval(OTPK_QUOTA_LUA, {
      keys: [key],
      arguments: [String(ttlSeconds)]
    })
  )
);

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
      // [Temuan #2] Salinan encryptedPrivateKey terbaru — sinkron dengan bundle
      // yang diupload. Opsional di skema agar client lama tidak rusak; handler
      // tetap menimpa kolom device setiap kali field dikirim.
      encryptedPrivateKeys: z.string().min(1).max(100_000).optional(),
      // [docs/30 §30.5 WS-A] Identifier mentah Argon2id (base64url 32 byte) —
      // dibutuhkan HANYA untuk menulis entri log saat kunci identitas berubah
      // (server tak bisa menurunkan search key dari identifier ter-pepper).
      // Opsional: klien lama tetap jalan, rotasinya tidak tercatat (`no_identifier`).
      usernameHash: z.string().regex(base64UrlRegex, 'Invalid identifier format').optional(),
      signedPreKey: z.object({
        key: z.string().regex(base64UrlRegex, 'Invalid pre-key format'),
        pqKey: z.string().regex(base64UrlRegex, 'Invalid pq pre-key format'),
        signature: z.string().regex(base64UrlRegex, 'Invalid signature format'),
        pqSignature: z.string().regex(base64UrlRegex, 'Invalid pq signature format')
      }),
      // [docs/35 Fase 1.3] Material bundle v2 (opsional agar klien lama tetap jalan).
      // Bila `signingKeyV2` ADA, `signatureV2` wajib — diverifikasi di handler.
      signingKeyV2: z.string().regex(base64UrlRegex, 'Invalid v2 signing key format').optional(),
      signatureV2: z.string().regex(base64UrlRegex, 'Invalid v2 signature format').optional(),
      cryptoVersion: z.number().int().min(1).max(2).optional()
    })
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Authentication required.');
      
      const authUser = req.user as AuthJwtPayload;
      if (!authUser.deviceId) throw new ApiError(400, 'Device ID missing from session.');
      
      const deviceId = String(authUser.deviceId);
      // [BUGFIX 2026-10-09] Dulu variabel body ini bernama `identityKey` dan
      // MENUTUPI helper `identityKey()` dari utils/redisIdentity →
      // `identityKey('cache:keys:bundle', userId)` melempar
      // "identityKey is not a function" dan cache pre-key TIDAK pernah
      // di-invalidate (peer menerima bundle basi sampai TTL 1 jam habis).
      const {
        identityKey: identityKeyB64,
        pqIdentityKey,
        signedPreKey,
        signingKey,
        signingKeyV2,
        signatureV2,
        usernameHash
      } = req.body;

      // [docs/35 Fase 1.3] Verifikasi bundle v2 SEBELUM menyentuh DB. Kehadiran
      // salah satu field v2 mewajibkan keduanya; server hanya menyimpan setelah
      // tanda tangan ML-DSA-65 atas seluruh material kunci terbukti sah.
      let v2Bundle: { signingKeyV2: Buffer<ArrayBuffer>; signatureV2: Buffer<ArrayBuffer>; cryptoVersion: number } | null = null;
      if (signingKeyV2 !== undefined || signatureV2 !== undefined) {
        if (!signingKeyV2 || !signatureV2) {
          throw new ApiError(400, 'Bundle v2 tidak lengkap.');
        }
        const identityBuf = Buffer.from(identityKeyB64, 'base64url');
        const pqIdentityBuf = pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null;
        const signedPreKeyBuf = Buffer.from(signedPreKey.key, 'base64url');
        const pqSignedPreKeyBuf = signedPreKey.pqKey ? Buffer.from(signedPreKey.pqKey, 'base64url') : null;
        const signingKeyV2Buf = Buffer.from(signingKeyV2, 'base64url');
        const signatureV2Buf = Buffer.from(signatureV2, 'base64url');
        if (
          identityBuf.length !== BUNDLE_V2_FIELD_LENGTHS.identityKey ||
          !pqIdentityBuf ||
          pqIdentityBuf.length !== BUNDLE_V2_FIELD_LENGTHS.pqIdentityKey ||
          signedPreKeyBuf.length !== BUNDLE_V2_FIELD_LENGTHS.signedPreKey ||
          !pqSignedPreKeyBuf ||
          pqSignedPreKeyBuf.length !== BUNDLE_V2_FIELD_LENGTHS.pqSignedPreKey ||
          signingKeyV2Buf.length !== BUNDLE_V2_FIELD_LENGTHS.signingKeyV2 ||
          signatureV2Buf.length !== ML_DSA_65_SIGNATURE_BYTES
        ) {
          throw new ApiError(400, 'Ukuran material bundle v2 tidak valid.');
        }
        const message = buildBundleV2Message({
          identityKey: identityBuf,
          pqIdentityKey: pqIdentityBuf,
          signedPreKey: signedPreKeyBuf,
          pqSignedPreKey: pqSignedPreKeyBuf,
          signingKeyV2: signingKeyV2Buf,
        });
        if (
          !verifyMlDsaSignature({
            signature: signatureV2Buf,
            message,
            publicKey: signingKeyV2Buf,
            domain: PQ_V2_DOMAINS.BUNDLE,
          })
        ) {
          throw new ApiError(400, 'Tanda tangan bundle v2 tidak valid.');
        }
        v2Bundle = {
          signingKeyV2: signingKeyV2Buf,
          signatureV2: signatureV2Buf,
          cryptoVersion: CRYPTO_VERSION_V2,
        };
      }

      // [docs/30 §30.5 WS-A] Material identitas SEBELUM update — dasar keputusan
      // "kunci benar-benar berubah" (upload ulang bundle yang sama bukan rotasi).
      const previousIdentity = await prisma.device.findUnique({
        where: { id: deviceId },
        select: { publicKey: true, signingKey: true, signingKeyV2: true }
      });

      // [Temuan #2] Validasi ulang payload encrypted keys (defense in depth;
      // zod sudah memvalidasi bentuknya). Client lama tanpa field → undefined
      // → kolom device tidak disentuh.
      const encryptedKeysPayload = validateEncryptedPrivateKeysPayload(req.body.encryptedPrivateKeys);

      await prisma.$transaction(async (tx) => {
        // 1. Bersihkan sisa OTPK lama untuk mencegah "Identity Crisis"
        await tx.oneTimePreKey.deleteMany({
          where: { deviceId } 
        });

        // 2. Perbarui atau Buat Bundle Baru
        await tx.preKeyBundle.upsert({
          where: { deviceId },
          update: {
            identityKey: Buffer.from(identityKeyB64, 'base64url'),
            pqIdentityKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null,
            key: Buffer.from(signedPreKey.key, 'base64url'),
            pqKey: signedPreKey.pqKey ? Buffer.from(signedPreKey.pqKey, 'base64url') : null,
            signature: Buffer.from(signedPreKey.signature, 'base64url'),
            pqSignature: signedPreKey.pqSignature ? Buffer.from(signedPreKey.pqSignature, 'base64url') : null,
            ...(v2Bundle ? { signatureV2: v2Bundle.signatureV2 } : {})
          },
          create: {
            deviceId,
            identityKey: Buffer.from(identityKeyB64, 'base64url'),
            pqIdentityKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null,
            key: Buffer.from(signedPreKey.key, 'base64url'),
            pqKey: signedPreKey.pqKey ? Buffer.from(signedPreKey.pqKey, 'base64url') : null,
            signature: Buffer.from(signedPreKey.signature, 'base64url'),
            pqSignature: signedPreKey.pqSignature ? Buffer.from(signedPreKey.pqSignature, 'base64url') : null,
            ...(v2Bundle ? { signatureV2: v2Bundle.signatureV2 } : {})
          }
        });

        // 3. Perbarui Identitas Perangkat (Konversi aman dari base64 ke Buffer)
        await tx.device.update({
          where: { id: deviceId },
          data: {
            ...(identityKeyB64 !== undefined && { publicKey: Buffer.from(identityKeyB64, 'base64url') }),
            ...(pqIdentityKey !== undefined && { pqPublicKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null }),
            ...(signingKey !== undefined && { signingKey: Buffer.from(signingKey, 'base64url') }),
            // [docs/35 Fase 1.3] Material v2 (ML-DSA-65) — hanya ditulis bila
            // upload membawa bundle v2 yang sudah lolos verifikasi; upload v1
            // tidak menurunkan (menghapus) material v2 yang sudah ada.
            ...(v2Bundle && { signingKeyV2: v2Bundle.signingKeyV2, cryptoVersion: v2Bundle.cryptoVersion }),
            // [Temuan #2] Sinkronkan salinan encryptedPrivateKey server SETIAP
            // upload bundle — mencegah login blind di device baru menerima
            // bundle basi dari identitas lama.
            ...(encryptedKeysPayload !== undefined && toEncryptedPrivateKeyPatch(encryptedKeysPayload))
          }
        });
      });

      // [docs/30 §30.5 WS-A] Rotasi kunci identitas WAJIB terlihat di log.
      // Fire-and-forget: latensi/keberhasilan upload bundle tidak bergantung pada
      // log (kegagalannya fail-visible lewat `nyx_kt_writes_total{result}`).
      if (
        identityKeysChanged(previousIdentity, {
          identityKey: Buffer.from(identityKeyB64, 'base64url'),
          signingKey: Buffer.from(signingKey, 'base64url'),
          signingKeyV2: v2Bundle?.signingKeyV2
        })
      ) {
        void publishIdentityKeyChange({
          userId: authUser.id,
          usernameHash,
          identityKey: Buffer.from(identityKeyB64, 'base64url'),
          pqIdentityKey: pqIdentityKey ? Buffer.from(pqIdentityKey, 'base64url') : null,
          signingKey: Buffer.from(signingKey, 'base64url'),
          signingKeyV2: v2Bundle?.signingKeyV2 ?? null
        });
      }

      res.status(201).json({ message: 'Pre-key bundle updated successfully.' });

      // Invalidate Redis cache
      try {
        const userId = authUser.id;
        // [docs/28 Tier 1.5 / D14] sufiks key = tag (Redis tak memuat userId asli).
        await redisClient.del(identityKey('cache:keys:bundle', userId));
        await redisClient.del(identityKey('cache:keys:public', userId));
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
  // [docs/28 Tier 2 — B5] id user kini UUID (non-time-ordered), bukan cuid.
  // Validator menerima keduanya (baris lama tetap cuid) — bentuk aman, bukan
  // `.cuid()` yang akan menolak user baru.
  zodValidate({ params: z.object({ userId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }) }),
  async (req, res, next) => {
    try {
      const { userId } = req.params
      // [docs/35 Fase 4] `read` (PIR/preview) tidak mengonsumsi OTPK, jadi tidak
      // boleh memotong kuota konsumsi — kalau dipotong, preview profil tetap
      // "membakar" jatah harian walau kolam OTPK tidak disentuh.
      const otpkMode = parseOtpkMode(req.query.otpk)

      // Kuota harian: tolak SEBELUM cache/DB/query konsumsi OTPK (fail-closed)
      if (otpkMode === 'consume') {
        await consumeOtpkQuota((req.user as AuthJwtPayload).id, [String(userId)])
      }

      // 1. Try to get device template from Redis
      let deviceTemplate: IDeviceTemplate | null = null;
      const cacheKey = identityKey('cache:keys:bundle', String(userId));

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
          // [docs/28 Tier 2 — B4] bucket 15 menit → tie-break deterministik.
          orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
          take: 1
        })

        deviceTemplate = toDeviceTemplate(requireBundleDevice(devices));

        // Save to Redis
        try {
          await redisClient.set(cacheKey, JSON.stringify(deviceTemplate), { EX: 3600 });
        } catch (cacheError) {
          console.error('[Cache] Redis set error in prekey-bundle:', cacheError);
        }
      }

      // 3. Fetch and DELETE one OTPK from DB (Atomic) — hanya pada mode
      //    `consume`. [docs/35 Fase 4] Jalur PIR/preview memakai
      //    `?otpk=read`: identitas + signed pre-key tanpa menguras kolam OTPK
      //    peer (dulu setiap GET membakar satu pre-key, termasuk retry jaringan).
      let otpk = null;
      if (otpkMode === 'read') {
        res.json(toPreKeyBundle(deviceTemplate, null));
        return;
      }
      try {
        otpk = await prisma.$queryRaw`
          DELETE FROM "OneTimePreKey"
          WHERE id = (
            SELECT id FROM "OneTimePreKey"
            WHERE "deviceId" = ${deviceTemplate.id}
            ORDER BY "keyId" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING id, "keyId", "publicKey", "pqPublicKey"
        `.then((res: unknown) => (Array.isArray(res) && res.length > 0 ? res[0] : null) as OneTimePreKeyRow | null);
      } catch (dbError) {
        console.error('[DB] Failed to consume OTPK:', dbError);
      }

      // 4. Combine and return. OTPK habis ≠ gagal: bundle tetap dikirim tanpa
      //    `oneTimePreKey` (perilaku lama dipertahankan, kini satu implementasi).
      res.json(toPreKeyBundle(deviceTemplate, otpk));
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
          userIds.map((uid: string) => redisClient.get(identityKey('cache:keys:public', uid)))
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
          select: { id: true, userId: true, publicKey: true, pqPublicKey: true, signingKey: true, signingKeyV2: true }
        });

        const dbResults = new Map<string, Record<string, unknown>[]>();
        for (const uid of missingUserIds) {
          dbResults.set(uid, []);
        }

        for (const device of devices) {
          if (!device.signingKey || !device.publicKey) continue;

          const bundle = toPublicDeviceBundle(device);

          const arr = dbResults.get(device.userId) || [];
          arr.push(bundle);
          dbResults.set(device.userId, arr);
        }

        // 3. Cache results in Redis and merge into responseMap
        try {
          await Promise.all(
            Array.from(dbResults.entries()).map(([uid, data]) => 
              redisClient.set(identityKey('cache:keys:public', uid), JSON.stringify(data), { EX: 3600 }) // Cache for 1 hour
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

      // Kuota harian: validasi SEMUA pasangan di depan agar request gagal-tutup
      // sebelum ada satu pun OTPK dikonsumsi
      await consumeOtpkQuota((req.user as AuthJwtPayload).id, userIds)

      const responseMap = new Map<string, Record<string, unknown>[]>();
      for (const uid of userIds) {
          responseMap.set(uid, []);
      }

      // 1. Try to get cached bundles from Redis first
      const missingUserIds: string[] = [];
      try {
        const cacheResults = await Promise.all(
          userIds.map((uid: string) => redisClient.get(identityKey('cache:keys:bundle', uid)))
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

          const template = toDeviceTemplate(device) as unknown as Record<string, unknown>;

          // Cache individually
          await redisClient.set(identityKey('cache:keys:bundle', device.userId), JSON.stringify(template), { EX: 3600 });
          
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
                  ORDER BY "keyId" ASC
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
                )
                RETURNING id, "keyId", "publicKey", "pqPublicKey"
              `.then((res: unknown) => (Array.isArray(res) && res.length > 0 ? res[0] : null) as OneTimePreKeyRow | null);
            } catch (e) {}

            userBundles.push(toPreKeyBundle(template, otpk));
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
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

/**
 * [docs/29 §5.7] STUN milik OPERATOR (opsional, dipisah koma di `ICE_STUN_URLS`).
 *
 * Dulu setiap jalur gagal TURN (env kosong, Cloudflare tidak mengembalikan
 * `iceServers`, atau error transient) mengembalikan STUN publik milik pihak
 * ketiga — artinya IP klien bocor ke operator luar tepat pada momen paling
 * sensitif, dan operator tidak pernah tahu TURN-nya mati. Sekarang: STUN pihak
 * ketiga TIDAK dipakai sama sekali; operator boleh mendeklarasikan STUN-nya
 * sendiri (coturn), dan kalau tidak ada, endpoint gagal **terlihat**
 * (503/502 + error code).
 */
function operatorStunServers(): string[] {
  return (process.env.ICE_STUN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const withOperatorStun = (stun: string[]): { iceServers: Array<{ urls: string }>; stunOnly: true } => ({
  iceServers: stun.map((urls) => ({ urls })),
  stunOnly: true,
});

router.get('/turn', requireAuth, async (req, res): Promise<unknown> => {
  const stun = operatorStunServers();
  try {
    // [docs/30 §30.9 WS-E(1)] coturn self-host = PRIMER. Kredensial di-terbitkan
    // server (HMAC time-limited), username memakai `identityTag` — bukan userId —
    // sehingga log coturn tidak memetakan sesi call ke akun (docs/28).
    // Cloudflare TURN tetap ada di bawah sebagai cadangan bila coturn kosong.
    const turnUrls = parseTurnUrls(process.env.TURN_URLS);
    const turnSecret = process.env.TURN_STATIC_AUTH_SECRET;
    if (isCoturnConfigured(turnSecret, turnUrls)) {
      const credential = mintTurnCredential({
        secret: turnSecret as string,
        identityTag: identityTag((req.user as AuthJwtPayload).id),
        ttlSeconds: process.env.TURN_TTL ? Number(process.env.TURN_TTL) : undefined,
      });
      const iceServers: Array<TurnIceServer | { urls: string }> = buildTurnIceServers(turnUrls, credential);
      for (const urls of stun) iceServers.push({ urls });
      return res.json({ iceServers });
    }

    const { env } = await import('../config.js');
    if (!env.cfAccountId || !env.cfTurnKeyId || !env.cfTurnApiToken) {
      if (stun.length > 0) {
        console.warn('[TURN] Cloudflare TURN tidak dikonfigurasi — memakai STUN operator (ICE_STUN_URLS) saja.');
        return res.json(withOperatorStun(stun));
      }
      console.error('[TURN] Tidak ada TURN (Cloudflare) maupun STUN operator (ICE_STUN_URLS) — menolak dengan 503, tanpa fallback ke STUN pihak ketiga.');
      return res.status(503).json({ error: 'TURN_NOT_CONFIGURED', iceServers: [] });
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

    if (!response.ok) {
      console.error(`[TURN] Cloudflare credentials API gagal: HTTP ${response.status}`);
      if (stun.length > 0) return res.json(withOperatorStun(stun));
      return res.status(502).json({ error: 'TURN_UNAVAILABLE', iceServers: [] });
    }

    const data = await response.json() as TurnResponse;
    if (data.iceServers && data.iceServers.length > 0) {
      return res.json({ iceServers: data.iceServers });
    }

    console.error('[TURN] Cloudflare tidak mengembalikan iceServers — menolak (tanpa fallback STUN pihak ketiga).');
    if (stun.length > 0) return res.json(withOperatorStun(stun));
    return res.status(502).json({ error: 'TURN_UNAVAILABLE', iceServers: [] });
  } catch (error) {
    console.error('[TURN] Failed to fetch credentials:', error);
    if (stun.length > 0) return res.json(withOperatorStun(stun));
    return res.status(502).json({ error: 'TURN_UNAVAILABLE', iceServers: [] });
  }
});

export default router