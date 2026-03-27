// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { asConversationId, asMessageId } from '@nyx/shared'
import { toRawServerMessage } from '../utils/mappers.js'
import { ApiError } from '../utils/errors.js'
import { sendPushNotification } from '../utils/sendPushNotification.js'
import { deleteR2File } from '../utils/r2.js'
import { z } from 'zod'
import { zodValidate } from '../utils/validate.js'

const router: Router = Router()
router.use(requireAuth)

// GET Messages
router.get('/:conversationId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { conversationId } = req.params
    const userId = req.user.id
    const cursor = req.query.cursor as string | undefined

    // Cek participant
    const participant = await prisma.participant.findUnique({
      where: {
        userId_conversationId: {
          userId,
          conversationId
        }
      }
    })

    if (!participant) return res.status(403).json({ error: 'You are not a member of this conversation.' })

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        // Hanya ambil pesan setelah user join
        createdAt: { gte: participant.joinedAt }
      },
      take: 50, // Ubah jadi positive jika pakai cursor ID yang benar, atau negative untuk "latest"
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' }, // Ambil dari yang terbaru dulu
      include: {
        sender: {
          select: { id: true, encryptedProfile: true }
        },
        statuses: true,
        repliedTo: {
          include: {
            sender: { select: { id: true, encryptedProfile: true } }
          }
        }
      }
    })

    // MAPPING KE SAFE TYPE (Bebas dari any)
    const safeMessages = messages.map(toRawServerMessage);

    // Reverse biar di frontend urutannya bener (Oldest -> Newest)
    res.json({ items: safeMessages.reverse() })
  } catch (error) {
    next(error)
  }
})

// GET Context (Surrounding Messages)
router.get('/context/:id', requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.id as string;

    // Get the target message first to find its timestamp and conversationId
    const targetMsg = await prisma.message.findUnique({
      where: { id: targetId },
      include: { sender: { select: { id: true, encryptedProfile: true } }, repliedTo: { include: { sender: { select: { id: true, encryptedProfile: true } } } }, statuses: true }
    });

    if (!targetMsg) {
      throw new ApiError(404, 'Message not found');
    }

    // Verify participation
    const participation = await prisma.participant.findUnique({
      where: { userId_conversationId: { userId: req.user!.id, conversationId: targetMsg.conversationId } }
    });
    if (!participation) throw new ApiError(403, 'Not a participant');

    // Fetch older messages (before target)
    const older = await prisma.message.findMany({
      where: { conversationId: targetMsg.conversationId, createdAt: { lt: targetMsg.createdAt, gte: participation.joinedAt } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { sender: { select: { id: true, encryptedProfile: true } }, repliedTo: { include: { sender: { select: { id: true, encryptedProfile: true } } } }, statuses: true }
    });

    // Fetch newer messages (after target)
    const newer = await prisma.message.findMany({
      where: { conversationId: targetMsg.conversationId, createdAt: { gt: targetMsg.createdAt, gte: participation.joinedAt } },
      orderBy: { createdAt: 'asc' },
      take: 20,
      include: { sender: { select: { id: true, encryptedProfile: true } }, repliedTo: { include: { sender: { select: { id: true, encryptedProfile: true } } } }, statuses: true }
    });

    // Combine and sort chronologically
    const allMessagesRaw = [...older.reverse(), targetMsg, ...newer];

    // MAPPING KE SAFE TYPE
    const safeMessages = allMessagesRaw.map(toRawServerMessage);

    res.json({ items: safeMessages, conversationId: asConversationId(targetMsg.conversationId) });
  } catch (error) {
    next(error);
  }
});

