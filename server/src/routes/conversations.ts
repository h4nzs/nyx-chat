import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getIo } from "../socket.js";
import { upload } from "../utils/upload.js";
import { rotateAndDistributeSessionKeys } from "../utils/sessionKeys.js";

const router = Router();
router.use(requireAuth);

// GET all conversations for the current user
router.get("/", async (req, res, next) => {
  try {
    const conversationsData = await prisma.conversation.findMany({
      where: {
        participants: {
          some: {
            userId: req.user.id,
          },
        },
        hiddenBy: {
          none: {
            userId: req.user.id,
          },
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, username: true, name: true, avatarUrl: true, description: true },
            },
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
        p."userId" = ${req.user.id}
        AND m."senderId" != ${req.user.id}
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

// CREATE a new conversation (private or group)
router.post("/", async (req, res, next) => {
  const { title, userIds, isGroup, initialSession } = req.body;
  const creatorId = req.user.id;

  try {
    if (!isGroup) {
      const otherUserId = userIds.find((id: string) => id !== creatorId);
      if (!otherUserId) {
        return res.status(400).json({ error: "Another user ID is required for a private chat." });
      }

      const existingConversation = await prisma.conversation.findFirst({
        where: {
          isGroup: false,
          AND: [
            { participants: { some: { userId: creatorId } } },
            { participants: { some: { userId: otherUserId } } },
          ],
        },
        include: {
          participants: { include: { user: true } },
          creator: true,
        }
      });

      if (existingConversation) {
        return res.status(200).json(existingConversation);
      }
    }

    const allUserIds = Array.from(new Set([...userIds, creatorId]));

    // --- Start Transaction ---
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
          participants: { include: { user: { select: { id: true, username: true, name: true, avatarUrl: true, description: true } } } },
          creator: true,
        },
      });

      if (initialSession) {
        const { sessionId, initialKeys, ephemeralPublicKey } = initialSession;
        if (!sessionId || !initialKeys || !ephemeralPublicKey) {
          throw new Error("Incomplete initial session data provided.");
        }
        const keyRecords = initialKeys.map((ik: { userId: string; key: string; }) => ({
          sessionId,
          encryptedKey: ik.key,
          userId: ik.userId,
          conversationId: conversation.id,
          initiatorEphemeralKey: ephemeralPublicKey,
          isInitiator: ik.userId === creatorId,
        }));
        await tx.sessionKey.createMany({
          data: keyRecords,
        });
      } else {
        // Note: rotateAndDistributeSessionKeys performs its own prisma calls and cannot be part of this transaction.
        // If this call fails, the transaction will still commit. This is a known limitation to be addressed if needed.
        await rotateAndDistributeSessionKeys(conversation.id, creatorId, tx);
      }

      return conversation;
    });
    // --- End Transaction ---

    const transformedConversation = {
      ...newConversation,
      participants: newConversation.participants.map(p => ({ ...p.user, role: p.role })),
      unreadCount: 1,
      lastMessage: null,
    };

    const io = getIo();
    const otherParticipants = allUserIds.filter(uid => uid !== creatorId);
    otherParticipants.forEach(userId => {
      io.to(userId).emit("conversation:new", transformedConversation);
    });

    const initiatorConversation = { ...transformedConversation, unreadCount: 0 };
    res.status(201).json(initiatorConversation);

  } catch (error) {
    next(error);
  }
});

// GET a single conversation by ID
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        participants: {
          some: {
            userId: req.user.id,
          },
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, username: true, name: true, avatarUrl: true, description: true },
            },
          },
        },
        creator: {
          select: { id: true, username: true },
        },
      },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    res.json(conversation);
  } catch (error) {
    next(error);
  }
});

// UPDATE group conversation details
router.put("/:id/details", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description } = req.body;
    const userId = req.user.id;

    const participant = await prisma.participant.findFirst({
      where: { conversationId: id, userId: userId },
    });

    if (!participant || participant.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    }

    const updatedConversation = await prisma.conversation.update({
      where: { id },
      data: { title, description },
    });

    const io = getIo();
    io.to(id).emit("conversation:updated", {
      id,
      title: updatedConversation.title,
      description: updatedConversation.description,
    });

    res.json(updatedConversation);
  } catch (error) {
    next(error);
  }
});

