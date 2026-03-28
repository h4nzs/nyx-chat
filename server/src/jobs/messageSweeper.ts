import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';

// Jalanin fungsi ini setiap 1 menit (* * * * *)
export const startMessageSweeper = () => {
  console.log('🧹 Message Sweeper Job started...');

  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
        const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        
        const BATCH_SIZE = 100;
        let processedCount = 0;

        while (true) {
          // 1. Cari pesan dengan DUA kondisi (Disappearing Message ATAU Server TTL)
          const expiredMessages = await prisma.message.findMany({
            where: {
              OR: [
                {
                  // Kondisi 1: Fitur Disappearing Message (expiresAt habis)
                  expiresAt: {
                    not: null,
                    lte: now
                  }
                },
                {
                  // Kondisi 2: Server Store-and-Forward TTL (Umur pesan > 14 hari)
                  createdAt: {
                    lte: fourteenDaysAgo
                  }
                }
              ]
            },
            select: { id: true, conversationId: true },
            take: BATCH_SIZE
          });

          if (expiredMessages.length === 0) break; // Selesai

        const messageIds = expiredMessages.map(m => m.id);

        console.log(`🔥 Sweeping batch of ${messageIds.length} expired messages...`);

        // 3. HAPUS PERMANEN DARI DATABASE!
        await prisma.message.deleteMany({
          where: { id: { in: messageIds } }
        });

        // 4. Kasih tau Frontend lewat Socket.IO (Group by Conversation)
        const io = getIo();
        if (io) {
          const messagesByConvo: Record<string, string[]> = {};

          expiredMessages.forEach(m => {
            if (!messagesByConvo[m.conversationId]) {
              messagesByConvo[m.conversationId] = [];
            }
            messagesByConvo[m.conversationId].push(m.id);
          });

          Object.entries(messagesByConvo).forEach(([convoId, ids]) => {
            io.to(convoId).emit('messages:expired', { messageIds: ids });
          });
        }

        processedCount += expiredMessages.length;
        // Optional: Small delay to let event loop breathe if heavily loaded
        await new Promise(r => setTimeout(r, 50));
      }

      if (processedCount > 0) console.log(`✅ Total swept: ${processedCount}`);

    } catch (error) {
      console.error('❌ Message Sweeper Error:', error);
    }
  }, { noOverlap: true });
};
