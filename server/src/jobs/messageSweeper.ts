import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { emitEventToUsers } from '../network/redisBridge.js';
import { resolveRoutingUser } from '../utils/routingIdentity.js';
import { runWithJobLock } from '../utils/jobLock.js';

/** Satu halaman query. Cukup kecil supaya insert/notifikasi antar-halaman tetap responsif. */
const SWEEP_BATCH_SIZE = 500;

/**
 * [AUDIT 2026-10-24] Batas halaman per menit. Dulu sweeper mengambil maksimum
 * 500 pesan/menit TANPA `orderBy`, jadi saat burst melebihi 500/menit antrean
 * tumbuh tanpa batas dan yang terhapus acak (pesan paling lama bisa tertinggal
 * berjam-jam). Sekarang urut `expiresAt` lalu lanjut ke halaman berikutnya
 * dalam run yang sama; 20 halaman = 10.000 pesan/menit kapasitas drain, dan
 * batas ini mencegah satu run berjalan melewati menit berikutnya.
 */
const MAX_SWEEP_BATCHES_PER_RUN = 20;

/**
 * Ambil + notifikasi + hapus SATU halaman pesan kedaluwarsa.
 *
 * Urutan: `expiresAt` paling lama dulu (NULL = baris yang jatuh lewat batas
 * 14 hari, didahulukan agar tidak kelaparan saat antrean panjang). Notifikasi
 * dikirim sebelum `deleteMany` — kalau proses mati setelah delete, klien tidak
 * pernah tahu pesan itu hilang.
 *
 * @returns jumlah baris yang terhapus pada halaman ini.
 */
async function sweepBatch (now: Date, fourteenDaysAgo: Date): Promise<number> {
  // Ambil ID pesan yang kadaluarsa
  const expiredMessages = await prisma.message.findMany({
    where: {
      OR: [
        { expiresAt: { not: null, lte: now } },
        { createdAt: { lte: fourteenDaysAgo } }
      ]
    },
    select: { id: true, conversationId: true },
    orderBy: { expiresAt: { sort: 'asc', nulls: 'first' } },
    take: SWEEP_BATCH_SIZE
  });

  if (expiredMessages.length === 0) return 0;

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
    // [docs/28 Tier 1.2] nilai kolom = routing identity ter-seal →
    // dibuka di sini supaya notifikasi tetap sampai ke user asli.
    const routingUser = await resolveRoutingUser(uc.userId);
    if (!routingUser) continue;
    const arr = recipientsByConversation.get(uc.conversationId) || [];
    arr.push(routingUser);
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
  return expiredMessages.length;
}

// Job: MESSAGE SWEEPER (Setiap menit)
// Fokus: Menghapus pesan kadaluarsa dan memberitahu klien agar langsung hilang dari UI.
export const startMessageSweeper = () => {
  console.log('🧹 Message Sweeper started...');

  // TTL 600 dtk > backlog maksimum (MAX_SWEEP_BATCHES_PER_RUN halaman);
  // 120 dtk bisa habis di tengah drain dan membiarkan worker lain menimpa.
  cron.schedule('* * * * *', () => runWithJobLock('message-sweeper', 600, async () => {
    try {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      // Drain berurutan sampai halaman terakhir kosong/pendek. `now` dikunci
      // sekali per run supaya cutoff tidak bergeser di tengah backlog.
      let total = 0;
      for (let batch = 0; batch < MAX_SWEEP_BATCHES_PER_RUN; batch++) {
        const deleted = await sweepBatch(now, fourteenDaysAgo);
        total += deleted;
        if (deleted < SWEEP_BATCH_SIZE) return;
        if (batch === MAX_SWEEP_BATCHES_PER_RUN - 1) {
          console.warn(
            `⚠️ Message Sweeper mencapai batas ${MAX_SWEEP_BATCHES_PER_RUN} halaman ` +
            `(${total} pesan); sisa backlog dilanjutkan pada run berikutnya.`
          );
        }
      }
    } catch (error) {
      console.error('❌ Message Sweeper Error:', error);
    }
  }), { noOverlap: true });
};
