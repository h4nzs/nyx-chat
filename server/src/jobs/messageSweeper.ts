import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';
import { deleteR2File } from '../utils/r2.js';
import { env } from '../config.js';

// Jalanin fungsi ini setiap 1 menit (* * * * *)
export const startMessageSweeper = () => {
  console.log('🧹 Message Sweeper Job started...');
  
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();

      // 1. Cari pesan yang waktunya udah kelewat
      const expiredMessages = await prisma.message.findMany({
        where: { 
          expiresAt: { 
            not: null,
            lte: now 
          } 
        },
        select: { id: true, conversationId: true, fileUrl: true }
      });

      if (expiredMessages.length > 0) {
        const messageIds = expiredMessages.map(m => m.id);
        const conversationIds = Array.from(new Set(expiredMessages.map(m => m.conversationId)));
        
        // Kumpulkan Key R2 dari URL
        const filesToDelete = expiredMessages
          .filter(m => m.fileUrl && m.fileUrl.includes(env.r2PublicDomain))
          .map(m => m.fileUrl!.replace(`${env.r2PublicDomain}/`, ''));

        console.log(`🔥 Sweeping ${messageIds.length} expired messages and ${filesToDelete.length} R2 files...`);

        // 2. HAPUS FILE DARI CLOUDFLARE R2 DULU
        if (filesToDelete.length > 0) {
          await Promise.allSettled(
            filesToDelete.map(key => deleteR2File(key))
          );
        }

        // 3. HAPUS PERMANEN DARI DATABASE!
        await prisma.message.deleteMany({
          where: { id: { in: messageIds } }
        });

        // 4. Kasih tau Frontend lewat Socket.IO
        const io = getIo();
        if (io) {
          conversationIds.forEach((convoId: string) => {
            io.to(convoId).emit('messages:expired', { messageIds });
          });
        }
      }
    } catch (error) {
      console.error('❌ Message Sweeper Error:', error);
    }
  });
};
