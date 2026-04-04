// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { Prisma, DeliveryStatus } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { asConversationId, asUserId, type ConversationId, type User } from '@nyx/shared'
import { toConversation, toParticipant } from '../utils/mappers.js';
import { rotateAndDistributeSessionKeys } from '../utils/sessionKeys.js'
import { ApiError } from '../utils/errors.js'
import { redisClient } from '../lib/redis.js'

const router: Router = Router()
router.use(requireAuth)

const MAX_GROUP_MEMBERS = 100 // Batasi member maksimal biar server gak meledak

// GET all conversations for the current user
router.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id

    const conversationsData = await prisma.conversation.findMany({
      where: {
        participants: { some: { userId } },
        hiddenBy: { none: { userId } }
      },
      include: {
        participants: {
          select: {
            user: { select: { id: true, encryptedProfile: true, publicKey: true, signingKey: true } },
            id: true,
            userId: true,
            isPinned: true,
            role: true,
            joinedAt: true // ✅ Sudah benar
          }
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: { id: true, encryptedProfile: true, publicKey: true, signingKey: true } } }
        },
        creator: { select: { id: true, publicKey: true, signingKey: true, encryptedProfile: true } }
      },
      orderBy: { lastMessageAt: 'desc' }
    })

    // Build per-conversation joinedAt map for filtering unread counts
    const joinedAtMap = new Map<string, Date>();
    for (const c of conversationsData as unknown as { id: string; participants: { userId: string; joinedAt: Date }[] }[]) {
      const myParticipant = c.participants.find(p => p.userId === userId);
      if (myParticipant) {
        joinedAtMap.set(c.id, myParticipant.joinedAt);
      }
    }

    // Build OR-based where clause: only count messages after user joined each conversation
    const unreadWhereClauses = (conversationsData as unknown as { id: string }[])
      .filter(c => joinedAtMap.has(c.id))
      .map(c => ({
        conversationId: c.id,
        createdAt: { gte: joinedAtMap.get(c.id)! },
        senderId: { not: userId },
        statuses: {
          none: {
            userId: userId,
            status: DeliveryStatus.READ // ✅ FIX: Gunakan Enum dari Prisma
          }
        }
      }));

    const unreadCountsData = unreadWhereClauses.length > 0
      ? await prisma.message.groupBy({
          by: ['conversationId'],
          where: {
            OR: unreadWhereClauses
          },
          _count: { id: true }
        })
      : [];

    // ✅ FIX: Biarkan TypeScript menyimpulkan tipe secara otomatis dan beri fallback 0
    const unreadMap = new Map(unreadCountsData.map(item => [item.conversationId, item._count?.id || 0]));

    // ✅ FIX: Hilangkan (convo: { id: string }) dan gunakan (as any) pada jembatan mapper
    const safeConversations = conversationsData.map(convo => {
      const safeConv = toConversation(convo as any);
      safeConv.unreadCount = unreadMap.get(convo.id) || 0;
      return safeConv;
    })

    res.json(safeConversations)
  } catch (error) {
    next(error)
  }
})

// CREATE a new conversation
router.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { encryptedMetadata, userIds, isGroup, initialSession } = req.body
    const creatorId = req.user.id

    if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds must be an array.' })

    const user = await prisma.user.findUnique({ where: { id: creatorId }, select: { isVerified: true } });
    const isVerified = user?.isVerified ?? false;

    if (!isVerified && isGroup) throw new ApiError(403, 'SANDBOX_GROUP_RESTRICTION: Unverified users cannot create groups.');
    if (userIds.length > MAX_GROUP_MEMBERS) return res.status(400).json({ error: `Group cannot have more than ${MAX_GROUP_MEMBERS} members.` })

    if (!isGroup) {
      const otherUserId = userIds.find((id: string) => id !== creatorId)
      if (!otherUserId) return res.status(400).json({ error: 'Another user ID is required for a private chat.' })

      const existingConversation = await prisma.conversation.findFirst({
        where: { isGroup: false, AND: [{ participants: { some: { userId: creatorId } } }, { participants: { some: { userId: otherUserId } } }] },
        include: { participants: { include: { user: true } }, creator: true }
      })

      // Bebas any
      if (existingConversation) return res.status(200).json(toConversation(existingConversation))
        
      if (!isVerified) {
          const today = new Date().toISOString().split('T')[0];
          const key = `sandbox:newchat:${creatorId}:${today}`;
          const count = await redisClient.eval("local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c", { keys: [key], arguments: ['86400'] }) as number;
          if (count > 3) throw new ApiError(429, 'SANDBOX_NEW_CHAT_LIMIT: Max 3 new conversations per day.');
      }
    }

    const allUserIds = Array.from(new Set([...userIds, creatorId]))
    let newConversation;
    try {
      newConversation = await prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: {
            encryptedMetadata: isGroup ? encryptedMetadata : null,
            isGroup,
            creatorId: isGroup ? creatorId : null,
            participants: { create: allUserIds.map((userId: string) => ({ user: { connect: { id: userId } }, role: userId === creatorId ? 'ADMIN' : 'MEMBER' })) }
          },
          include: {
            participants: { select: { id: true, userId: true, role: true, isPinned: true, user: { select: { id: true, encryptedProfile: true, publicKey: true, signingKey: true } } } },
            creator: { select: { id: true, encryptedProfile: true, publicKey: true, signingKey: true } }
          }
        })

        if (initialSession) {
          const { sessionId, initialKeys, ephemeralPublicKey } = initialSession
          if (!sessionId || !initialKeys || !ephemeralPublicKey) throw new Error('Incomplete initial session data provided.')
          const keyRecords = initialKeys.map((ik: { userId: string; key: string; }) => ({ sessionId, encryptedKey: ik.key, userId: ik.userId, conversationId: conversation.id, initiatorEphemeralKey: ephemeralPublicKey, isInitiator: ik.userId === creatorId }))
          await tx.sessionKey.createMany({ data: keyRecords })
        } else if (isGroup) {
          await rotateAndDistributeSessionKeys(conversation.id, creatorId, tx)
        }
        return conversation
      })
    } catch (dbError) {
      if (!isVerified && !isGroup) {
        const today = new Date().toISOString().split('T')[0];
        try { await redisClient.decr(`sandbox:newchat:${creatorId}:${today}`); } catch (_e) { }
      }
      throw dbError;
    }

    // MAPPING KE SAFE TYPE (Tanpa any)
    const safeConversation = toConversation(newConversation);
    
    getIo().to(allUserIds.filter(uid => uid !== creatorId)).emit('conversation:new', safeConversation)
    res.status(201).json({ ...safeConversation, unreadCount: 0 })
  } catch (error) {
    next(error)
  }
})

