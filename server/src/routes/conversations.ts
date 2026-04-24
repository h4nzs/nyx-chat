// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { DeliveryStatus } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js'
import { getIo } from '../socket.js'
import { asConversationId, asUserId, type User, ConversationSchema, ParticipantSchema } from '@nyx/shared'
import { toConversation, toParticipant } from '../utils/mappers.js';
import { relaySessionKeys } from '../utils/sessionKeys.js'
import { ApiError } from '../utils/errors.js'
import { zodValidate } from '../utils/validate.js'
import { redisClient } from '../lib/redis.js'
import { Buffer } from 'buffer';
import { z } from 'zod';

const router: Router = Router()
router.use(requireAuth)

const MAX_GROUP_MEMBERS = 100 

// ✅ Selector Type-Safe untuk mengambil Kunci dari Perangkat Aktif
const userSelectWithKeys = {
  id: true,
  encryptedProfile: true,
  devices: { select: { id: true, publicKey: true, pqPublicKey: true, signingKey: true }, orderBy: { lastActiveAt: 'desc' as const } }
};

// Type Definitions
type UserWithDevices = { id: string, encryptedProfile: string | null, devices?: { id: string, publicKey: string | Uint8Array, pqPublicKey?: string | Uint8Array | null, signingKey: string | Uint8Array }[] };
type ParticipantWithUser = { id: string, userId: string, isPinned: boolean, role: string, joinedAt: Date, user: UserWithDevices };
type MessageWithSender = { sender: UserWithDevices };
type RawConversationData = {
  id: string;
  isGroup: boolean;
  creatorId: string | null;
  encryptedMetadata: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  creator: UserWithDevices | null;
  participants: ParticipantWithUser[];
  messages?: MessageWithSender[];
};

// ✅ Helper type-safe untuk menyuntikkan Kunci dari Device ke Root Object User agar kompatibel dengan toConversation Mapper
const hoistKeys = (u: UserWithDevices | null) => {
  if (!u) return u;
  const result: Record<string, unknown> = { ...u };
  if (u.devices && u.devices.length > 0) {
    result.devices = u.devices.map(d => ({
      id: d.id,
      publicKey: Buffer.isBuffer(d.publicKey) || d.publicKey instanceof Uint8Array ? Buffer.from(d.publicKey).toString('base64url') : d.publicKey,
      pqPublicKey: d.pqPublicKey ? (Buffer.isBuffer(d.pqPublicKey) || d.pqPublicKey instanceof Uint8Array ? Buffer.from(d.pqPublicKey).toString('base64url') : d.pqPublicKey) : null,
      signingKey: Buffer.isBuffer(d.signingKey) || d.signingKey instanceof Uint8Array ? Buffer.from(d.signingKey).toString('base64url') : d.signingKey
    }));

    // Keep top-level keys for backward compatibility (uses the first active device)
    const pk = u.devices[0].publicKey;
    const pqk = u.devices[0].pqPublicKey;
    const sk = u.devices[0].signingKey;
    result.publicKey = Buffer.isBuffer(pk) || pk instanceof Uint8Array ? Buffer.from(pk).toString('base64url') : pk;
    result.pqPublicKey = pqk ? (Buffer.isBuffer(pqk) || pqk instanceof Uint8Array ? Buffer.from(pqk).toString('base64url') : pqk) : null;
    result.signingKey = Buffer.isBuffer(sk) || sk instanceof Uint8Array ? Buffer.from(sk).toString('base64url') : sk;
  }
  return result;
};
const hoistConvoKeys = (c: RawConversationData) => {
  const result: Record<string, unknown> = { ...c };
  if (c.creator) result.creator = hoistKeys(c.creator);
  if (c.participants) {
      result.participants = c.participants.map(p => ({ ...p, user: hoistKeys(p.user) }));
  }
  if (c.messages) {
      result.messages = c.messages.map(m => ({ ...m, sender: hoistKeys(m.sender) }));
  }
  return result as unknown as Parameters<typeof toConversation>[0];
};


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
            user: { select: userSelectWithKeys },
            id: true,
            userId: true,
            isPinned: true,
            role: true,
            joinedAt: true 
          }
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: userSelectWithKeys } }
        },
        creator: { select: userSelectWithKeys }
      },
      orderBy: { lastMessageAt: 'desc' }
    });

    const joinedAtMap = new Map<string, Date>();
    for (const c of conversationsData) {
      const myParticipant = c.participants.find(p => p.userId === userId);
      if (myParticipant) {
        joinedAtMap.set(c.id, myParticipant.joinedAt);
      }
    }

    const unreadWhereClauses = conversationsData
      .filter(c => joinedAtMap.has(c.id))
      .map(c => ({
        conversationId: c.id,
        createdAt: { gte: joinedAtMap.get(c.id)! },
        senderId: { not: userId },
        statuses: {
          none: {
            userId: userId,
            status: DeliveryStatus.READ 
          }
        }
      }));

    const unreadCountsData = unreadWhereClauses.length > 0
      ? await prisma.message.groupBy({
          by: ['conversationId'],
          where: { OR: unreadWhereClauses },
          _count: { id: true }
        })
      : [];

    const unreadMap = new Map(unreadCountsData.map(item => [item.conversationId, item._count?.id || 0]));

    const safeConversations = conversationsData.map(convo => {
      const safeConv = toConversation(hoistConvoKeys(convo as unknown as RawConversationData));
      safeConv.unreadCount = unreadMap.get(convo.id) || 0;
      return ConversationSchema.parse(safeConv);
    })

    res.json(safeConversations)
  } catch (error) {
    next(error)
  }
})

