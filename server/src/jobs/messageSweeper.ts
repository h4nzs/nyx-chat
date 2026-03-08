import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';
import { deleteR2Files } from '../utils/r2.js';

// Jalanin fungsi ini setiap 1 menit (* * * * *)
export const startMessageSweeper = () => {
  console.log('🧹 Message Sweeper Job started...');

  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const BATCH_SIZE = 100;
      let processedCount = 0;

      while (true) {
        // 1. Cari pesan yang waktunya udah kelewat (Batching)
        const expiredMessages = await prisma.message.findMany({
          where: {
            expiresAt: {
              not: null,
              lte: now
            }
          },
          select: { id: true, conversationId: true, fileKey: true },
          take: BATCH_SIZE
        });

        if (expiredMessages.length === 0) break; // Selesai

        const messageIds = expiredMessages.map(m => m.id);

        console.log(`🔥 Sweeping batch of ${messageIds.length} expired messages...`);

        // 2. HAPUS FILE MEDIA DARI CLOUDFLARE R2 TERLEBIH DAHULU
        const fileKeysToDelete = expiredMessages
          .map(m => m.fileKey)
          .filter((key): key is string => key !== null && key !== undefined);

        if (fileKeysToDelete.length > 0) {
          console.log(`🗑️ Deleting ${fileKeysToDelete.length} orphaned files from R2...`);
          try {
            await deleteR2Files(fileKeysToDelete);
          } catch (s3Err) {
            console.error('❌ Failed to delete files from R2:', s3Err);
            // Continue execution so database rows are still cleaned up even if R2 fails
          }
        }

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