// GET a single conversation by ID
router.get('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, participants: { some: { userId: req.user.id } } },
      include: {
        participants: { select: { id: true, userId: true, user: { select: { id: true, encryptedProfile: true, publicKey: true, signingKey: true } }, isPinned: true, role: true } },
        creator: { select: { id: true, publicKey: true, signingKey: true, encryptedProfile: true } }
      }
    })

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    // Bebas any
    res.json(toConversation(conversation))
  } catch (error) {
    next(error)
  }
})

// UPDATE group conversation details
router.put('/:id/details', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    const { encryptedMetadata } = req.body
    const participant = await prisma.participant.findFirst({ where: { conversationId: id, userId: req.user.id } })
    if (!participant || participant.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden: You are not an admin of this group.' })

    const updatedConversation = await prisma.conversation.update({ where: { id }, data: { encryptedMetadata } })
    getIo().to(id).emit('conversation:updated', { id: asConversationId(id), encryptedMetadata: updatedConversation.encryptedMetadata ?? undefined })
    res.json(updatedConversation)
  } catch (error) {
    next(error)
  }
})

// ADD new members to a group
router.post('/:id/participants', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id: conversationId } = req.params
    const { userIds } = req.body
    const adminParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: req.user.id, role: 'ADMIN' } })
    if (!adminParticipant) return res.status(403).json({ error: 'Forbidden: You are not an admin of this group.' })
    if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds must be an array.' })

    const currentCount = await prisma.participant.count({ where: { conversationId } })
    if (currentCount + userIds.length > MAX_GROUP_MEMBERS) return res.status(400).json({ error: `Group limit reached (${MAX_GROUP_MEMBERS} members max).` })

    const newParticipantsRaw = await prisma.$transaction(async (tx) => {
      await Promise.all(userIds.map((userId: string) => tx.participant.upsert({ where: { userId_conversationId: { userId, conversationId } }, create: { userId, conversationId, joinedAt: new Date() }, update: {} })))
      await rotateAndDistributeSessionKeys(conversationId, req.user!.id, tx)
      return await tx.participant.findMany({ where: { conversationId, userId: { in: userIds } }, include: { user: { select: { id: true, encryptedProfile: true, publicKey: true, signingKey: true } } } })
    })

    const conversationRaw = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { participants: { include: { user: true } }, creator: true } })

    // MAPPING KE SAFE TYPE
    const safeParticipants = newParticipantsRaw.map(toParticipant);
    const safeConversationId = asConversationId(conversationId);

    // Casting ke unknown lalu ke expected interface socket untuk menghindari any
    getIo().to(conversationId).emit('conversation:participants_added', { 
      conversationId: safeConversationId, 
      newParticipants: safeParticipants as unknown as { id: string; role: 'ADMIN' | 'MEMBER'; user: User; isPinned: boolean }[] 
    })
    getIo().to(conversationId).emit('group:participants_changed', { conversationId: safeConversationId })
    
    if (conversationRaw) {
      const safeConv = toConversation(conversationRaw);
      safeParticipants.forEach(p => {
        // FIX: Pengecekan p.userId memastikan tipe undefined tidak masuk ke fungsi .to()
        if (p.userId) {
          getIo().to(p.userId).emit('conversation:new', safeConv)
        }
      })
    }
    
    res.status(201).json(safeParticipants)
  } catch (error) {
    next(error)
  }
})