// UPLOAD group avatar
router.post("/:id/avatar", upload.single('avatar'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const participant = await prisma.participant.findFirst({
      where: { conversationId: id, userId: userId },
    });

    if (!participant || participant.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No avatar file provided." });
    }

    const avatarUrl = `/uploads/images/${req.file.filename}`;

    const updatedConversation = await prisma.conversation.update({
      where: { id },
      data: { avatarUrl },
    });

    const io = getIo();
    io.to(id).emit("conversation:updated", {
      id,
      avatarUrl: updatedConversation.avatarUrl,
    });

    res.json({ avatarUrl: updatedConversation.avatarUrl });
  } catch (error) {
    next(error);
  }
});

// ADD new members to a group
router.post("/:id/participants", async (req, res, next) => {
  try {
    const { id: conversationId } = req.params;
    const { userIds } = req.body;
    const currentUserId = req.user.id;

    const adminParticipant = await prisma.participant.findFirst({
      where: { conversationId, userId: currentUserId, role: "ADMIN" },
    });

    if (!adminParticipant) {
      return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    }

    const newParticipantsData = userIds.map((userId: string) => ({
      conversationId,
      userId,
    }));

    // --- Start Transaction ---
    const newParticipants = await prisma.$transaction(async (tx) => {
      await tx.participant.createMany({
        data: newParticipantsData,
        skipDuplicates: true,
      });

      // Rotate session keys to include the new participants, now within the transaction
      await rotateAndDistributeSessionKeys(conversationId, currentUserId, tx);
      
      // Fetch the newly added participants to return them
      return await tx.participant.findMany({
        where: { conversationId, userId: { in: userIds } },
        include: { user: { select: { id: true, username: true, name: true, avatarUrl: true, description: true } } },
      });
    });
    // --- End Transaction ---

    // --- Notifications can now be sent after the transaction is successful ---
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { include: { user: true } }, creator: true },
    });

    const io = getIo();
    io.to(conversationId).emit("conversation:participants_added", { conversationId, newParticipants });

    newParticipants.forEach(p => {
      io.to(p.userId).emit("conversation:new", conversation);
    });

    res.status(201).json(newParticipants);
  } catch (error) {
    next(error);
  }
});

// UPDATE a member's role in a group
router.put("/:id/participants/:userId/role", async (req, res, next) => {
  try {
    const { id: conversationId, userId: userToModifyId } = req.params;
    const { role } = req.body;
    const currentUserId = req.user.id;

    if (role !== "ADMIN" && role !== "MEMBER") {
      return res.status(400).json({ error: "Invalid role specified." });
    }

    const adminParticipant = await prisma.participant.findFirst({
      where: { conversationId, userId: currentUserId },
    });
    if (!adminParticipant || adminParticipant.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    }

    if (currentUserId === userToModifyId) {
      return res.status(400).json({ error: "You cannot change your own role." });
    }

    const updatedParticipant = await prisma.participant.updateMany({
      where: { conversationId, userId: userToModifyId },
      data: { role },
    });

    if (updatedParticipant.count === 0) {
      return res.status(404).json({ error: "Participant not found." });
    }

    const io = getIo();
    io.to(conversationId).emit("conversation:participant_updated", {
      conversationId,
      userId: userToModifyId,
      role,
    });

    res.json({ userId: userToModifyId, role });
  } catch (error) {
    next(error);
  }
});

// REMOVE a member from a group
router.delete("/:id/participants/:userId", async (req, res, next) => {
  try {
    const { id: conversationId, userId: userToRemoveId } = req.params;
    const currentUserId = req.user.id;

    const adminParticipant = await prisma.participant.findFirst({
      where: { conversationId, userId: currentUserId },
    });
    if (!adminParticipant || adminParticipant.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden: You are not an admin of this group." });
    }

    if (currentUserId === userToRemoveId) {
      return res.status(400).json({ error: "You cannot remove yourself from the group." });
    }

    const deleteResult = await prisma.participant.delete({
      where: {
        userId_conversationId: {
          userId: userToRemoveId,
          conversationId: conversationId
        }
      },
    });

    const io = getIo();
    io.to(conversationId).emit("conversation:participant_removed", { conversationId, userId: userToRemoveId });
    io.to(userToRemoveId).emit("conversation:deleted", { id: conversationId });

    await rotateAndDistributeSessionKeys(conversationId, currentUserId);

    res.status(204).send();
  } catch (error) {
    // Catch error if participant not found and send a 404
    if (error.code === 'P2025') {
      return res.status(404).json({ error: "Participant not found in this group." });
    }
    next(error);
  }
});

