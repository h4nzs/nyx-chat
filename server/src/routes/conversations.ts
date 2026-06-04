// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { DeliveryStatus } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js'
import { sendJsonToUser, broadcastToConversation, broadcastToUsers, emitEventToUser, emitEventToConversation, emitEventToUsers } from '../network/redisBridge.js';
import { TransportOpCode } from '@nyx/shared';
import { asConversationId, asUserId, type User, ConversationSchema, ParticipantSchema } from '@nyx/shared'
import { toConversation, toParticipant } from '../utils/mappers.js';
import { relaySessionKeys } from '../utils/sessionKeys.js'
import { ApiError } from '../utils/errors.js'
import { zodValidate } from '../utils/validate.js'
import { z } from 'zod'
import { userSelectWithKeys, hoistKeys, hoistConvoKeys, type RawConversationData, type UserWithDevices } from '../utils/mappers.js'
import { redisClient } from '../lib/redis.js';

const router: Router = Router()
router.use(requireAuth)

// GET all conversations for the authenticated user
router.get('/', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id

    // Ambil daftar percakapan yang TIDAK disembunyikan oleh user
    const hiddenConvoIds = await prisma.userHiddenConversation.findMany({
      where: { userId },
      select: { conversationId: true }
    }).then(list => list.map(l => l.conversationId));

    const conversations = await prisma.conversation.findMany({
      where: { 
        participants: { some: { userId } },
        id: { notIn: hiddenConvoIds }
      },
      include: {
        participants: {
          select: { id: true, userId: true, user: { select: userSelectWithKeys }, isPinned: true, role: true, joinedAt: true }
        },
        creator: { select: userSelectWithKeys }
      },
      orderBy: { lastMessageAt: 'desc' }
    })

    const safeConversations = conversations.map(c => toConversation(hoistConvoKeys(c as unknown as RawConversationData)))

    // RESTORE: Logika unread berperforma tinggi (Query Tunggal)
    const unreadWhereClauses = conversations.map(c => {
      const participant = c.participants.find(p => p.userId === userId);
      return {
        conversationId: c.id,
        senderId: { not: userId },
        createdAt: { gte: participant?.joinedAt || new Date(0) },
        statuses: { none: { userId, status: DeliveryStatus.READ } }
      };
    });

    const unreadCountsData = unreadWhereClauses.length > 0 
      ? await prisma.message.groupBy({ 
          by: ['conversationId'], 
          where: { OR: unreadWhereClauses }, 
          _count: { id: true } 
        }) 
      : [];

    const unreadMap = new Map(unreadCountsData.map(item => [item.conversationId, (item._count as { id: number }).id || 0]));

    const itemsWithUnread = safeConversations.map(c => ({
      ...c,
      unreadCount: unreadMap.get(c.id) || 0
    }));

    res.json(itemsWithUnread)
  } catch (error) {
    next(error)
  }
})

// CREATE a new conversation
const initialSessionSchema = z.object({
  sessionId: z.string(),
  initialKeysPerDevice: z.record(z.string(), z.string()), // deviceId -> encrypted key
  initiatorCiphertextsPerDevice: z.record(z.string(), z.string()) // deviceId -> ciphertext
});

