import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getIo } from "../socket.js";
import { ApiError } from "../utils/errors.js";
import { getSecureLinkPreview } from "../utils/secureLinkPreview.js";
import { sendPushNotification } from "../utils/sendPushNotification.js";
import fs from 'fs/promises';
import path from 'path';

const router: Router = Router();
router.use(requireAuth);

router.get("/:conversationId", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { conversationId } = req.params;
    const userId = req.user.id;
    const cursor = req.query.cursor as string | undefined;

    const participant = await prisma.participant.findFirst({
      where: { userId, conversationId },
    });
    if (!participant) return res.status(403).json({ error: "You are not a member of this conversation." });

    const messages = await prisma.message.findMany({
      where: { 
        conversationId,
        createdAt: { gte: participant.joinedAt }
      },
      take: -50,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      include: { 
        sender: true,
        reactions: true,
        statuses: true,
        repliedTo: {
          include: {
            sender: { select: { id: true, name: true, username: true } }
          }
        }
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ items: messages });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const senderId = req.user.id;
    const { conversationId, content, fileUrl, fileName, fileType, fileSize, duration, fileKey, sessionId, repliedToId, tempId } = req.body;

    if (!conversationId) return res.status(400).json({ error: "conversationId is required." });

    const participants = await prisma.participant.findMany({
      where: { conversationId },
      include: { user: true }, // Include user info untuk cek blocking
    });
    if (!participants.some(p => p.userId === senderId)) return res.status(403).json({ error: "You are not a participant." });

    // CEK BLOCKING: Jika ini percakapan 1-1, cek apakah ada blocking dalam dua arah
    if (participants.length === 2) { // Percakapan 1-1
      const otherParticipant = participants.find(p => p.userId !== senderId);
      if (otherParticipant) {
        // Cek apakah pengirim memblokir penerima
        const isBlockedBySender = await prisma.blockedUser.findFirst({
          where: {
            blockerId: senderId,                // Pengirim sebagai pemblokir
            blockedId: otherParticipant.userId // Penerima sebagai yang diblokir
          }
        });

        // Cek apakah penerima memblokir pengirim
        const isBlockedByReceiver = await prisma.blockedUser.findFirst({
          where: {
            blockerId: otherParticipant.userId, // Penerima sebagai pemblokir
            blockedId: senderId                 // Pengirim sebagai yang diblokir
          }
        });

        // Jika ada blocking dalam dua arah, tolak pengiriman pesan
        if (isBlockedBySender || isBlockedByReceiver) {
          throw new ApiError(403, "Messaging unavailable due to blocking.");
        }
      }
    }

    if (repliedToId) {
      let currentId: string | null = repliedToId;
      let depth = 0;
      const MAX_DEPTH = 10;
      while (currentId && depth < MAX_DEPTH) {
        const parentMessage = await prisma.message.findUnique({
          where: { id: currentId },
          select: { repliedToId: true },
        });
        if (!parentMessage) break;
        currentId = parentMessage.repliedToId;
        depth++;
      }
      if (depth >= MAX_DEPTH) throw new ApiError(400, "Reply chain is too deep.");
    }

    let linkPreviewData: any = null;
    if (content && !fileUrl) {
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = content.match(urlRegex);
      if (urls?.[0]) {
        try {
          const preview = await getSecureLinkPreview(urls[0]);
          if ('title' in preview && 'description' in preview && 'images' in preview) {
            linkPreviewData = {
              url: preview.url,
              title: preview.title,
              description: preview.description,
              image: preview.images[0],
              siteName: 'siteName' in preview ? preview.siteName : '',
            };
          }
        } catch (e) {
          console.error("Failed to get link preview:", e);
        }
      }
    }

    const newMessage = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          conversationId, senderId, content, fileUrl, fileName, fileType, fileSize, duration, fileKey, sessionId, repliedToId,
          linkPreview: linkPreviewData,
          statuses: { create: participants.map(p => ({ userId: p.userId, status: p.userId === senderId ? 'READ' : 'SENT' })) },
        },
        include: { sender: true, reactions: true, statuses: true, repliedTo: { include: { sender: true } } },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: msg.createdAt },
      });
      return msg;
    });

    const messageToBroadcast = { ...newMessage, tempId };
    getIo().to(conversationId).emit("message:new", messageToBroadcast);

    const pushRecipients = participants.filter(p => p.userId !== senderId);
    const pushBody = fileUrl ? 'You received a file.' : (content || '');
    const payload = { title: `New message from ${req.user.username}`, body: pushBody.substring(0, 200) };
    pushRecipients.forEach(p => sendPushNotification(p.userId, payload));

    res.status(201).json(messageToBroadcast);
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { id } = req.params;
    const userId = req.user.id;
    const message = await prisma.message.findUnique({ where: { id } });
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.senderId !== userId) return res.status(403).json({ error: "You can only delete your own messages" });

    if (message.fileUrl && message.fileUrl.startsWith('/uploads/')) {
      try {
        const uploadsDir = path.resolve(process.cwd(), 'uploads');
        const relativePath = path.normalize(decodeURIComponent(message.fileUrl.substring('/uploads/'.length)));
        if (relativePath.includes('..')) throw new Error("Invalid path (directory traversal).");
        const candidatePath = path.join(uploadsDir, relativePath);
        if (relativePath && relativePath !== '.' && candidatePath.startsWith(uploadsDir + path.sep)) {
          await fs.unlink(candidatePath);
        } else {
          throw new Error(`Invalid path: ${candidatePath}`);
        }
      } catch (fileError) {
        console.error(`Failed to delete physical file for message ${id}:`, fileError);
      }
    }

    await prisma.message.delete({ where: { id } });
    getIo().to(message.conversationId).emit("message:deleted", { conversationId: message.conversationId, id: message.id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.post("/:messageId/reactions", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { messageId } = req.params;
    const { emoji, tempId } = req.body;
    const userId = req.user.id;
    if (!emoji) return res.status(400).json({ error: "Emoji is required." });

    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
    if (!message) return res.status(404).json({ error: "Message not found." });

    const participant = await prisma.participant.findFirst({ where: { userId, conversationId: message.conversationId } });
    if (!participant) return res.status(403).json({ error: "You are not a participant of this conversation." });

    const newReaction = await prisma.messageReaction.create({
      data: { messageId, emoji, userId },
      include: { user: { select: { id: true, name: true, username: true } } }
    });
    getIo().to(message.conversationId).emit("reaction:new", {
      conversationId: message.conversationId,
      messageId: messageId,
      reaction: { ...newReaction, tempId },
    });
    res.status(201).json(newReaction);
  } catch (error) {
    next(error);
  }
});

router.delete("/reactions/:reactionId", async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, "Authentication required.");
    const { reactionId } = req.params;
    const userId = req.user.id;
    const reaction = await prisma.messageReaction.findUnique({
      where: { id: reactionId },
      select: { userId: true, message: { select: { id: true, conversationId: true } } }
    });
    if (!reaction) return res.status(404).json({ error: "Reaction not found." });
    if (reaction.userId !== userId) return res.status(403).json({ error: "You can only delete your own reactions." });

    await prisma.messageReaction.delete({ where: { id: reactionId } });
    getIo().to(reaction.message.conversationId).emit("reaction:deleted", {
      conversationId: reaction.message.conversationId,
      messageId: reaction.message.id,
      reactionId: reactionId,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;