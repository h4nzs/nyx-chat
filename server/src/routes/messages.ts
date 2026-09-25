// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { sendJsonToUser } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { asConversationId, asMessageId } from '@nyx/shared'
import { toRawServerMessage } from '../utils/mappers.js'
import { ApiError } from '../utils/errors.js'
import { sendPushNotification } from '../utils/sendPushNotification.js'
import { deleteR2File } from '../utils/r2.js'
import { z } from 'zod'
import { zodValidate, safeEqualStrings } from '../utils/validate.js'
import { sanitizeForLog } from '../utils/logger.js'

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

    // Validasi & clamp cursor: harus ISO date yang masih dalam window retensi.
    // Cursor lebih tua dari 14 hari di-clamp — pesan lebih tua dari itu sudah
    // dihapus sweeper, jadi meng-query lebih jauh hanya membuang index scan.
    let beforeDate: Date | null = null;
    const beforeRaw = typeof req.query.before === 'string' ? req.query.before : '';
    if (beforeRaw) {
      const parsed = new Date(beforeRaw);
      if (!isNaN(parsed.getTime())) {
        beforeDate = parsed.getTime() < fourteenDaysAgo.getTime() ? fourteenDaysAgo : parsed;
      }
    }
    // Clamp jumlah juga (limit param legacy dari client lama, di-cap ke ukuran halaman).
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
    const take = Math.min(!isNaN(limitRaw) && limitRaw > 0 ? limitRaw : CATCH_UP_PAGE_SIZE, CATCH_UP_PAGE_SIZE);

    const messageWhere = {
      conversationId,
      createdAt: beforeDate
        ? { gt: fourteenDaysAgo, lt: beforeDate }
        : { gt: fourteenDaysAgo },
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
      orderBy: { createdAt: 'desc' }, 
      include: {
        sender: { select: { id: true, encryptedProfile: true } },
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
        createdAt: beforeDate
          ? { gt: fourteenDaysAgo, lt: beforeDate }
          : { gt: fourteenDaysAgo },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        sender: { select: { id: true, encryptedProfile: true } },
        statuses: true
      }
    })

    // AMBIL PESAN SYSTEM PERTAMA
    const firstSystemMessage = await prisma.message.findFirst({
      where: {
        conversationId,
        type: 'SYSTEM',
        createdAt: beforeDate
          ? { gt: fourteenDaysAgo, lt: beforeDate }
          : { gt: fourteenDaysAgo },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      orderBy: { createdAt: 'asc' },
      include: {
        sender: { select: { id: true, encryptedProfile: true } },
        statuses: true
      }
    })

    // Gabungkan pesan normal dan pesan system (tanpa duplikasi)
    const allMessagesMap = new Map();
    [...page, ...systemMessagesDesc].forEach(msg => allMessagesMap.set(msg.id, msg));
    if (firstSystemMessage) allMessagesMap.set(firstSystemMessage.id, firstSystemMessage);
    
    const mergedMessages = Array.from(allMessagesMap.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // FIX 1: Suntikkan null untuk repliedToId agar TS tidak error
    const safeMessages = mergedMessages.map(msg => toRawServerMessage(ensureLegacyMessageFields(msg)));
    
    // Reverse biar di frontend urutannya bener (Oldest -> Newest)
    const items = safeMessages.reverse();

    // Cursor berikutnya = createdAt pesan USER tertua di halaman ini (bukan
    // system, yang di-include penuh tiap halaman agar tidak pernah bolong).
    const oldestUserMessage = page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = hasMore && oldestUserMessage
      ? (oldestUserMessage.createdAt instanceof Date
          ? oldestUserMessage.createdAt.toISOString()
          : new Date(oldestUserMessage.createdAt).toISOString())
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
    targetRecipients: z.array(z.string()).max(500).optional()
    // repliedToId dihapus validasinya karena relasi DB sudah diputus
  }).refine(data => data.content, { message: "Message must contain content" })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const senderId = req.user.id
    const { conversationId, content, sessionId, tempId, expiresIn, isViewOnce } = req.body

    // HITUNG TTL (Umur Pesan di Server)
    // Jika tidak ada expiresIn, set otomatis dihancurkan dalam 14 Hari (Store-and-Forward rules)
    const defaultTTL = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); 
    const finalExpiresAt = (expiresIn && typeof expiresIn === 'number' && expiresIn > 0)
        ? new Date(Date.now() + expiresIn * 1000)
        : defaultTTL;

    // SIMPAN KE "KANTOR POS" SEMENTARA
    const [newMessageRaw] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId: null,
          content,
          sessionId: sessionId || null,
          expiresAt: finalExpiresAt,
          isViewOnce: isViewOnce === true
        },
        include: {
          sender: { select: { id: true, encryptedProfile: true } },
          statuses: true
        }
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() }
      })
    ])

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
                prisma.userHiddenConversation.upsert({
                    where: { userId_conversationId: { userId: targetId, conversationId } },
                    create: { userId: targetId, conversationId },
                    update: {}
                }).catch((e: unknown) => console.warn('[OpaqueMailbox] Failed to upsert UserHiddenConversation:', e));
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
    if (!safeEqualStrings(message.deleteSecret, typeof deleteToken === 'string' ? deleteToken : '')) {
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