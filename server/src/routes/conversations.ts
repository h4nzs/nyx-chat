import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { getIo } from "../socket.js";
import { rotateAndDistributeSessionKeys } from "../utils/sessionKeys.js";
import { ApiError } from "../utils/errors.js";
import { uploadToSupabase, deleteFromSupabase } from "../utils/supabase.js";
import { nanoid } from "nanoid";
import path from "path";

const router: Router = Router();
router.use(requireAuth);

const MAX_GROUP_MEMBERS = 100; // Batasi member maksimal biar server gak meledak

// GET all conversations for the current user
router.get("/", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const userId = req.user.id;

    const conversationsData = await prisma.conversation.findMany({
      where: {
        participants: { some: { userId: userId } },
        hiddenBy: { none: { userId: userId } },
      },
      include: {
        participants: {
          select: {
            user: {
              select: { id: true, username: true, name: true, avatarUrl: true, description: true, publicKey: true },
            },
            isPinned: true,
            role: true,
          },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { sender: true },
        },
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: {
        lastMessageAt: "desc",
      },
    });

    const unreadCounts: { conversationId: string; unreadCount: number }[] = await prisma.$queryRaw`
      SELECT
        p."conversationId" AS "conversationId",
        COUNT(m.id)::int AS "unreadCount"
      FROM "Participant" p
      LEFT JOIN "Message" last_read_message ON p."lastReadMsgId" = last_read_message.id
      JOIN "Message" m ON m."conversationId" = p."conversationId"
      WHERE
        p."userId" = ${userId}
        AND m."senderId" != ${userId}
        AND m."createdAt" > COALESCE(last_read_message."createdAt", p."joinedAt")
      GROUP BY p."conversationId";
    `;

    const unreadMap = new Map(unreadCounts.map(item => [item.conversationId, item.unreadCount]));
    const conversations = conversationsData.map(convo => ({
      ...convo,
      unreadCount: unreadMap.get(convo.id) || 0,
    }));

    res.json(conversations);
  } catch (error) {
    next(error);
  }
});

// CREATE a new conversation
router.post("/", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { title, userIds, isGroup, initialSession } = req.body;
    const creatorId = req.user.id;

    if (!Array.isArray(userIds)) {
      return res.status(400).json({ error: "userIds must be an array." });
    }

    if (userIds.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ error: `Group cannot have more than ${MAX_GROUP_MEMBERS} members.` });
    }

    if (!isGroup) {
      const otherUserId = userIds.find((id: string) => id !== creatorId);
      if (!otherUserId) return res.status(400).json({ error: "Another user ID is required for a private chat." });

      const existingConversation = await prisma.conversation.findFirst({
        where: {
          isGroup: false,
          AND: [
            { participants: { some: { userId: creatorId } } },
            { participants: { some: { userId: otherUserId } } },
          ],
        },
        include: { participants: { include: { user: true } }, creator: true }
      });

      if (existingConversation) return res.status(200).json(existingConversation);
    }

    const allUserIds = Array.from(new Set([...userIds, creatorId]));

    const newConversation = await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          title: isGroup ? title : null,
          isGroup,
          creatorId: isGroup ? creatorId : null,
          participants: {
            create: allUserIds.map((userId: string) => ({
              user: { connect: { id: userId } },
              role: userId === creatorId ? "ADMIN" : "MEMBER",
            })),
          },
        },
        include: {
          participants: { 
            select: { 
              role: true, 
              user: { select: { id: true, username: true, name: true, avatarUrl: true, description: true, publicKey: true } }
            } 
          },
          creator: true,
        },
      });

      if (initialSession) {
        const { sessionId, initialKeys, ephemeralPublicKey } = initialSession;
        if (!sessionId || !initialKeys || !ephemeralPublicKey) throw new Error("Incomplete initial session data provided.");
        const keyRecords = initialKeys.map((ik: { userId: string; key: string; }) => ({
          sessionId,
          encryptedKey: ik.key,
          userId: ik.userId,
          conversationId: conversation.id,
          initiatorEphemeralKey: ephemeralPublicKey,
          isInitiator: ik.userId === creatorId,
        }));
        await tx.sessionKey.createMany({ data: keyRecords });
      } else {
        await rotateAndDistributeSessionKeys(conversation.id, creatorId, tx);
      }

      return conversation;
    });

    const transformedConversation = {
      ...newConversation,
      isGroup: newConversation.isGroup,
      participants: newConversation.participants.map(p => ({ ...p.user, role: p.role })),
      unreadCount: 1,
      lastMessage: null,
    };

    getIo().to(allUserIds.filter(uid => uid !== creatorId)).emit("conversation:new", transformedConversation);
    res.status(201).json({ ...transformedConversation, unreadCount: 0 });

  } catch (error) {
    next(error);
  }
});

