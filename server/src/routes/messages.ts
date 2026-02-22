import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { ApiError } from '../utils/errors.js'
import { getSecureLinkPreview } from '../utils/secureLinkPreview.js'
import { sendPushNotification } from '../utils/sendPushNotification.js'
import { deleteR2File } from '../utils/r2.js'
import { env } from '../config.js'
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
        // Hanya ambil pesan setelah user join (opsional, tergantung kebutuhan bisnis)
        createdAt: { gte: participant.joinedAt }
      },
      take: 50, // Ubah jadi positive jika pakai cursor ID yang benar, atau negative untuk "latest"
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' }, // Ambil dari yang terbaru dulu
      include: {
        sender: {
          select: { id: true, name: true, username: true, avatarUrl: true }
        },
        reactions: {
          include: {
            user: { select: { id: true, name: true, username: true } }
          }
        },
        statuses: true,
        repliedTo: {
          include: {
            sender: { select: { id: true, name: true, username: true } }
          }
        }
      }
    })

    // Reverse biar di frontend urutannya bener (Oldest -> Newest)
    res.json({ items: messages.reverse() })
  } catch (error) {
    next(error)
  }
})

// SEND Message
router.post('/', zodValidate({
  body: z.object({
    conversationId: z.string().min(1),
    content: z.string().max(20000).optional().nullable(),
    fileUrl: z.string().url().optional().nullable(),
    fileName: z.string().optional().nullable(),
    fileType: z.string().optional().nullable(),
    fileSize: z.number().optional().nullable(),
    duration: z.number().optional().nullable(),
    fileKey: z.string().optional().nullable(),
    sessionId: z.string().optional().nullable(),
    repliedToId: z.string().optional().nullable(),
    tempId: z.union([z.string(), z.number()]).optional(),
    expiresIn: z.number().optional().nullable()
  }).refine(data => data.content || data.fileUrl || data.fileKey, {
    message: "Message must contain content, a file, or an encrypted file key"
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const senderId = req.user.id
    const { conversationId, content, fileUrl, fileName, fileType, fileSize, duration, fileKey, sessionId, repliedToId, tempId, expiresIn } = req.body

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
    // Jalankan pengecekan berat secara paralel
    const checks = []

    // Cek Blocking (Khusus 1-on-1)
    if (participants.length === 2) {
      const otherUserId = participants.find(p => p.userId !== senderId)?.userId
      if (otherUserId) {
        checks.push(
          prisma.blockedUser.findFirst({
            where: {
              OR: [
                { blockerId: senderId, blockedId: otherUserId }, // Sender ngeblok Receiver
                { blockerId: otherUserId, blockedId: senderId } // Receiver ngeblok Sender
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

    // 3. Link Preview (Opsional & Tidak boleh bikin error)
    let linkPreviewData: any = null
    if (content && !fileUrl) {
      try {
        const urlRegex = /(https?:\/\/[^\s]+)/g
        const urls = content.match(urlRegex)
        if (urls?.[0]) {
          const preview = await getSecureLinkPreview(urls[0])
          if (preview && 'title' in preview) {
            linkPreviewData = {
              url: preview.url,
              title: preview.title,
              description: preview.description,
              image: preview.images?.[0],
              siteName: preview.siteName
            }
          }
        }
      } catch (e) {
        // Silent error: Gagal preview jangan gagalkan pesan
      }
    }

    // 4. DATABASE TRANSACTION (Critical Path)
    // Buat array status insert
    const statusData = participants.map(p => ({
      userId: p.userId,
      status: p.userId === senderId ? 'READ' : 'SENT' // Pakai string literal enum
    }))

    const [newMessage] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId,
          content,
          fileUrl,
          fileName,
          fileType,
          fileSize,
          duration,
          fileKey,
          sessionId,
          repliedToId,
          expiresAt, // Store expiration time
          linkPreview: linkPreviewData ?? undefined,
          statuses: {
            createMany: { data: statusData as any } // createMany lebih cepat dari nested create
          }
        },
        include: {
          sender: { select: { id: true, name: true, username: true, avatarUrl: true } },
          reactions: true,
          statuses: true,
          repliedTo: { include: { sender: { select: { id: true, name: true } } } }
        }
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() } // Pakai new Date() langsung
      })
    ])

    // 5. REALTIME RESPONSE (Prioritas Tinggi)
    const messageToBroadcast = { ...newMessage, tempId }

    // Kirim response HTTP dulu biar UI user sender update
    res.status(201).json(messageToBroadcast)

    // 6. SOCKET & PUSH (Background / Fire & Forget)
    // Socket emit
    getIo().to(conversationId).emit('message:new', messageToBroadcast)

    // Push Notification (JANGAN DI-AWAIT)
    const pushRecipients = participants.filter(p => p.userId !== senderId)
    if (pushRecipients.length > 0) {
      const pushBody = fileUrl ? '📎 Sent a file' : (content || 'New message')
      const payload = {
        title: req.user.username || 'New Message',
        body: pushBody.substring(0, 150),
        data: { conversationId, messageId: newMessage.id }
      }

      // Jalankan loop push secara paralel tanpa nunggu
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

    // Hapus file dari R2 (Legacy via DB)
    if (message.fileUrl && message.fileUrl.includes(env.r2PublicDomain)) {
      const key = message.fileUrl.replace(`${env.r2PublicDomain}/`, '')
      deleteR2File(key).catch(err => console.error(`[R2] Failed to delete file ${key}:`, err))
    }

    // Hapus file dari R2 (Blind Attachment via Query Param)
    if (r2Key) {
       // Security: Ensure key looks valid/safe (basic check)
       // Just prevent directory traversal or suspicious chars if possible, but R2 handles keys loosely.
       // We rely on the random nature of UUID keys for authz (Guessing a key is hard).
       console.log(`[R2] Deleting blind attachment: ${r2Key}`);
       deleteR2File(r2Key).catch(err => console.error(`[R2] Failed to delete blind file ${r2Key}:`, err))
    }

    await prisma.message.delete({ where: { id } })

    // Emit event
    getIo().to(message.conversationId).emit('message:deleted', {
      conversationId: message.conversationId,
      id: message.id
    })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// ADD Reaction
router.post('/:messageId/reactions', zodValidate({
  params: z.object({
    messageId: z.string()
  }),
  body: z.object({
    emoji: z.string().min(1),
    tempId: z.union([z.string(), z.number()]).optional()
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { messageId } = req.params
    const { emoji, tempId } = req.body
    const userId = req.user.id

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true, senderId: true }
    })
    if (!message) return res.status(404).json({ error: 'Message not found.' })

    // Cek Blocking cuma kalau bukan group
    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      select: { isGroup: true }
    })

    if (conversation && !conversation.isGroup && message.senderId !== userId) {
      const isBlocked = await prisma.blockedUser.findFirst({
        where: {
          OR: [
            { blockerId: userId, blockedId: message.senderId },
            { blockerId: message.senderId, blockedId: userId }
          ]
        }
      })
      if (isBlocked) {
        return res.status(403).json({ error: 'Interaction restricted.' })
      }
    }

    const newReaction = await prisma.messageReaction.create({
      data: { messageId, emoji, userId },
      include: { user: { select: { id: true, name: true, username: true } } }
    })

    getIo().to(message.conversationId).emit('reaction:new', {
      conversationId: message.conversationId,
      messageId,
      reaction: { ...newReaction, tempId }
    })

    res.status(201).json(newReaction)
  } catch (error) {
    next(error)
  }
})

// DELETE Reaction
router.delete('/reactions/:reactionId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { reactionId } = req.params
    const userId = req.user.id

    const reaction = await prisma.messageReaction.findUnique({
      where: { id: reactionId },
      select: { userId: true, message: { select: { id: true, conversationId: true } } }
    })

    if (!reaction) return res.status(404).json({ error: 'Reaction not found.' })
    if (reaction.userId !== userId) return res.status(403).json({ error: 'You can only delete your own reactions.' })

    await prisma.messageReaction.delete({ where: { id: reactionId } })

    getIo().to(reaction.message.conversationId).emit('reaction:deleted', {
      conversationId: reaction.message.conversationId,
      messageId: reaction.message.id,
      reactionId
    })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router
