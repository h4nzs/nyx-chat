// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redisClient } from '../lib/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { generalLimiter, uploadLimiter } from '../middleware/rateLimiter.js';
import { openAtRest, sealAtRest } from '../utils/atRestSecrets.js';
import { ApiError } from '../utils/errors.js';
import { zodValidate } from '../utils/validate.js';
import type { LinkingSealer, LinkingStore } from '../utils/deviceLinking.js';
import {
  burnHistory,
  markHistoryReady,
  readHistoryState,
  recordHistoryPresign,
} from '../utils/linkHistory.js';
import { deriveLinkHistoryObjectKey, validateHistorySize } from '../utils/linkHistoryObject.js';
import { deleteR2File, getPresignedDownloadUrl, getPresignedUploadUrl } from '../utils/r2.js';

// [docs/40 §40.6] Arsip riwayat sekali-pakai untuk perangkat hasil link.
//
// Dipasang di `/api/auth/link/history` (lihat `app.ts`; dimount SEBELUM router
// `/api/auth`). Kontrak privasi:
//   - Server tidak pernah melihat kunci arsip maupun isinya. Yang disimpan
//     hanya pointer ter-seal `{size, digest, sealedKey}`; `sealedKey` sudah
//     ciphertext X-Wing ke perangkat baru.
//   - Nama state = `deviceId` dari sesi perangkat BARU, bukan parameter request
//     → tidak ada id yang bisa dienumerasi dan tidak ada cek "ini punya saya?"
//     yang bisa salah tulis.
//   - Objek R2 dihapus saat `consume`; TTL Redis 30 menit dan lifecycle rule
//     `link-history/` jadi jaring bila klien hilang di tengah jalan.
//
// Otorisasi UNGGAH sengaja ketat: hanya perangkat yang BARU dibuat (≤30 menit)
// yang boleh menulis arsip. Tanpa batas ini, endpoint menjadi penyimpanan blob
// gratis untuk device mana pun milik akun.

const router: Router = Router();

const linkStore: LinkingStore = {
  get: (key) => redisClient.get(key),
  setEx: (key, ttlSeconds, value) => redisClient.setEx(key, ttlSeconds, value),
  del: async (...keys) => {
    if (keys.length === 0) return 0;
    return redisClient.del(keys);
  },
  getDel: (key) => redisClient.getDel(key),
};

const linkSealer: LinkingSealer = { seal: sealAtRest, open: openAtRest };

/** Jendela saat perangkat baru masih dianggap "hasil link" untuk unggahan. */
export const LINK_HISTORY_UPLOAD_WINDOW_MS = 30 * 60 * 1000;

/**
 * Perangkat tujuan harus milik user ini DAN baru dibuat. `createdAt` dipotong
 * ke bucket di tempat lain, tetapi kolomnya sendiri tetap presisi — di sini
 * presisi itu yang dipakai, dan nilainya tidak pernah keluar dari proses.
 */
async function assertFreshDeviceOfUser(userId: string, deviceId: string): Promise<void> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { userId: true, createdAt: true },
  });
  if (!device || device.userId !== userId) {
    throw new ApiError(403, 'Device does not belong to this account.');
  }
  if (Date.now() - device.createdAt.getTime() > LINK_HISTORY_UPLOAD_WINDOW_MS) {
    throw new ApiError(409, 'DEVICE_LINK_WINDOW_CLOSED');
  }
}

async function accountTier(userId: string): Promise<{ isVerified: boolean; tier: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isVerified: true, subscriptionTier: true },
  });
  return { isVerified: Boolean(user?.isVerified), tier: user?.subscriptionTier ?? null };
}