// GET a single conversation by ID
router.get("/:id", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id } = req.params;
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        participants: { some: { userId: req.user.id } },
      },
      include: {
        participants: {
          select: {
            user: { select: { id: true, username: true, name: true, avatarUrl: true, description: true, publicKey: true } },
            isPinned: true,
            role: true,
          },
        },
        creator: { select: { id: true, username: true } },
      },
    });

    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    res.json(conversation);
  } catch (error) {
    next(error);
  }
});

// UPDATE group conversation details
router.put("/:id/details", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id } = req.params;
    const { title, description } = req.body;
    const participant = await prisma.participant.findFirst({
      where: { conversationId: id, userId: req.user.id },
    });
    if (!participant || participant.role !== "ADMIN") return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });

    const updatedConversation = await prisma.conversation.update({
      where: { id },
      data: { title, description },
    });
    getIo().to(id).emit("conversation:updated", {
      id,
      title: updatedConversation.title,
      description: updatedConversation.description,
    });
    res.json(updatedConversation);
  } catch (error) {
    next(error);
  }
});


// ADD new members to a group
router.post("/:id/participants", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id: conversationId } = req.params;
    const { userIds } = req.body;
    const adminParticipant = await prisma.participant.findFirst({
      where: { conversationId, userId: req.user.id, role: "ADMIN" },
    });
    if (!adminParticipant) return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });

    if (!Array.isArray(userIds)) return res.status(400).json({ error: "userIds must be an array." });

    const currentCount = await prisma.participant.count({ where: { conversationId } });
    if (currentCount + userIds.length > MAX_GROUP_MEMBERS) {
       return res.status(400).json({ error: `Group limit reached (${MAX_GROUP_MEMBERS} members max).` });
    }

    const newParticipants = await prisma.$transaction(async (tx) => {
      await Promise.all(userIds.map((userId: string) => 
        tx.participant.upsert({
          where: { userId_conversationId: { userId, conversationId } },
          create: { userId, conversationId, joinedAt: new Date() },
          update: { joinedAt: new Date() },
        })
      ));
      await rotateAndDistributeSessionKeys(conversationId, req.user!.id, tx);
      return await tx.participant.findMany({
        where: { conversationId, userId: { in: userIds } },
        include: { user: { select: { id: true, username: true, name: true, avatarUrl: true, description: true, publicKey: true } } },
      });
    });

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { include: { user: true } }, creator: true },
    });

    getIo().to(conversationId).emit("conversation:participants_added", { conversationId, newParticipants });
    newParticipants.forEach(p => {
      if (conversation) getIo().to(p.userId).emit("conversation:new", conversation);
    });
    res.status(201).json(newParticipants);
  } catch (error) {
    next(error);
  }
});

// UPDATE a member's role
router.put("/:id/participants/:userId/role", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id: conversationId, userId: userToModifyId } = req.params;
    const { role } = req.body;
    if (role !== "ADMIN" && role !== "MEMBER") return res.status(400).json({ error: "Invalid role specified." });

    const adminParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: req.user.id } });
    if (!adminParticipant || adminParticipant.role !== "ADMIN") return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    if (req.user.id === userToModifyId) return res.status(400).json({ error: "You cannot change your own role." });

    const updatedParticipant = await prisma.participant.updateMany({
      where: { conversationId, userId: userToModifyId },
      data: { role },
    });
    if (updatedParticipant.count === 0) return res.status(404).json({ error: "Participant not found." });

    getIo().to(conversationId).emit("conversation:participant_updated", { conversationId, userId: userToModifyId, role });
    res.json({ userId: userToModifyId, role });
  } catch (error) {
    next(error);
  }
});

// REMOVE a member from a group
router.delete("/:id/participants/:userId", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id: conversationId, userId: userToRemoveId } = req.params;
    const adminParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: req.user.id } });
    if (!adminParticipant || adminParticipant.role !== "ADMIN") return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    if (req.user.id === userToRemoveId) return res.status(400).json({ error: "You cannot remove yourself from the group." });

    await prisma.participant.delete({ where: { userId_conversationId: { userId: userToRemoveId, conversationId } } });
    getIo().to(conversationId).emit("conversation:participant_removed", { conversationId, userId: userToRemoveId });
    getIo().to(userToRemoveId).emit("conversation:deleted", { id: conversationId });
    await rotateAndDistributeSessionKeys(conversationId, req.user.id);
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return res.status(404).json({ error: "Participant not found in this group." });
    }
    next(error);
  }
});