// SEND Message
router.post('/', zodValidate({
  body: z.object({
    conversationId: z.string().min(1),
    content: z.string().max(20000).optional().nullable(),
    // File fields removed (Blind Attachments)
    sessionId: z.string().optional().nullable(),
    repliedToId: z.string().optional().nullable(),
    tempId: z.union([z.string(), z.number()]).optional(),
    expiresIn: z.number().optional().nullable(),
    isViewOnce: z.boolean().optional()
  }).refine(data => data.content, {
    message: "Message must contain content"
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const senderId = req.user.id
    const { conversationId, content, sessionId, repliedToId, tempId, expiresIn, isViewOnce } = req.body

    // 1. Ambil Participants
    const participants = await prisma.participant.findMany({
      where: { conversationId },
      select: { userId: true } // Select seperlunya aja biar ringan
    })

    // Calculate expiration time if provided
    let expiresAt: Date | undefined
    if (expiresIn && typeof expiresIn === 'number' && expiresIn > 0) {
      expiresAt = new Date(Date.now() + expiresIn * 1000)
    }

    if (!participants.some(p => p.userId === senderId)) {
      return res.status(403).json({ error: 'You are not a participant.' })
    }

    // 2. BLOCKING CHECK & REPLY DEPTH (Parallel)
    const checks = []

    // Cek Blocking (Khusus 1-on-1)
    if (participants.length === 2) {
      const otherUserId = participants.find(p => p.userId !== senderId)?.userId
      if (otherUserId) {
        checks.push(
          prisma.blockedUser.findFirst({
            where: {
              OR: [
                { blockerId: senderId, blockedId: otherUserId },
                { blockerId: otherUserId, blockedId: senderId }
              ]
            }
          }).then(block => {
            if (block) throw new ApiError(403, 'Messaging unavailable due to blocking.')
          })
        )
      }
    }

    // Cek Reply Depth
    if (repliedToId) {
      checks.push((async () => {
        let currentId: string | null = repliedToId
        let depth = 0
        const MAX_DEPTH = 10
        while (currentId && depth < MAX_DEPTH) {
          const parentMessage = await prisma.message.findUnique({
            where: { id: currentId },
            select: { repliedToId: true }
          })
          if (!parentMessage) break
          currentId = parentMessage.repliedToId
          depth++
        }
        if (depth >= MAX_DEPTH) throw new ApiError(400, 'Reply chain is too deep.')
      })())
    }

    // Tunggu validasi selesai
    await Promise.all(checks)

    // 4. DATABASE TRANSACTION
    const statusData: Prisma.MessageStatusCreateManyMessageInput[] = participants.map(p => ({
      userId: p.userId,
      status: p.userId === senderId ? 'READ' : 'SENT'
    }))

    const [newMessageRaw] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId,
          content,
          sessionId,
          repliedToId,
          expiresAt, 
          isViewOnce: isViewOnce === true,
          statuses: {
            createMany: { data: statusData } 
          }
        },
        include: {
          sender: { select: { id: true, encryptedProfile: true } },
          statuses: true,
          repliedTo: { include: { sender: { select: { id: true, encryptedProfile: true } } } }
        }
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() }
      })
    ])

    // MAPPING KE SAFE TYPE
    const safeMessage = toRawServerMessage(newMessageRaw);

    // Inject tempId dari client agar UI tahu pesan mana yang sudah sukses (Optimistic UI)
    if (tempId !== undefined) {
    if (typeof tempId === 'string' && /^\d+$/.test(tempId)) {
        safeMessage.tempId = parseInt(tempId, 10);
    } else if (typeof tempId === 'number') {
        safeMessage.tempId = tempId;
    }
    // Jika formatnya selain itu, tempId dibiarkan undefined / tidak di-set
}

    // Kirim response HTTP dulu biar UI user sender update
    res.status(201).json(safeMessage)

    // 6. SOCKET & PUSH
    // Emit ke socket dengan tipe yang valid
    getIo().to(conversationId).emit('message:new', safeMessage)

    // Push Notification
    const pushRecipients = participants.filter(p => p.userId !== senderId)
    if (pushRecipients.length > 0) {
      const payload = {
        data: { conversationId, messageId: safeMessage.id }
      }

      Promise.all(
        pushRecipients.map(p => sendPushNotification(p.userId, payload))
      ).catch(err => console.error('[Push] Failed:', err))
    }
  } catch (error) {
    next(error)
  }
})

// DELETE Message
router.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    const userId = req.user.id
    const r2Key = req.query.r2Key as string | undefined

    const message = await prisma.message.findUnique({ where: { id } })
    if (!message) return res.status(404).json({ error: 'Message not found' })
    if (message.senderId !== userId) return res.status(403).json({ error: 'You can only delete your own messages' })

    if (r2Key) {
       const parts = r2Key.split('/');
       const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];

       if (!filename.startsWith(`${userId}-`)) {
          console.warn('[Security] User', userId, 'attempted to delete unauthorized file:', r2Key);
       } else {
          console.log('[R2] Deleting blind attachment:', r2Key);
          deleteR2File(r2Key).catch(err => console.error('[R2] Failed to delete blind file:', r2Key, ':', err))
       }
    }

    await prisma.message.delete({ where: { id } })

    // Emit event menggunakan branded ID
    getIo().to(message.conversationId).emit('message:deleted', {
      conversationId: asConversationId(message.conversationId),
      id: asMessageId(message.id)
    })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// VIEW ONCE Message
router.put('/:id/viewed', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const messageId = req.params.id;
    const userId = req.user.id;

    const message = await prisma.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { participants: true } } } });
    if (!message || !message.isViewOnce || message.senderId === userId) return res.status(400).json({ error: 'Invalid operation' });

    const isParticipant = message.conversation.participants.some(p => p.userId === userId);
    if (!isParticipant) return res.status(403).json({ error: 'Not a participant' });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { isViewed: true }
    });

    // Notify sender and receiver dengan branded IDs
    getIo().to(message.conversationId).emit('message:viewed', { 
      messageId: asMessageId(messageId), 
      conversationId: asConversationId(message.conversationId) 
    });

    res.json(updated); // atau mapping ke format baru jika diperlukan
  } catch (error) {
    next(error);
  }
});

export default router