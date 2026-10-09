// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { sendJsonToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { asConversationId, asMessageId } from '@nyx/shared'
import { toRawServerMessage, resolveRepliedToId } from '../utils/mappers.js'
import { ApiError } from '../utils/errors.js'
import { sendPushNotification } from '../utils/sendPushNotification.js'
import { deleteR2File } from '../utils/r2.js'
import { z } from 'zod'
import { zodValidate, safeEqualStrings } from '../utils/validate.js'
import { sanitizeForLog } from '../utils/logger.js'
import { credentialTokenMatches } from '../utils/atRestSecrets.js'
import { upsertMembership, type MembershipPrisma } from '../utils/routingIdentity.js'
// [docs/28 Tier 2 — B1] seq atomik per-conversation + parser kursor.
import { reserveMessageSeq, parseMessageCursor, type SeqPrismaClient } from '../utils/messageSequence.js'
// [docs/28 Tier 2 — B3] bucket waktu pesan (createdAt/expiresAt kasar).
import { messageTimeBucket } from '../utils/temporalBucket.js'

const router: Router = Router()
router.use(requireAuth)

// Helper untuk menyuntikkan properti 'repliedToId' yang hilang dari DB (karena E2EE refactor)
// agar kompatibel dengan toRawServerMessage mapper.
const ensureLegacyMessageFields = <T extends Record<string, unknown>>(msg: T) => ({
  ...msg,
  repliedToId: msg.repliedToId || null
});

// ==========================================
// 1. GET PENDING MESSAGES (Offline Catch-up)
//
// Cursor pagination (keyset, by createdAt): klien yang tertinggal > PAGE_SIZE
// mengulang permintaan dengan ?before=<createdAt pesan tertua yang sudah
// dimiliki> hingga hasMore=false. Tanpa ini, pesan lebih tua dari window
// 250 tidak pernah ter-fetch oleh client yang offline lama di grup aktif.
// Backward compatible: tanpa ?before, respons & bentuk sama seperti sebelumnya
// (hanya bertambah field hasMore/nextCursor pada objek respons).
// ==========================================
const CATCH_UP_PAGE_SIZE = 250;
const CATCH_UP_MAX_CURSOR_AGE_MS = 14 * 24 * 60 * 60 * 1000;