// LEAVE a group
router.delete("/:id/leave", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id: conversationId } = req.params;
    const userId = req.user.id;
    const participant = await prisma.participant.findFirst({ where: { conversationId, userId } });
    if (!participant) return res.status(404).json({ error: "You are not a member of this group." });

    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (conversation?.creatorId === userId) return res.status(400).json({ error: "Group creator cannot leave; please delete it instead." });

    await prisma.participant.delete({ where: { userId_conversationId: { userId, conversationId } } });
    getIo().to(conversationId).emit("conversation:participant_removed", { conversationId, userId });
    getIo().to(userId).emit("conversation:deleted", { id: conversationId });

    const remainingAdmin = await prisma.participant.findFirst({
      where: { conversationId, role: "ADMIN", userId: { not: userId } },
    });
    if (remainingAdmin) {
      try {
        await rotateAndDistributeSessionKeys(conversationId, remainingAdmin.userId);
      } catch (error) {
        console.error(`Failed to rotate keys for ${conversationId} after user ${userId} left:`, error);
      }
    } else {
      console.warn(`Could not rotate keys for ${conversationId} after user left: no remaining admin found.`);
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// DELETE a conversation
router.delete("/:id", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id } = req.params;
    const userId = req.user.id;
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { participants: { select: { userId: true } } },
    });
    if (!conversation || !conversation.participants.some(p => p.userId === userId)) return res.status(404).json({ error: "Conversation not found or you are not a participant." });

    if (conversation.isGroup) {
      if (conversation.creatorId !== userId) return res.status(403).json({ error: "Only the group creator can delete the group." });
      await prisma.conversation.delete({ where: { id } });
      getIo().to(conversation.participants.map(p => p.userId)).emit("conversation:deleted", { id });
    } else {
      await prisma.userHiddenConversation.create({ data: { userId, conversationId: id } });
      getIo().to(userId).emit("conversation:deleted", { id });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Toggle pin status
router.post("/:id/pin", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id: conversationId } = req.params;
    const userId = req.user.id;
    const participant = await prisma.participant.findUnique({ where: { userId_conversationId: { userId, conversationId } } });
    if (!participant) return res.status(404).json({ error: "You are not a participant of this conversation." });

    const updatedParticipant = await prisma.participant.update({
      where: { userId_conversationId: { userId, conversationId } },
      data: { isPinned: !participant.isPinned },
    });
    res.json({ isPinned: updatedParticipant.isPinned });
  } catch (error) {
    next(error);
  }
});

// Mark as read
router.post("/:id/read", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id } = req.params;
    const lastMessage = await prisma.message.findFirst({ where: { conversationId: id }, orderBy: { createdAt: 'desc' } });
    if (lastMessage) {
      await prisma.participant.updateMany({
        where: { conversationId: id, userId: req.user.id },
        data: { lastReadMsgId: lastMessage.id },
      });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// GET media for a conversation
router.get('/:id/media', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id } = req.params;
    const conversation = await prisma.conversation.findFirst({
      where: { id, participants: { some: { userId: req.user.id } } },
    });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found or you are not a member.' });

    const mediaResults = await prisma.message.findMany({
      where: { conversationId: id, OR: [{ imageUrl: { not: null } }, { fileUrl: { not: null } }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, imageUrl: true, fileUrl: true, fileName: true, fileType: true }
    });

    const formattedMedia = mediaResults.map(msg => {
      const isImage = !!msg.imageUrl;
      let type = 'DOCUMENT';
      if (isImage) type = 'IMAGE';
      else if (msg.fileType?.startsWith('video')) type = 'VIDEO';
      else if (msg.fileType?.startsWith('audio')) type = 'AUDIO';
      
      return {
        id: msg.id,
        content: msg.imageUrl || msg.fileUrl,
        type: type,
        fileName: msg.fileName,
      };
    });
    res.json(formattedMedia);
  } catch (error) {
    console.error('Failed to fetch media:', error);
    next(error)
  }
});

// Record key rotation event
router.post("/:id/key-rotation", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id: conversationId } = req.params;
    const { reason } = req.body;

    // Validasi bahwa pengguna adalah anggota percakapan
    const participant = await prisma.participant.findFirst({
      where: {
        conversationId,
        userId: req.user!.id
      }
    });

    if (!participant) {
      return res.status(404).json({ error: "Conversation not found or you're not a participant" });
    }

    // Catat bahwa rotasi kunci telah terjadi
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(), // Ini akan memperbarui timestamp terakhir
        // Di sini kita bisa menambahkan field khusus untuk melacak kapan kunci terakhir dirotasi
      }
    });

    // Di sini kita bisa menambahkan logika tambahan seperti:
    // - Mencatat rotasi kunci di tabel khusus
    // - Memberi tahu anggota lain bahwa kunci telah dirotasi
    // - Menandai kunci lama sebagai tidak valid

    res.json({
      success: true,
      message: "Key rotation recorded successfully",
      conversation: updatedConversation
    });
  } catch (error) {
    console.error('Failed to record key rotation:', error);
    next(error);
  }
});

export default router;
