import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { emitEventToConversation } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';

// Job 1: FAST NOTIFIER (Setiap menit)
// Fokus: Memberitahu klien bahwa pesan sudah kadaluarsa agar langsung hilang dari UI.
export const startMessageSweeper = () => {
  console.log('🧹 Message Sweeper (Fast Notifier) started...');

  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        
      // Ambil ID pesan yang kadaluarsa untuk diberitahukan ke klien
      const expiredMessages = await prisma.message.findMany({
        where: {
          OR: [
            { expiresAt: { not: null, lte: now } },
            { createdAt: { lte: fourteenDaysAgo } }
          ]
        },
        select: { id: true, conversationId: true },
        take: 500 // Ambil lebih banyak karena ini hanya READ query yang ringan
      });

      if (expiredMessages.length > 0) {
        console.log(`📡 Notifying clients about ${expiredMessages.length} expired messages...`);
        const deletedByConversation = new Map<string, string[]>();
        for (const m of expiredMessages) {
            const arr = deletedByConversation.get(m.conversationId) || [];
            arr.push(m.id);
            deletedByConversation.set(m.conversationId, arr);
        }

        for (const [conversationId, msgIds] of deletedByConversation.entries()) {
            await emitEventToConversation(conversationId, 'message:deleted_batch', { messageIds: msgIds, conversationId });
        }
      }
    } catch (error) {
      console.error('❌ Fast Sweeper Error:', error);
    }
  }, { noOverlap: true });

  // Job 2: LAZY PURGE (Setiap hari jam 03:00 AM)
  // Fokus: Penghapusan fisik data dari DB saat traffic paling rendah.
  cron.schedule('0 3 * * *', async () => {
    console.log('🔥 Starting Daily Lazy Purge (03:00 AM)...');
    try {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const deleted = await prisma.message.deleteMany({
        where: {
          OR: [
            { expiresAt: { not: null, lte: now } },
            { createdAt: { lte: fourteenDaysAgo } }
          ]
        }
      });

      console.log(`✅ Lazy Purge Complete. Permanently deleted ${deleted.count} messages.`);
    } catch (error) {
      console.error('❌ Lazy Purge Error:', error);
    }
  });
};

