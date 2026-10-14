import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { purgeSealedUserRows } from '../utils/routingIdentity.js';
// [docs/30 WS-G] Metrik event-only untuk sweeper: durasi, hasil, jumlah baris
// yang dibersihkan per jenis (tanpa identitas apa pun).
import {
  incCounter,
  observeHistogram,
  setGauge,
  nowSeconds,
  SWEEPER_DURATION,
  SWEEPER_LAST_RUN,
  SWEEPER_DELETED,
} from '../utils/metrics.js';

// Jadwalkan untuk jalan setiap jam 00:00 (server time) tiap hari
export const startSystemSweeper = () => {
  console.log('🧹 System Sweeper Job scheduled (Daily at 00:00)...');

  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Memulai pembersihan database harian...');
    const now = new Date();
    const startedAt = Date.now();
    let sweepResult: 'ok' | 'error' = 'ok';

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
        incCounter(SWEEPER_DELETED, { kind: 'refresh_token' }, deletedTokens.count);
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
        incCounter(SWEEPER_DELETED, { kind: 'session_key' }, deletedSessionKeys.count);
        console.log(`[Cron] Berhasil menghapus ${deletedSessionKeys.count} kunci sesi kadaluarsa/usang.`);
      }

      // 3. 💀 DEAD MAN'S SWITCH (Auto-Destruct Accounts)
      const usersWithSwitch = await prisma.user.findMany({
        where: { autoDestructDays: { not: null } },
        // [docs/28 Tier 2 — B4] kolom diganti `lastActiveDay` (bucket harian).
        select: { id: true, lastActiveDay: true, autoDestructDays: true }
      });

      let nukedCount = 0;
      for (const u of usersWithSwitch) {
        if (!u.autoDestructDays) continue;
        const deadline = new Date(u.lastActiveDay);
        deadline.setDate(deadline.getDate() + u.autoDestructDays);
        
        if (now > deadline) {
           console.log(`[Cron] 💀 DEAD MAN'S SWITCH TRIGGERED for User ${u.id}. Erasing all traces...`);
           try {
             // [docs/28 D8/D9] Story & BlockedUser tidak lagi punya FK cascade →
             // bersihkan eksplisit sebelum user dihapus (erasing all traces).
             await purgeSealedUserRows(prisma, u.id);
             await prisma.user.deleteMany({ where: { id: u.id } }); // Cascade deletes messages, conversations, keys.
             nukedCount++;
           } catch (err) {
             console.error('[Cron] Failed to execute Dead Man Switch for user:', u.id, err);
           }
        }
      }
      if (nukedCount > 0) {
         incCounter(SWEEPER_DELETED, { kind: 'account' }, nukedCount);
         console.log(`[Cron] Auto-destructed ${nukedCount} dormant accounts.`);
      }

      // 4. NYX PRO Subscription Expiration (Passive Sweeper)
      const expiredSubs = await prisma.user.updateMany({
        where: {
          subscriptionTier: 'SUBSCRIBER',
          subscriptionExpiresAt: {
            lt: now
          }
        },
        data: {
          subscriptionTier: 'FREE',
          subscriptionExpiresAt: null
        }
      });

      if (expiredSubs.count > 0) {
        console.log(`[Cron] 📉 Downgraded ${expiredSubs.count} expired SUBSCRIBER accounts to FREE tier.`);
      }

      // 5. [P3 2026-10-05] Story expired: hapus fisik dari DB (dulu menumpuk
      // selamanya — expired hanya difilter saat baca; audit temuan #9). Media
      // R2 dibiarkan di-handle fileRetention presigned (24 jam, sama dengan
      // umur story).
      const deletedStories = await prisma.story.deleteMany({
        where: { expiresAt: { lte: now } }
      });
      if (deletedStories.count > 0) {
        incCounter(SWEEPER_DELETED, { kind: 'story' }, deletedStories.count);
        console.log(`[Cron] 🧹 Dihapus ${deletedStories.count} story kadaluarsa.`);
      }

    } catch (error) {
      sweepResult = 'error';
      console.error('[Cron] Gagal melakukan pembersihan database:', error);
    } finally {
      // Dicatat di finally supaya putaran yang GAGAL pun terlihat (lag sweeper
      // yang tak terukur adalah cara paling mudah kehilangan alert disk penuh).
      observeHistogram(SWEEPER_DURATION, (Date.now() - startedAt) / 1000, { result: sweepResult });
      setGauge(SWEEPER_LAST_RUN, nowSeconds(), { result: sweepResult });
    }
  });
};
