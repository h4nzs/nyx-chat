import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';

// Jadwalkan untuk jalan setiap jam 3 pagi (server time) tiap hari
export const startSystemSweeper = () => {
  console.log('🧹 System Sweeper Job scheduled (Daily at 03:00)...');
  
  cron.schedule('0 3 * * *', async () => {
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

    } catch (error) {
      console.error('[Cron] Gagal melakukan pembersihan database:', error);
    }
  });
};