router.post('/', zodValidate({
  body: ConversationSchema.pick({ isGroup: true, encryptedMetadata: true }).extend({
    userIds: z.array(z.string()).min(1),
    initialSession: initialSessionSchema.optional()
  })
}), async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const creatorId = req.user.id
    const { userIds, isGroup, encryptedMetadata, initialSession } = req.body

    const today = new Date().toISOString().split('T')[0];
    const sandboxCount = await redisClient.incr(`sandbox:newchat:${creatorId}:${today}`);
    if (sandboxCount === 1) await redisClient.expire(`sandbox:newchat:${creatorId}:${today}`, 86400);

    const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { isVerified: true } });
    if (!creator?.isVerified && sandboxCount > 3) {
      return res.status(403).json({ error: 'SANDBOX_LIMIT: Unverified users can only create 3 new chats per day.' });
    }

    const allUserIds = Array.from(new Set([...userIds, creatorId]))
    
    const users = await prisma.user.findMany({
      where: { id: { in: allUserIds } },
      include: { devices: true }
    })

    if (users.length !== allUserIds.length) {
      return res.status(400).json({ error: 'One or more users not found.' })
    }

    let newConversation;
    try {
      newConversation = await prisma.$transaction(async (tx) => {
        const convo = await tx.conversation.create({
          data: {
            isGroup: isGroup === true,
            creatorId,
            encryptedMetadata: isGroup ? encryptedMetadata : null,
            participants: {
              create: allUserIds.map(uid => ({
                userId: uid,
                role: uid === creatorId ? 'ADMIN' : 'MEMBER',
                joinedAt: new Date()
              }))
            }
          },
          include: {
            participants: { select: { id: true, userId: true, user: { select: userSelectWithKeys }, isPinned: true, role: true } },
            creator: { select: userSelectWithKeys }
          }
        });

        // RESTORE: Simpan kunci awal E2EE
        if (initialSession) {
          const { sessionId, initialKeysPerDevice, initiatorCiphertextsPerDevice } = initialSession;
          const keyRecords = [];
          
          for (const deviceId in initialKeysPerDevice) {
            keyRecords.push({
              conversationId: convo.id,
              deviceId,
              sessionId,
              encryptedKey: initialKeysPerDevice[deviceId],
              initiatorCiphertext: initiatorCiphertextsPerDevice[deviceId]
            });
          }

          if (keyRecords.length > 0) {
            await tx.sessionKey.createMany({ data: keyRecords });
          }
        }

        return convo;
      });
    } catch (dbError) {
      if (!creator?.isVerified) {
        try { await redisClient.decr(`sandbox:newchat:${creatorId}:${today}`); } catch (_e) { }
      }
      throw dbError;
    }

    const safeConversation = toConversation(hoistConvoKeys(newConversation as unknown as RawConversationData));
    
    await emitEventToUsers(allUserIds.filter(uid => uid !== creatorId), 'conversation:new', safeConversation);
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
        participants: { select: { id: true, userId: true, user: { select: userSelectWithKeys }, isPinned: true, role: true } },
        creator: { select: userSelectWithKeys }
      }
    })

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    res.json(toConversation(hoistConvoKeys(conversation as unknown as RawConversationData)))
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
    await emitEventToConversation(id, 'conversation:updated', { id: asConversationId(id), encryptedMetadata: updatedConversation.encryptedMetadata ?? undefined });
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

    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { subscriptionTier: true } });
    const maxGroupMembers = user?.subscriptionTier === 'SUBSCRIBER' ? 500 : 100;

    const currentCount = await prisma.participant.count({ where: { conversationId } })
    if (currentCount + userIds.length > maxGroupMembers) return res.status(400).json({ error: `Group limit reached (${maxGroupMembers} members max).` })

    const newParticipantsRaw = await prisma.$transaction(async (tx) => {
      await Promise.all(userIds.map((userId: string) => tx.participant.upsert({ where: { userId_conversationId: { userId, conversationId } }, create: { userId, conversationId, joinedAt: new Date() }, update: {} })))
      // No server-side key generation. Clients will rotate keys on next message.
      return await tx.participant.findMany({ where: { conversationId, userId: { in: userIds } }, include: { user: { select: userSelectWithKeys } } })
    })

    const conversationRaw = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { participants: { include: { user: { select: userSelectWithKeys } } }, creator: { select: userSelectWithKeys } } })

    const safeParticipants = newParticipantsRaw.map(p => {
       const hoistedUser = hoistKeys(p.user as unknown as UserWithDevices);
       const objToMap = { ...p, user: hoistedUser };
       return toParticipant(objToMap as Parameters<typeof toParticipant>[0]);
    });
    
    const safeConversationId = asConversationId(conversationId);

    await emitEventToConversation(conversationId, 'conversation:participants_added', { 
      conversationId: safeConversationId, 
      participants: safeParticipants as unknown as { id: string; role: 'ADMIN' | 'MEMBER'; user: User; isPinned: boolean }[]
    });
    await emitEventToConversation(conversationId, 'group:participants_changed', { conversationId: safeConversationId });
    
    if (conversationRaw) {
      const safeConv = toConversation(hoistConvoKeys(conversationRaw as unknown as RawConversationData));
      for (const p of safeParticipants) {
        if (p.userId) {
          await emitEventToUser(p.userId, 'conversation:new', safeConv);
        }
      }
    }
    
    res.status(201).json(z.array(ParticipantSchema).parse(safeParticipants))
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

    await emitEventToConversation(conversationId, 'conversation:participant_updated', { conversationId: asConversationId(conversationId), userId: asUserId(userToModifyId), role });
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

    await prisma.$transaction(async (tx) => {
        const result = await tx.participant.deleteMany({
            where: { userId: userToRemoveId, conversationId }
        });

        if (result.count === 0) {
            throw new ApiError(404, 'Participant not found in this conversation');
        }

        // No server-side key generation. Remaining clients will rotate keys.
    });
    
    await emitEventToConversation(conversationId, 'conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userToRemoveId) });
    await emitEventToConversation(conversationId, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
    await emitEventToUser(userToRemoveId, 'conversation:deleted', { id: asConversationId(conversationId) });

    res.status(204).send()  } catch (error) {
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

    await prisma.$transaction(async (tx) => {
        await tx.participant.delete({ where: { userId_conversationId: { userId, conversationId } } });
        // No server-side key generation. Remaining clients will rotate keys.
    });
    
    await emitEventToConversation(conversationId, 'conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) });
    await emitEventToConversation(conversationId, 'group:participants_changed', { conversationId: asConversationId(conversationId) });
    await emitEventToUser(userId, 'conversation:deleted', { id: asConversationId(conversationId) });
    
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
      await emitEventToUsers(conversation.participants.map(p => p.userId), 'conversation:deleted', { id: asConversationId(id) });
    } else {
      await prisma.userHiddenConversation.create({ data: { userId, conversationId: id } })
      await emitEventToUser(userId, 'conversation:deleted', { id: asConversationId(id) });
    }
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// TOGGLE pin conversation (Me)
router.post('/:id/pin', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const userId = req.user.id
    const { id: conversationId } = req.params

    const participant = await prisma.participant.findUnique({
      where: { userId_conversationId: { userId, conversationId } }
    })

    if (!participant) return res.status(404).json({ error: 'Participant not found' })

    const updated = await prisma.participant.update({
      where: { id: participant.id },
      data: { isPinned: !participant.isPinned }
    })

    res.json({ isPinned: updated.isPinned })
  } catch (error) { next(error) }
})

// ROTATE group key (Update updatedAt)
router.post('/:id/key-rotation', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'Authentication required.')
    const { id } = req.params
    // Verify participant
    const p = await prisma.participant.findFirst({ where: { conversationId: id, userId: req.user.id } });
    if (!p) throw new ApiError(403, 'Forbidden');

    const updatedConversation = await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() },
      include: {
        participants: {
          select: { id: true, userId: true, user: { select: userSelectWithKeys }, isPinned: true, role: true, joinedAt: true }
        },
        creator: { select: userSelectWithKeys }
      }
    })

    const safeConv = toConversation(hoistConvoKeys(updatedConversation as unknown as RawConversationData));
    res.json({ 
        success: true, 
        message: 'Key rotation recorded successfully', 
        conversation: safeConv 
    })
  } catch (error) { next(error) }
})

export default router
