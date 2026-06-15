import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { emitEventToConversation } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';

// Job: MESSAGE SWEEPER (Setiap menit)
// Fokus: Menghapus pesan kadaluarsa dan memberitahu klien agar langsung hilang dari UI.
export const startMessageSweeper = () => {
  console.log('🧹 Message Sweeper started...');

  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        
      // Ambil ID pesan yang kadaluarsa
      const expiredMessages = await prisma.message.findMany({
        where: {
          OR: [
            { expiresAt: { not: null, lte: now } },
            { createdAt: { lte: fourteenDaysAgo } }
          ]
        },
        select: { id: true, conversationId: true },
        take: 500
      });

      if (expiredMessages.length > 0) {
        console.log(`📡 Notifying clients and deleting ${expiredMessages.length} expired messages...`);
        
        // 1. Kelompokkan berdasarkan percakapan untuk efisiensi broadcast
        const deletedByConversation = new Map<string, string[]>();
        for (const m of expiredMessages) {
            const arr = deletedByConversation.get(m.conversationId) || [];
            arr.push(m.id);
            deletedByConversation.set(m.conversationId, arr);
        }

        // 2. Beritahu klien via Redis Bridge
        for (const [conversationId, msgIds] of deletedByConversation.entries()) {
            await emitEventToConversation(conversationId, 'message:deleted_batch', { messageIds: msgIds, conversationId });
        }

        // 3. ✅ PERBAIKAN: Hapus fisik segera agar tidak ter-query lagi di menit berikutnya
        const messageIds = expiredMessages.map(m => m.id);
        await prisma.message.deleteMany({
          where: { id: { in: messageIds } }
        });

        console.log(`✅ Permanently deleted ${messageIds.length} messages.`);
      }
    } catch (error) {
      console.error('❌ Message Sweeper Error:', error);
    }
  }, { noOverlap: true });
};