router.get('/:conversationId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params

    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - CATCH_UP_MAX_CURSOR_AGE_MS);

    // [docs/28 Tier 2 — B1] Kursor: `seq` (klien baru) atau ISO date (legacy).
    // Kursor seq mengurutkan berdasarkan `Message.seq`; date tetap didukung
    // supaya klien/baris lama tidak rusak sebelum backfill dijalankan.
    const cursor = parseMessageCursor(req.query.before);
    let beforeDate: Date | null = null;
    let beforeSeq: number | null = null;
    if (cursor.kind === 'date') {
      // Cursor lebih tua dari 14 hari di-clamp — pesan lebih tua dari itu sudah
      // dihapus sweeper, jadi meng-query lebih jauh hanya membuang index scan.
      beforeDate = cursor.date.getTime() < fourteenDaysAgo.getTime() ? fourteenDaysAgo : cursor.date;
    } else if (cursor.kind === 'seq') {
      beforeSeq = cursor.seq;
    }
    // Clamp jumlah juga (limit param legacy dari client lama, di-cap ke ukuran halaman).
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
    const take = Math.min(!isNaN(limitRaw) && limitRaw > 0 ? limitRaw : CATCH_UP_PAGE_SIZE, CATCH_UP_PAGE_SIZE);

    // Window retensi (createdAt) tetap membatasi umur; kursor seq menambah
    // filter `seq < beforeSeq`. Baris legacy (seq=0) otomatis urut di bawah.
    const retentionWindow = beforeDate
      ? { gt: fourteenDaysAgo, lt: beforeDate }
      : { gt: fourteenDaysAgo };
    const seqWindow = beforeSeq !== null ? { lt: beforeSeq } : undefined;

    const messageWhere = {
      conversationId,
      createdAt: retentionWindow,
      ...(seqWindow ? { seq: seqWindow } : {}),
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } }
      ]
    };

    // Ambil halaman pesan tertunda + satu pesan ekstra sebagai penanda hasMore
    // (tanpa count() tambahan — query lebih murah di VPS 1-core).
    const messages = await prisma.message.findMany({
      where: messageWhere,
      take: take + 1,
      // [docs/28 Tier 2 — B1] urutan utama = seq (createdAt hanya tie-break
      // untuk baris legacy yang semuanya seq=0).
      orderBy: [{ seq: 'desc' }, { createdAt: 'desc' }],
      include: {
        statuses: true // Biarkan untuk kompatibilitas tipe balikan (meskipun isinya mungkin kosong)
      }
    })

    const hasMore = messages.length > take;
    const page = hasMore ? messages.slice(0, take) : messages;

    // AMBIL SEMUA PESAN SYSTEM UNTUK CONVERSATION INI (control messages wajib
    // ikut di setiap halaman — decrypt kunci grup tidak boleh ketinggalan).
    const systemMessagesDesc = await prisma.message.findMany({
      where: {
        conversationId,
        type: 'SYSTEM',
        createdAt: retentionWindow,
        ...(seqWindow ? { seq: seqWindow } : {}),
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      orderBy: [{ seq: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      include: {
        statuses: true
      }
    })

    // AMBIL PESAN SYSTEM PERTAMA
    const firstSystemMessage = await prisma.message.findFirst({
      where: {
        conversationId,
        type: 'SYSTEM',
        createdAt: retentionWindow,
        ...(seqWindow ? { seq: seqWindow } : {}),
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
      include: {
        statuses: true
      }
    })

    // Gabungkan pesan normal dan pesan system (tanpa duplikasi)
    const allMessagesMap = new Map();
    [...page, ...systemMessagesDesc].forEach(msg => allMessagesMap.set(msg.id, msg));
    if (firstSystemMessage) allMessagesMap.set(firstSystemMessage.id, firstSystemMessage);
    
    // [docs/28 Tier 2 — B1] urut utama seq desc; createdAt tie-break legacy.
    const mergedMessages = Array.from(allMessagesMap.values()).sort((a, b) => {
      const sa = a.seq ?? 0;
      const sb = b.seq ?? 0;
      if (sa !== sb) return sb - sa;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    // FIX 1: Suntikkan null untuk repliedToId agar TS tidak error
    // [docs/28 Tier 2 — 2.2] kolom repliedToId TER-SEAL → buka per-pesan sebelum
    // dikirim (mapper sengaja mengosongkannya agar nilai ter-seal tak bocor).
    const safeMessages = await Promise.all(mergedMessages.map(async (msg) => {
      const mapped = toRawServerMessage(ensureLegacyMessageFields(msg));
      const realReply = await resolveRepliedToId(msg.repliedToId);
      if (realReply) mapped.repliedToId = realReply;
      return mapped;
    }));
    
    // Reverse biar di frontend urutannya bener (Oldest -> Newest)
    const items = safeMessages.reverse();

    // Cursor berikutnya = pesan USER tertua di halaman ini (bukan system, yang
    // di-include penuh tiap halaman agar tidak pernah bolong).
    // [docs/28 Tier 2 — B1] Kursor = seq bila tersedia (baris baru); baris
    // legacy (seq=0) → fallback ISO createdAt agar klien lama tetap jalan.
    const oldestUserMessage = page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = hasMore && oldestUserMessage
      ? ((oldestUserMessage.seq && oldestUserMessage.seq > 0)
          ? String(oldestUserMessage.seq)
          : (oldestUserMessage.createdAt instanceof Date
              ? oldestUserMessage.createdAt.toISOString()
              : new Date(oldestUserMessage.createdAt).toISOString()))
      : null;

    res.json({ items, hasMore, nextCursor })
  } catch (error) {
    next(error)
  }
})

// ==========================================
// 2. POST MESSAGE (Opaque Mailbox Store-and-Forward)
// ==========================================
router.post('/', zodValidate({
  body: z.object({
    conversationId: z.string().min(1),
    content: z.string().max(20000).optional().nullable(),
    sessionId: z.string().optional().nullable(),
    tempId: z.union([z.string(), z.number()]).optional(),
    expiresIn: z.number().optional().nullable(),
    isViewOnce: z.boolean().optional(),
    // Cap sama dengan jalur WebTransport: mencegah amplifikasi relay via REST
    targetRecipients: z.array(z.string()).max(500).optional(),
    // [T3b] Delivery tokens (dual-write saat invite relay) — jalur REST fallback
    // [T3b] Key = userId, value = token (Zod 4: argumen pertama z.record = schema KEY).
    targetDeliveryTokens: z.record(z.string().min(1), z.string().regex(/^[A-Za-z0-9_-]{22}$/)).optional()
    // repliedToId dihapus validasinya karena relasi DB sudah diputus
  }).refine(data => data.content, { message: "Message must contain content" })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const senderId = req.user.id
    const { conversationId, content, sessionId, tempId, expiresIn, isViewOnce } = req.body

    // HITUNG TTL (Umur Pesan di Server)
    // Jika tidak ada expiresIn, set otomatis dihancurkan dalam 14 Hari (Store-and-Forward rules).
    // [docs/28 Tier 2 — B3] createdAt dikasar (15 mnt); expiresAt diturunkan dari
    // waktu kasar yang SAMA supaya presisi tidak bocor lewat expiresAt − TTL.
    const messageAt = messageTimeBucket();
    const ttlMs = (expiresIn && typeof expiresIn === 'number' && expiresIn > 0)
        ? expiresIn * 1000
        : 14 * 24 * 60 * 60 * 1000;
    const finalExpiresAt = new Date(messageAt.getTime() + ttlMs);

    // SIMPAN KE "KANTOR POS" SEMENTARA
    // [docs/28 Tier 2 — B1] seq atomik per-conversation (urutan tak lagi dari
    // createdAt). Ambil seq + create dalam satu transaksi.
    const newMessageRaw = await prisma.$transaction(async (tx) => {
      const seq = await reserveMessageSeq(tx as unknown as SeqPrismaClient, conversationId);
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId: null,
          content,
          sessionId: sessionId || null,
          seq,
          createdAt: messageAt,
          expiresAt: finalExpiresAt,
          isViewOnce: isViewOnce === true
        },
        include: {
          statuses: true
        }
      });
      await tx.conversation.update({
        where: { id: conversationId },
        // [docs/28 Tier 2 — B3] lastMessageAt dari waktu kasar yang sama.
        data: { lastMessageAt: messageAt }
      });
      return created;
    })

    // FIX 2: Suntikkan null untuk repliedToId
    const safeMessage = toRawServerMessage(ensureLegacyMessageFields(newMessageRaw));

    // Inject tempId (Optimistic UI)
    if (tempId !== undefined) {
          if (typeof tempId === 'number') {
              safeMessage.tempId = tempId;
          } else if (typeof tempId === 'string') {
              safeMessage.tempId = /^\d+$/.test(tempId) ? parseInt(tempId, 10) : tempId;
          }
    }

    res.status(201).json(safeMessage)

    // EMIT & PUSH NOTIFICATION (Opaque Mailbox: explicit targetRecipients from client)
    const targetRecipients = req.body.targetRecipients as string[] | undefined;
    if (Array.isArray(targetRecipients) && targetRecipients.length > 0) {
        // PARALEL: relay ke semua penerima sekaligus (sebelumnya sequential)
        await Promise.all(targetRecipients.map(async (targetIdRaw) => {
            const targetId = String(targetIdRaw);
            if (targetId !== senderId) {
                await sendJsonToUser(targetId, TransportOpCode.CHAT_MESSAGE, safeMessage);

                // Register for offline discovery
                // [T3b TOKEN-FIRST] Membership row kunci token; userId routing-only.
                const targetDeliveryTokens = req.body.targetDeliveryTokens as Record<string, string> | undefined;
                const targetToken = targetDeliveryTokens?.[targetId];
                if (targetToken) {
                    // [docs/28 Tier 1.2] routing identity ter-seal (nilai DB tidak lagi userId asli).
                    upsertMembership(prisma as unknown as MembershipPrisma, {
                        userId: targetId, conversationId, deliveryToken: targetToken
                    }).catch((e: unknown) => console.warn('[OpaqueMailbox] Failed to upsert UserHiddenConversation:', e));
                }
            }
        }));
    }

    // PUSH NOTIFICATIONS DEFERRED FOR OPAQUE MAILBOX
    // Push payloads are now handled completely separately by the client directly calling a new push endpoint,
    // or we omit it here since the server doesn't know the participants.
  } catch (error) {
    next(error)
  }
})