const initialSessionSchema = z.object({
  sessionId: z.string(),
  initialKeysPerDevice: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url')),
  initiatorCiphertextsPerDevice: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url'))
}).optional()

// CREATE a new conversation
router.post(
  '/', 
  zodValidate({
    body: z.object({
      encryptedMetadata: z.string().nullable().optional(),
      userIds: z.array(z.string()),
      isGroup: z.boolean(),
      initialSession: initialSessionSchema
    })
  }),
  async (req, res, next) => {
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
      const isSelfChat = userIds.length === 1 && userIds[0] === creatorId;
      const otherUserId = isSelfChat ? creatorId : userIds.find((id: string) => id !== creatorId);
      if (!otherUserId) return res.status(400).json({ error: 'Another user ID is required for a private chat.' })

      let existingConversation = null;
      if (isSelfChat) {
          const selfChats = await prisma.conversation.findMany({
              where: { isGroup: false, participants: { some: { userId: creatorId } } },
              include: { participants: { include: { user: { select: userSelectWithKeys } } }, creator: { select: userSelectWithKeys } }
          });
          existingConversation = selfChats.find(c => c.participants.length === 1);
      } else {
          existingConversation = await prisma.conversation.findFirst({
              where: { isGroup: false, AND: [{ participants: { some: { userId: creatorId } } }, { participants: { some: { userId: otherUserId } } }] },
              include: { participants: { include: { user: { select: userSelectWithKeys } } }, creator: { select: userSelectWithKeys } }
          });
      }

      if (existingConversation) return res.status(200).json(toConversation(hoistConvoKeys(existingConversation as unknown as RawConversationData)))
        
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
            participants: { select: { id: true, userId: true, role: true, isPinned: true, user: { select: userSelectWithKeys } } },
            creator: { select: userSelectWithKeys }
          }
        })

        if (initialSession) {
          const { sessionId, initialKeys, initiatorCiphertextsPerDevice } = initialSession
          if (!sessionId || !initialKeys || !initiatorCiphertextsPerDevice) throw new Error('Incomplete initial session data provided.')

          const targetUserIds = initialKeys.map((ik: { userId: string }) => ik.userId);
          const devices = await tx.device.findMany({ where: { userId: { in: targetUserIds } }, select: { id: true, userId: true } });

          const keyRecords = [];
          for (const ik of initialKeys) {
             const userDevices = devices.filter(d => d.userId === ik.userId);
             for (const d of userDevices) {
                const deviceCiphertext = initiatorCiphertextsPerDevice[d.id];
                if (!deviceCiphertext) {
                    console.error('Missing initiator ciphertext for participant device during conversation creation');
                    throw new Error('Missing initiator ciphertext for a participant device');
                }
                keyRecords.push({
                   sessionId,
                   encryptedKey: Buffer.from(ik.key, 'base64url'),
                   deviceId: d.id,
                   conversationId: conversation.id,
                   initiatorCiphertexts: Buffer.from(deviceCiphertext, 'base64url'),
                   isInitiator: ik.userId === creatorId
                });
             }
          }          await tx.sessionKey.createMany({ data: keyRecords })        } else if (isGroup) {
          // No server-side key generation. Clients will rotate keys on membership change.
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

    const safeConversation = toConversation(hoistConvoKeys(newConversation as unknown as RawConversationData));
    
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

    getIo().to(conversationId).emit('conversation:participants_added', { 
      conversationId: safeConversationId, 
      newParticipants: safeParticipants as unknown as { id: string; role: 'ADMIN' | 'MEMBER'; user: User; isPinned: boolean }[]
    })
    getIo().to(conversationId).emit('group:participants_changed', { conversationId: safeConversationId })
    
    if (conversationRaw) {
      const safeConv = toConversation(hoistConvoKeys(conversationRaw as unknown as RawConversationData));
      safeParticipants.forEach(p => {
        if (p.userId) {
          getIo().to(p.userId).emit('conversation:new', safeConv)
        }
      })
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

    await prisma.$transaction(async (tx) => {
        const result = await tx.participant.deleteMany({
            where: { userId: userToRemoveId, conversationId }
        });

        if (result.count === 0) {
            throw new ApiError(404, 'Participant not found in this conversation');
        }

        // No server-side key generation. Remaining clients will rotate keys.
    });
    
    getIo().to(conversationId).emit('conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userToRemoveId) })
    getIo().to(conversationId).emit('group:participants_changed', { conversationId: asConversationId(conversationId) })
    getIo().to(userToRemoveId).emit('conversation:deleted', { id: asConversationId(conversationId) })

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
        const remainingAdmin = await tx.participant.findFirst({ where: { conversationId, role: 'ADMIN', userId: { not: userId } }, include: { user: { include: { devices: true } } } });
        // No server-side key generation. Remaining clients will rotate keys.
    });
    
    getIo().to(conversationId).emit('conversation:participant_removed', { conversationId: asConversationId(conversationId), userId: asUserId(userId) })
    getIo().to(conversationId).emit('group:participants_changed', { conversationId: asConversationId(conversationId) })
    getIo().to(userId).emit('conversation:deleted', { id: asConversationId(conversationId) })
    
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

    const safeConv = toConversation(hoistConvoKeys(updatedConversation as unknown as RawConversationData));
    res.json({ success: true, message: 'Key rotation recorded successfully', conversation: safeConv })
  } catch (error) {
    next(error)
  }
})

export default router