// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { asConversationId, asMessageId } from '@nyx/shared'
import { toRawServerMessage } from '../utils/mappers.js'
import { ApiError } from '../utils/errors.js'
import { sendPushNotification } from '../utils/sendPushNotification.js'
import { deleteR2File } from '../utils/r2.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'
import { sanitizeForLog } from '../utils/logger.js'

const router: Router = Router()
router.use(requireAuth)

// Helper untuk menyuntikkan properti 'repliedToId' yang hilang dari DB (karena E2EE refactor)
// agar kompatibel dengan toRawServerMessage mapper.
const ensureLegacyMessageFields = <T extends Record<string, unknown>>(msg: T) => ({
  ...msg,
  repliedToId: null // Relasi DB sudah diputus, jadi selalu null dari server
});

// ==========================================
// 1. GET PENDING MESSAGES (Offline Catch-up)
// ==========================================
router.get('/:conversationId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const userId = req.user.id

    // Validasi member grup
    const participant = await prisma.participant.findUnique({
      where: { userId_conversationId: { userId, conversationId } }
    })
    if (!participant) return res.status(403).json({ error: 'You are not a member of this conversation.' })

    // AMBIL PESAN TERTUNDA (Hanya pesan setelah user join)
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        createdAt: { gte: participant.joinedAt }
      },
      take: 100, // Ambil cukup banyak untuk offline catch-up
      orderBy: { createdAt: 'desc' }, 
      include: {
        sender: { select: { id: true, encryptedProfile: true } },
        statuses: true // Biarkan untuk kompatibilitas tipe balikan (meskipun isinya mungkin kosong)
      }
    })

    // FIX 1: Suntikkan null untuk repliedToId agar TS tidak error
    const safeMessages = messages.map(msg => toRawServerMessage(ensureLegacyMessageFields(msg)));
    
    // Reverse biar di frontend urutannya bener (Oldest -> Newest)
    res.json({ items: safeMessages.reverse() })
  } catch (error) {
    next(error)
  }
})

// ==========================================
// 2. GET CONTEXT (OBSOLETE IN E2EE)
// ==========================================
router.get('/context/:id', requireAuth, async (req, res) => {
  // Dalam arsitektur Zero-Knowledge Store-and-Forward, 
  // server tidak punya histori pesan. Frontend harus mencarinya di IndexedDB lokal.
  // Kita kembalikan array kosong agar aplikasi tidak crash.
  res.json({ items: [], conversationId: null });
});

// ==========================================
// 3. SEND MESSAGE (Store & Forward Courier)
// ==========================================
router.post('/', zodValidate({
  body: z.object({
    conversationId: z.string().min(1),
    content: z.string().max(20000).optional().nullable(),
    sessionId: z.string().optional().nullable(),
    tempId: z.union([z.string(), z.number()]).optional(),
    expiresIn: z.number().optional().nullable(),
    isViewOnce: z.boolean().optional()
    // repliedToId dihapus validasinya karena relasi DB sudah diputus
  }).refine(data => data.content, { message: "Message must contain content" })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const senderId = req.user.id
    const { conversationId, content, sessionId, tempId, expiresIn, isViewOnce } = req.body

    const participants = await prisma.participant.findMany({
      where: { conversationId },
      select: { userId: true } 
    })

    if (!participants.some(p => p.userId === senderId)) {
      return res.status(403).json({ error: 'You are not a participant.' })
    }

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
          senderId,
          content,
          sessionId: sessionId || null,
          expiresAt: finalExpiresAt, 
          isViewOnce: isViewOnce === true
          // Kita TIDAK menyimpan statuses: { createMany: ... } lagi,
          // biarkan Socket.IO (message:status_updated) yang menangani centang biru
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

    // EMIT & PUSH NOTIFICATION
    getIo().to(conversationId).emit('message:new', safeMessage)

    const pushRecipients = participants.filter(p => p.userId !== senderId)
    if (pushRecipients.length > 0) {
      const payload = {
        data: { conversationId, messageId: safeMessage.id }
      }
      Promise.all(pushRecipients.map(p => sendPushNotification(p.userId, payload))).catch(err => console.error('[Push] Failed:', err))
    }
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
    const r2Key = req.query.r2Key as string | undefined

    // Dalam E2EE, server mungkin sudah menghapus pesannya dari DB (Kadaluarsa otomatis).
    // Jika pesan masih ada, kita hapus secara eksplisit.
    try {
      await prisma.message.delete({ where: { id: messageId, senderId: userId } });
    } catch (_e) {
      // Abaikan error jika pesan sudah tidak ada atau bukan milik user
    }

    // Tugas utama rute ini sekarang HANYA menghapus file fisik di Cloudflare R2.
    if (r2Key) {
       const safeR2Key = r2Key.replace(/[^a-zA-Z0-9_\-\./]/g, '').substring(0, 255);
       const parts = safeR2Key.split('/');
       const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];

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

// ==========================================
// 5. VIEW ONCE MESSAGE (OBSOLETE)
// ==========================================
router.put('/:id/viewed', async (req, res) => {
  // Dalam E2EE, pesan isViewOnce langsung dihancurkan saat dibaca.
  // Sinyal "Viewed" dikirim melalui payload E2EE silent message.
  // Rute HTTP ini bisa dibiarkan kosong dengan respon sukses palsu.
  res.json({ success: true, message: "E2EE Tombstone Processed" });
});

export default router