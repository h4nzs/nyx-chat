import os from 'os';
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { s3Client } from '../utils/r2.js';
import { toBanReason } from '../utils/banReason.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../config.js';
import { redisClient } from '../lib/redis.js';
import { emitEventToUser, sendJsonToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { atRestStatus } from '../utils/atRestSecrets.js';

const router = Router();

// 1. System Status
router.get('/system-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    // VPS METRICS
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const vps = {
      ramUsage: `${(usedMem / 1024 / 1024 / 1024).toFixed(2)} GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
      uptime: `${(os.uptime() / 3600).toFixed(1)} Hours`,
      cpuLoad: os.loadavg(),
    };

    // DATABASE METRICS
    const db = {
      totalUsers: await prisma.user.count(),
      totalMessages: await prisma.message.count(),
      bannedUsers: await prisma.user.count({ where: { bannedAt: { not: null } } }),
      activeGroups: await prisma.conversation.count({ where: { isGroup: true } }),
    };

    // STORAGE METRICS (R2)
    let totalFiles = 0;
    let totalSize = 0;
    try {
        const command = new ListObjectsV2Command({ Bucket: env.r2BucketName });
        const r2Data = await s3Client.send(command);
        totalFiles = r2Data.KeyCount || 0;
        r2Data.Contents?.forEach(item => { totalSize += item.Size || 0; });
    } catch (e) {
        console.error("R2 Metrics Error:", e);
    }

    const storage = {
      totalFiles,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2) + ' MB'
    };

    // [docs/37 §37.4 P6] Status custody at-rest: kunci mana yang aktif, berapa
    // kunci di ring, dan dari mana materinya dibaca. TIDAK memuat nilai kunci —
    // yang dibutuhkan operator hanyalah "apakah rotasi sudah aktif". Key ring
    // yang rusak dilaporkan sebagai error, bukan disembunyikan sebagai legacy.
    let atRest: Record<string, unknown>;
    try {
      atRest = { ok: true, ...atRestStatus() };
    } catch (error) {
      atRest = { ok: false, error: error instanceof Error ? error.message : 'UNKNOWN' };
    }

    res.json({ vps, db, storage, atRest });
  } catch (error) {
    console.error("System status error:", error);
    res.status(500).json({ error: 'Failed to fetch system metrics' });
  }
});

// 1.5 Get Banned Users List
router.get('/banned-users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const bannedUsers = await prisma.user.findMany({
      where: { bannedAt: { not: null } },
      select: {
        id: true,
        usernameHash: true,
        bannedAt: true,
        banReason: true
      },
      orderBy: { bannedAt: 'desc' }
    });
    res.json(bannedUsers);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch banned users' });
  }
});

// 2. Ban User
router.post('/ban', requireAuth, requireAdmin, async (req, res) => {
  const { userId, reason } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });
  // [docs/43 §43.16.4 R3] Hanya kode enum yang disimpan/dikirim — kalimat bebas
  // dari dashboard tidak pernah masuk DB maupun payload socket.
  const banReason = toBanReason(reason);

  try {
    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: new Date(), banReason }
    });

    // Invalidate ban cache agar middleware requireAuth segera melihat ban baru
    await redisClient.del(`ban_status:${userId}`).catch((e: unknown) => console.warn('[Admin] Failed to invalidate ban cache:', e));

    // KICK USER DARI WEBTRANSPORT
    try {
      await emitEventToUser(userId, 'auth:banned', { reason: banReason });
      await sendJsonToUser(userId, TransportOpCode.KICK, { reason: banReason });
    } catch (err) {
      console.error("[Admin] Failed to ban/kick user:", err);
    }

    res.json({ message: 'User banned successfully' });
  } catch (_e) {
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// 3. Unban User
router.post('/unban', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  try {
    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: null, banReason: null }
    });
    // Invalidate ban cache agar middleware requireAuth segera melihat unban
    await redisClient.del(`ban_status:${userId}`).catch((e: unknown) => console.warn('[Admin] Failed to invalidate ban cache:', e));
    res.json({ message: 'User unbanned successfully' });
  } catch (_e) {
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

export default router;
