import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';

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
        select: { id: true, conversationId: true }
      });

      if (expiredMessages.length > 0) {
        const messageIds = expiredMessages.map(m => m.id);
        const conversationIds = Array.from(new Set(expiredMessages.map(m => m.conversationId)));

        console.log(`🔥 Sweeping ${messageIds.length} expired messages...`);

        // 2. HAPUS PERMANEN DARI DATABASE!
        await prisma.message.deleteMany({
          where: { id: { in: messageIds } }
        });

        // 3. Kasih tau Frontend lewat Socket.IO biar layar mereka update
        // Kita emit ke setiap conversation room yang terdampak
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
