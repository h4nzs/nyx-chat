import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { deleteR2Files } from '../utils/r2.js';

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
             // --- FIX: Erase user's files from R2 before deleting the account ---
             const userMessagesWithFiles = await prisma.message.findMany({
               where: { senderId: u.id, fileKey: { not: null } },
               select: { fileKey: true }
             });
             
             const fileKeys = userMessagesWithFiles
               .map(m => m.fileKey)
               .filter((k): k is string => k !== null && k !== undefined);
             
             if (fileKeys.length > 0) {
               console.log(`[Cron] 🗑️ Sweeping ${fileKeys.length} orphaned files for user ${u.id}...`);
               // Chunk deletion if necessary, AWS SDK typically accepts up to 1000 keys per request
               for (let i = 0; i < fileKeys.length; i += 1000) {
                  await deleteR2Files(fileKeys.slice(i, i + 1000));
               }
             }
             // --- END FIX ---

             await prisma.user.delete({ where: { id: u.id } }); // Cascade deletes messages, conversations, keys.
             nukedCount++;
           } catch (err) {
             console.error('[Cron] Failed to execute Dead Man Switch for user:', u.id, err);
           }
        }
      }
      if (nukedCount > 0) {
         console.log(`[Cron] Auto-destructed ${nukedCount} dormant accounts.`);
      }

    } catch (error) {
      console.error('[Cron] Gagal melakukan pembersihan database:', error);
    }
  });
};