// === 1. PRESIGNED UPLOAD (perangkat lama) ===
router.post(
  '/presign',
  requireAuth,
  uploadLimiter,
  zodValidate({
    body: z.object({
      deviceId: z.string().min(8),
      size: z.number().int().positive(),
      urlTtl: z.number().int().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Unauthorized');
      const { deviceId, size, urlTtl } = req.body as {
        deviceId: string;
        size: number;
        urlTtl?: number;
      };

      await assertFreshDeviceOfUser(req.user.id, deviceId);

      const account = await accountTier(req.user.id);
      // [docs/40 §40.6] Sandbox TIDAK ditolak (beda dengan `/api/backup/presign`):
      // arsip ini sekali pakai, hidup ≤30 menit, dan dipicu perangkat yang sudah
      // login lewat token QR + approve. Batasnya saja yang dipotong (25 MB)
      // supaya R2 tidak menjadi penyimpanan gratis bagi akun belum terverifikasi.
      const decision = validateHistorySize(size, urlTtl, {
        tier: account.tier,
        verified: account.isVerified,
      });
      if (!decision.ok) throw new ApiError(decision.status, decision.error);

      const key = deriveLinkHistoryObjectKey(env.backupKeySecret, deviceId);
      const uploadUrl = await getPresignedUploadUrl(
        key,
        'application/octet-stream',
        decision.urlTtl,
        decision.size
      );

      // `ready` hanya sah untuk ukuran yang disetujui di sini.
      await recordHistoryPresign(linkStore, linkSealer, deviceId, decision.size);

      res.json({ uploadUrl, size: decision.size, urlTtl: decision.urlTtl });
    } catch (error) {
      next(error);
    }
  }
);

// === 2. READY (perangkat lama selesai mengunggah) ===
router.post(
  '/ready',
  requireAuth,
  generalLimiter,
  zodValidate({
    body: z.object({
      deviceId: z.string().min(8),
      size: z.number().int().positive(),
      digest: z.string().min(1).max(128),
      sealedKey: z.string().min(1).max(4096),
    }),
  }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Unauthorized');
      const { deviceId, size, digest, sealedKey } = req.body as {
        deviceId: string;
        size: number;
        digest: string;
        sealedKey: string;
      };

      await assertFreshDeviceOfUser(req.user.id, deviceId);

      const ready = await markHistoryReady(linkStore, linkSealer, deviceId, { size, digest, sealedKey });
      if (!ready.ok) {
        // Tidak ada presign / ukuran berbeda = klien melewati urutan atau
        // mem-PUT objek yang berbeda dari yang disetujui.
        throw new ApiError(409, `HISTORY_${ready.reason.toUpperCase()}`);
      }

      res.json({ ok: true, size: ready.state.size });
    } catch (error) {
      next(error);
    }
  }
);

// === 2b. ABORT (perangkat lama berhenti / tidak ada yang bisa dikirim) ===
// Tanpa endpoint ini, perangkat baru menunggu penuh 60 detik karena
// `status.history` tetap `preparing` sampai TTL intent habis.
router.post(
  '/abort',
  requireAuth,
  generalLimiter,
  zodValidate({ body: z.object({ deviceId: z.string().min(8) }) }),
  async (req, res, next) => {
    try {
      if (!req.user) throw new ApiError(401, 'Unauthorized');
      const { deviceId } = req.body as { deviceId: string };
      await assertFreshDeviceOfUser(req.user.id, deviceId);

      const key = deriveLinkHistoryObjectKey(env.backupKeySecret, deviceId);
      // Objek mungkin belum pernah dibuat; DELETE di S3/R2 idempoten.
      await deleteR2File(key).catch(() => {});
      await burnHistory(linkStore, linkSealer, deviceId);

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

// === 3. STATUS (perangkat baru) ===
router.get('/', requireAuth, generalLimiter, async (req, res, next) => {
  try {
    if (!req.deviceId) throw new ApiError(401, 'Unauthorized');
    const state = await readHistoryState(linkStore, linkSealer, req.deviceId);
    if (!state) return res.json({ state: 'none' as const });
    res.json({ state: 'ready' as const, size: state.size, digest: state.digest });
  } catch (error) {
    next(error);
  }
});

// === 4. DOWNLOAD (perangkat baru) ===
// Tidak membakar state: unduhan bisa diulang sampai TTL bila impor gagal di
// tengah jalan (jaringan buruk). Yang membuat arsip "sekali pakai" adalah
// `consume` di bawah, yang menghapus objek dari R2.
router.post('/download', requireAuth, generalLimiter, async (req, res, next) => {
  try {
    if (!req.deviceId) throw new ApiError(401, 'Unauthorized');
    const state = await readHistoryState(linkStore, linkSealer, req.deviceId);
    if (!state) throw new ApiError(404, 'NO_HISTORY');

    const key = deriveLinkHistoryObjectKey(env.backupKeySecret, req.deviceId);
    const urlTtl = 300;
    const downloadUrl = await getPresignedDownloadUrl(key, urlTtl);

    res.json({
      downloadUrl,
      sealedKey: state.sealedKey,
      size: state.size,
      digest: state.digest,
      urlTtl,
    });
  } catch (error) {
    next(error);
  }
});

// === 5. CONSUME (perangkat baru selesai mengimpor) ===
router.post(
  '/consume',
  requireAuth,
  generalLimiter,
  zodValidate({ body: z.object({ digest: z.string().min(1).max(128) }) }),
  async (req, res, next) => {
    try {
      if (!req.deviceId) throw new ApiError(401, 'Unauthorized');
      const { digest } = req.body as { digest: string };

      const state = await readHistoryState(linkStore, linkSealer, req.deviceId);
      // Idempoten: konsumsi kedua (retry setelah jaringan putus) = sukses.
      if (!state) return res.json({ deleted: true, existed: false });
      if (state.digest !== digest) {
        // Digest berbeda = yang diimpor bukan yang ditunjuk state. Jangan bakar.
        throw new ApiError(409, 'HISTORY_DIGEST_MISMATCH');
      }

      const key = deriveLinkHistoryObjectKey(env.backupKeySecret, req.deviceId);
      // Hapus objek DULU, lalu state: kalau penghapusan R2 gagal, state masih
      // ada dan pengguna bisa mencoba lagi (objek yatim disapu lifecycle rule).
      await deleteR2File(key);
      await burnHistory(linkStore, linkSealer, req.deviceId);

      res.json({ deleted: true, existed: true });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
