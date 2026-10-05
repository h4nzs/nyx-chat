import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';

// Jadwalkan untuk jalan setiap jam 00:00 (server time) tiap hari
export const startSystemSweeper = () => {
  console.log('🧹 System Sweeper Job scheduled (Daily at 00:00)...');

  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Memulai pembersihan database harian...');
    const now = new Date();

    try {
      // 1. Bersihkan RefreshToken kadaluarsa & yang sudah di-revoke (logout)
      const deletedTokens = await prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lte: now } },      // Yang udah lewat 30 hari
            { revokedAt: { not: null } }      // Yang udah di-logout sama user
          ]
        }
      });
      if (deletedTokens.count > 0) {
        console.log(`[Cron] Berhasil menghapus ${deletedTokens.count} token kadaluarsa.`);
      }

      // 2. Bersihkan SessionKey kadaluarsa
      // A. Hapus yang expiresAt-nya sudah lewat (eksplisit)
      // B. Hapus yang sudah sangat tua (misal > 30 hari) untuk menjaga kebersihan database (Housekeeping)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const deletedSessionKeys = await prisma.sessionKey.deleteMany({
        where: {
          OR: [
            { expiresAt: { not: null, lte: now } }, // Expired explicitly
            { createdAt: { lte: thirtyDaysAgo } }   // Stale/Old keys
          ]
        }
      });

      if (deletedSessionKeys.count > 0) {
        console.log(`[Cron] Berhasil menghapus ${deletedSessionKeys.count} kunci sesi kadaluarsa/usang.`);
      }

      // 3. 💀 DEAD MAN'S SWITCH (Auto-Destruct Accounts)
      const usersWithSwitch = await prisma.user.findMany({
        where: { autoDestructDays: { not: null } },
        select: { id: true, lastActiveAt: true, autoDestructDays: true }
      });

      let nukedCount = 0;
      for (const u of usersWithSwitch) {
        if (!u.autoDestructDays) continue;
        const deadline = new Date(u.lastActiveAt);
        deadline.setDate(deadline.getDate() + u.autoDestructDays);
        
        if (now > deadline) {
           console.log(`[Cron] 💀 DEAD MAN'S SWITCH TRIGGERED for User ${u.id}. Erasing all traces...`);
           try {
             await prisma.user.deleteMany({ where: { id: u.id } }); // Cascade deletes messages, conversations, keys.
             nukedCount++;
           } catch (err) {
             console.error('[Cron] Failed to execute Dead Man Switch for user:', u.id, err);
           }
        }
      }
      if (nukedCount > 0) {
         console.log(`[Cron] Auto-destructed ${nukedCount} dormant accounts.`);
      }

      // 4. NYX PRO Subscription Expiration (Passive Sweeper)
      const expiredSubs = await prisma.user.updateMany({
        where: {
          subscriptionTier: 'SUBSCRIBER',
          subscriptionExpiresAt: {
            lt: now
          }
        },
        data: {
          subscriptionTier: 'FREE',
          subscriptionExpiresAt: null
        }
      });

      if (expiredSubs.count > 0) {
        console.log(`[Cron] 📉 Downgraded ${expiredSubs.count} expired SUBSCRIBER accounts to FREE tier.`);
      }

      // 5. [P3 2026-10-05] Story expired: hapus fisik dari DB (dulu menumpuk
      // selamanya — expired hanya difilter saat baca; audit temuan #9). Media
      // R2 dibiarkan di-handle fileRetention presigned (24 jam, sama dengan
      // umur story).
      const deletedStories = await prisma.story.deleteMany({
        where: { expiresAt: { lte: now } }
      });
      if (deletedStories.count > 0) {
        console.log(`[Cron] 🧹 Dihapus ${deletedStories.count} story kadaluarsa.`);
      }

    } catch (error) {
      console.error('[Cron] Gagal melakukan pembersihan database:', error);
    }
  });
};
