import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { emitEventToConversation } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';

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
            select: { id: true, conversationId: true, conversation: { include: { participants: true } } },
            take: BATCH_SIZE
          });

          if (expiredMessages.length === 0) break; // Selesai

        const messageIds = expiredMessages.map(m => m.id);

        console.log(`🔥 Sweeping batch of ${messageIds.length} expired messages...`);

        // 3. HAPUS PERMANEN DARI DATABASE!
        await prisma.message.deleteMany({
          where: { id: { in: messageIds } }
        });

        // 4. Kasih tau Frontend lewat Redis Bridge
        const deletedByConversation = new Map<string, string[]>();
        for (const m of expiredMessages) {
            const arr = deletedByConversation.get(m.conversationId) || [];
            arr.push(m.id);
            deletedByConversation.set(m.conversationId, arr);
        }

        for (const [conversationId, msgIds] of deletedByConversation.entries()) {
            await emitEventToConversation(conversationId, 'message:deleted_batch', { messageIds: msgIds, conversationId });
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

