import os from 'os';
import crypto from 'crypto';
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { s3Client } from '../utils/r2.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../config.js';
import { emitEventToUser, sendJsonToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';

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
  } catch (_error) {
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

    // KICK USER DARI WEBTRANSPORT
    try {
      await emitEventToUser(userId, 'auth:banned', { reason });
      await sendJsonToUser(userId, TransportOpCode.KICK, { reason });
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
    res.json({ message: 'User unbanned successfully' });
  } catch (_e) {
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// 4. Get All Tenants
router.get('/tenants', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(tenants);
  } catch (error) {
    console.error("Failed to fetch tenants:", error);
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

// 5. Create Tenant
router.post('/tenants', requireAuth, requireAdmin, async (req, res) => {
  const { name, allowedDomains } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Tenant name is required' });
  }

  let domains: string[] = [];
  if (Array.isArray(allowedDomains)) {
    domains = allowedDomains;
  } else if (typeof allowedDomains === 'string') {
    domains = allowedDomains.split(',').map((d: string) => d.trim()).filter(Boolean);
  }

  try {
    const apiKey = crypto.randomBytes(32).toString('hex');
    const tenant = await prisma.tenant.create({
      data: {
        name,
        apiKey,
        allowedDomains: domains
      }
    });
    res.json(tenant);
  } catch (error) {
    console.error("Failed to create tenant:", error);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// 6. Toggle Tenant Status
router.patch('/tenants/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    
    const updatedTenant = await prisma.tenant.update({
      where: { id },
      data: { isActive: !tenant.isActive }
    });
    res.json(updatedTenant);
  } catch (error) {
    console.error("Failed to toggle tenant:", error);
    res.status(500).json({ error: 'Failed to toggle tenant status' });
  }
});

export default router;