// LEAVE a group
router.delete("/:id/leave", async (req, res, next) => {
  try {
    const { id: conversationId } = req.params;
    const userId = req.user.id;

    const participant = await prisma.participant.findFirst({
      where: { conversationId, userId },
    });
    if (!participant) {
      return res.status(404).json({ error: "You are not a member of this group." });
    }

    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (conversation?.creatorId === userId) {
      return res.status(400).json({ error: "Group creator cannot leave; please delete it instead." });
    }

    // 1. Delete the leaving user from participants
    await prisma.participant.delete({
      where: { userId_conversationId: { userId, conversationId } },
    });

    const io = getIo();
    io.to(conversationId).emit("conversation:participant_removed", { conversationId, userId });
    io.to(userId).emit("conversation:deleted", { id: conversationId });

    // 2. Find another admin to initiate key rotation
    const remainingAdmin = await prisma.participant.findFirst({
      where: {
        conversationId,
        role: "ADMIN",
        userId: { not: userId }, // Ensure it's not the user who just left
      },
    });

    // 3. Rotate keys using the remaining admin as the initiator
    if (remainingAdmin) {
      try {
        await rotateAndDistributeSessionKeys(conversationId, remainingAdmin.userId);
      } catch (error) {
        console.error(`Failed to rotate session keys for conversation ${conversationId} after user ${userId} left:`, error);
        // Note: User has already been removed; key rotation failure is logged but doesn't block the leave operation
      }
    } else {
      console.warn(`Could not rotate keys for conversation ${conversationId} after user left: no remaining admin found.`);
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// DELETE a conversation (soft delete for 1-on-1, hard delete for group by creator)
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { participants: { select: { userId: true } } },
    });

    if (!conversation || !conversation.participants.some(p => p.userId === userId)) {
      return res.status(404).json({ error: "Conversation not found or you are not a participant." });
    }

    const io = getIo();

    if (conversation.isGroup) {
      const deleteResult = await prisma.conversation.deleteMany({
        where: {
          id: id,
          creatorId: userId,
        },
      });

      if (deleteResult.count === 0) {
        return res.status(403).json({ error: "Only the group creator can delete the group." });
      }

      conversation.participants.forEach(p => {
        io.to(p.userId).emit("conversation:deleted", { id });
      });

    } else {
      await prisma.userHiddenConversation.create({
        data: {
          userId,
          conversationId: id,
        },
      });
      io.to(userId).emit("conversation:deleted", { id });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Mark a conversation as read
router.post("/:id/read", async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const lastMessage = await prisma.message.findFirst({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
    });

    if (lastMessage) {
      await prisma.participant.updateMany({
        where: {
          conversationId: id,
          userId: userId,
        },
        data: {
          lastReadMsgId: lastMessage.id,
        },
      });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// GET /api/conversations/:id/media
// Fetches all media messages for a conversation
router.get('/:id/media', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        participants: {
          some: {
            userId: req.user.id,
          },
        },
      },
    });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found or you are not a member.' });
    }

    const mediaResults = await prisma.message.findMany({
      where: {
        conversationId: id,
        OR: [
          { imageUrl: { not: null } },
          { fileUrl: { not: null } },
        ]
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        imageUrl: true,
        fileUrl: true,
        fileName: true,
        fileType: true,
      }
    });

    const formattedMedia = mediaResults.map(msg => {
      const isImage = !!msg.imageUrl;
      let type = 'DOCUMENT';
      if (isImage) {
        type = 'IMAGE';
      } else if (msg.fileType) {
        if (msg.fileType.startsWith('video')) type = 'VIDEO';
        else if (msg.fileType.startsWith('audio')) type = 'AUDIO';
        // The frontend FileAttachment component will handle PDF detection by fileName
      }
      
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
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;