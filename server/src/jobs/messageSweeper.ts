import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { emitEventToUsers } from '../network/redisBridge.js';
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

        // 2. Beritahu klien via Redis Bridge (Opaque Mailbox: cari user via UserHiddenConversation)
        // N+1 FIX: satu query untuk SEMUA conversation yang terpengaruh (bukan per-conversation)
        const affectedConversationIds = Array.from(deletedByConversation.keys());
        const userConvs = await prisma.userHiddenConversation.findMany({
            where: { conversationId: { in: affectedConversationIds } },
            select: { userId: true, conversationId: true }
        });

        const recipientsByConversation = new Map<string, string[]>();
        for (const uc of userConvs) {
            // [T3b TOKEN-FIRST] userId nullable (routing-only) — baris tanpa
            // userId dilewati (membership murni token tidak punya jalur push).
            if (!uc.userId) continue;
            const arr = recipientsByConversation.get(uc.conversationId) || [];
            arr.push(uc.userId);
            recipientsByConversation.set(uc.conversationId, arr);
        }

        for (const [conversationId, msgIds] of deletedByConversation.entries()) {
            const recipientIds = recipientsByConversation.get(conversationId) || [];
            if (recipientIds.length > 0) {
                await emitEventToUsers(recipientIds, 'message:deleted_batch', { messageIds: msgIds, conversationId });
            }
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

