import os from 'os';
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { s3Client } from '../utils/r2.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../config.js';
import { getIo } from '../socket.js';

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

    res.json({ vps, db, storage });
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
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch banned users' });
  }
});

// 2. Ban User
router.post('/ban', requireAuth, requireAdmin, async (req, res) => {
  const { userId, reason } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  try {
    await prisma.user.update({
        where: { id: userId },
        data: { bannedAt: new Date(), banReason: reason || 'Violation of TOS' }
    });

    // KICK USER DARI SOCKET
    const io = getIo();
    if (io) {
        io.to(userId).emit('auth:banned', { reason }); 
        // Force disconnect logic if socket tracking by user ID is implemented
        // Note: Standard socket.io doesn't easily map userId -> socketId without an adapter/store.
        // But we can try to broadcast to their room if they join 'user_{id}' room.
        // Otherwise, rely on client receiving 'auth:banned' to logout.
    }

    res.json({ message: 'User banned successfully' });
  } catch (e) {
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
    res.json({ message: 'User unbanned successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

export default router;