// ==========================================
// 4. DELETE MESSAGE (FILE CLEANUP ONLY)
// ==========================================
router.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id
    const messageId = req.params.id
    const r2Key = req.query.r2Key ? String(req.query.r2Key) : undefined
    const deleteToken = req.headers['x-delete-token']

    // OPAQUE MAILBOX: Blind authorization check
    const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { deleteSecret: true }
    }) as { deleteSecret: string | null } | null;

    if (!message) {
        return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.deleteSecret) {
        return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Message cannot be deleted (no delete secret)' });
    }
    // [docs/28 Tier 0 — D3] deleteSecret tersimpan sebagai hash; dual-mode agar
    // pesan lama (plaintext) tetap bisa dihapus.
    if (!credentialTokenMatches(message.deleteSecret, typeof deleteToken === 'string' ? deleteToken : '')) {
        return res.status(403).json({ error: 'BLIND_AUTH_REQUIRED: Invalid X-Delete-Token' });
    }

    // Dalam E2EE, server mungkin sudah menghapus pesannya dari DB (Kadaluarsa otomatis).
    // Jika pesan masih ada, kita hapus secara eksplisit.
    try {
      if (message) {
        await prisma.message.delete({ where: { id: messageId } });
      }
    } catch (e) {
      console.error('[Messages] Failed to delete message:', e);
    }

    // Tugas utama rute ini sekarang HANYA menghapus file fisik di Cloudflare R2.
    if (r2Key) {
       const safeR2Key = r2Key.replace(/[^a-zA-Z0-9_\-\./]/g, '').substring(0, 255);
       const parts = safeR2Key.split('/');
       const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
       if (!filename) return res.status(400).json({ error: 'Invalid file key' });

       // Keamanan sederhana: Pastikan user hanya menghapus file miliknya
       if (!filename.startsWith(`${userId}-`)) {
          console.warn('[Security] User', sanitizeForLog(userId), 'attempted to delete unauthorized file:', sanitizeForLog(safeR2Key));
          return res.status(403).json({ error: 'Unauthorized file deletion' });
       } else {
          console.log('[R2] Deleting blind attachment:', sanitizeForLog(safeR2Key));
          try {
             await deleteR2File(safeR2Key);
          } catch (err) {
             const errorMessage = err instanceof Error ? err.message : String(err);
             console.error('[R2] Failed to delete blind file:', sanitizeForLog(safeR2Key), ':', sanitizeForLog(errorMessage));
             return res.status(500).json({ error: 'Failed to delete file from storage' });
          }
       }
    }

    // Beritahu sukses, tidak peduli apakah pesan ada di DB server atau tidak
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router