// UPDATE a member's role
router.put('/:id/participants/:userId/role', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id: conversationId, userId: userToModifyId } = req.params
    const { role } = req.body
    if (role !== 'ADMIN' && role !== 'MEMBER') return res.status(400).json({ error: 'Invalid role specified.' })

    const adminParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: req.user.id } })
    if (!adminParticipant || adminParticipant.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden.' })
    if (req.user.id === userToModifyId) return res.status(400).json({ error: 'You cannot change your own role.' })

    const updatedParticipant = await prisma.participant.updateMany({ where: { conversationId, userId: userToModifyId }, data: { role } })
    if (updatedParticipant.count === 0) return res.status(404).json({ error: 'Participant not found.' })

    getIo().to(conversationId).emit('conversation:participant_updated', { conversationId: asConversationId(conversationId), userId: asUserId(userToModifyId), role })
    res.json({ userId: userToModifyId, role })
  } catch (error) {
    next(error)
  }
})

// REMOVE a member from a group
router.delete('/:id/participants/:userId', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id: conversationId, userId: userToRemoveId } = req.params
    const adminParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: req.user.id } })
    if (!adminParticipant || adminParticipant.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden.' })
    if (req.user.id === userToRemoveId) return res.status(400).json({ error: 'Cannot remove yourself.' })

    const result = await prisma.participant.deleteMany({
    where: { 
        userId: userToRemoveId, 
        conversationId 
    }
});

if (result.count === 0) {
    return res.status(404).json({ error: 'Participant not found in this conversation' });
}
    
    getIo().to(conversationId).emit('conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userToRemoveId) })
    getIo().to(conversationId).emit('group:participants_changed', { conversationId: asConversationId(conversationId) })
    getIo().to(userToRemoveId).emit('conversation:deleted', { id: asConversationId(conversationId) })
    
    await rotateAndDistributeSessionKeys(conversationId, req.user.id)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// LEAVE a group
router.delete('/:id/leave', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id: conversationId } = req.params
    const userId = req.user.id
    const participant = await prisma.participant.findFirst({ where: { conversationId, userId } })
    if (!participant) return res.status(404).json({ error: 'Not a member.' })

    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } })
    if (conversation?.creatorId === userId) return res.status(400).json({ error: 'Creator cannot leave.' })

    await prisma.participant.delete({ where: { userId_conversationId: { userId, conversationId } } })
    
    getIo().to(conversationId).emit('conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) })
    getIo().to(conversationId).emit('group:participants_changed', { conversationId: asConversationId(conversationId) })
    getIo().to(userId).emit('conversation:deleted', { id: asConversationId(conversationId) })

    const remainingAdmin = await prisma.participant.findFirst({ where: { conversationId, role: 'ADMIN', userId: { not: userId } } })
    if (remainingAdmin) await rotateAndDistributeSessionKeys(conversationId, remainingAdmin.userId)
    
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// DELETE a conversation
router.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    const userId = req.user.id
    const conversation = await prisma.conversation.findUnique({ where: { id }, include: { participants: { select: { userId: true } } } })
    if (!conversation || !conversation.participants.some(p => p.userId === userId)) return res.status(404).json({ error: 'Not found or not participant.' })

    if (conversation.isGroup) {
      if (conversation.creatorId !== userId) return res.status(403).json({ error: 'Only creator can delete.' })
      await prisma.conversation.delete({ where: { id } })
      getIo().to(conversation.participants.map(p => p.userId)).emit('conversation:deleted', { id: asConversationId(id) })
    } else {
      await prisma.userHiddenConversation.create({ data: { userId, conversationId: id } })
      getIo().to(userId).emit('conversation:deleted', { id: asConversationId(id) })
    }
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// Toggle pin status
router.post('/:id/pin', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id: conversationId } = req.params
    const userId = req.user.id
    const participant = await prisma.participant.findUnique({ where: { userId_conversationId: { userId, conversationId } } })
    if (!participant) return res.status(404).json({ error: 'Not a participant.' })

    const updatedParticipant = await prisma.participant.update({
      where: { userId_conversationId: { userId, conversationId } },
      data: { isPinned: !participant.isPinned }
    })
    res.json({ isPinned: updatedParticipant.isPinned })
  } catch (error) {
    next(error)
  }
})

// Record key rotation event
router.post('/:id/key-rotation', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id: conversationId } = req.params
    const participant = await prisma.participant.findFirst({ where: { conversationId, userId: req.user!.id } })
    if (!participant) return res.status(404).json({ error: "Not a participant" })

    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
    })

    // Bebas any
    res.json({ success: true, message: 'Key rotation recorded successfully', conversation: toConversation(updatedConversation) })
  } catch (error) {
    next(error)
  }
})

export default router