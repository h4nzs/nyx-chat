import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getIo } from "../socket.js";
import { getSecureLinkPreview } from "../utils/secureLinkPreview.js";
import { sendPushNotification } from "../utils/sendPushNotification.js";
import fs from 'fs/promises';
import path from 'path';

const router = Router();
router.use(requireAuth);

// GET all messages for a conversation
router.get("/:conversationId", async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const cursor = req.query.cursor as string | undefined;

    // Authorization check: Ensure the user is a participant
    const participant = await prisma.participant.findFirst({
      where: {
        userId,
        conversationId,
      },
    });

    if (!participant) {
      return res.status(403).json({ error: "You are not a member of this conversation." });
    }

    const messages = await prisma.message.findMany({
      where: { 
        conversationId,
        createdAt: {
          gte: participant.joinedAt,
        }
      },
      take: -50, // Fetch the last 50 messages
      ...(cursor && { 
        skip: 1, // Skip the cursor itself
        cursor: { id: cursor } 
      }),
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

// POST a new message
router.post("/", async (req, res, next) => {
  try {
    const senderId = req.user.id;
    const { conversationId, content, fileUrl, fileName, fileType, fileSize, duration, fileKey, sessionId, repliedToId, tempId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required." });
    }

    const participants = await prisma.participant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    if (!participants.some(p => p.userId === senderId)) {
      return res.status(403).json({ error: "You are not a participant of this conversation." });
    }

    // --- Reply Chain Depth Validation ---
    if (repliedToId) {
      let currentId = repliedToId;
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

      if (depth >= MAX_DEPTH) {
        throw new ApiError(400, "Reply chain is too deep.");
      }
    }
    // --- End Validation ---

    let linkPreviewData: any = null;
    if (content && !fileUrl) {
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = content.match(urlRegex);
      if (urls && urls.length > 0) {
        try {
          const preview = await getSecureLinkPreview(urls[0]);
          if ('title' in preview && 'description' in preview && 'images' in preview) {
            linkPreviewData = {
              url: preview.url,
              title: preview.title,
              description: preview.description,
              image: preview.images[0],
              siteName: preview.siteName,
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
          statuses: {
            create: participants.map(p => ({
              userId: p.userId,
              status: p.userId === senderId ? 'READ' : 'SENT',
            })),
          },
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
    const io = getIo();
    io.to(conversationId).emit("message:new", messageToBroadcast);

    const pushRecipients = participants.filter(p => p.userId !== senderId);
    const pushBody = fileUrl ? 'You received a file.' : (content || '');
    const payload = { title: `New message from ${req.user.username}`, body: pushBody.substring(0, 200) };
    pushRecipients.forEach(p => sendPushNotification(p.userId, payload));

    res.status(201).json(messageToBroadcast);
  } catch (error) {
    next(error);
  }
});

// DELETE a message
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const message = await prisma.message.findUnique({ where: { id } });
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.senderId !== userId) return res.status(403).json({ error: "You can only delete your own messages" });

    // If the message has a file, securely delete the physical file
    if (message.fileUrl && typeof message.fileUrl === 'string' && message.fileUrl.startsWith('/uploads/')) {
      try {
        const uploadsDir = path.resolve(process.cwd(), 'uploads');
        // Decode and sanitize the user-provided path segment
        const relativePath = path.normalize(decodeURIComponent(message.fileUrl.substring('/uploads/'.length)));

        // Prevent directory traversal
        if (relativePath.includes('..')) {
          throw new Error("Invalid path detected (directory traversal).");
        }

        const candidatePath = path.join(uploadsDir, relativePath);

        // Final check: ensure the resolved path is within the uploads directory
        if (relativePath && relativePath !== '.' && candidatePath.startsWith(uploadsDir + path.sep)) {
          await fs.unlink(candidatePath);
          console.log(`[File Delete] Successfully deleted physical file: ${candidatePath}`);
        } else {
          throw new Error(`Invalid path: ${candidatePath} is outside of the allowed directory.`);
        }
      } catch (fileError: any) {
        // Log the error but don't block the message deletion itself
        console.error(`[File Delete Error] Failed to delete physical file for message ${id}: ${fileError.message}`);
      }
    }

    // Hard delete the message record from the database
    await prisma.message.delete({
      where: { id },
    });
    
    getIo().to(message.conversationId).emit("message:deleted", { 
      conversationId: message.conversationId,
      id: message.id 
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST a reaction to a message
router.post("/:messageId/reactions", async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const { emoji, tempId } = req.body;
    const userId = req.user.id;

    if (!emoji) {
      return res.status(400).json({ error: "Emoji is required." });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true }
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found." });
    }

    // Authorization check: Ensure the user is a participant of the message's conversation
    const participant = await prisma.participant.findFirst({
      where: {
        userId,
        conversationId: message.conversationId,
      },
    });

    if (!participant) {
      return res.status(403).json({ error: "You are not a participant of this conversation." });
    }

    const newReaction = await prisma.messageReaction.create({
      data: {
        messageId,
        emoji,
        userId,
      },
      include: {
        user: {
          select: { id: true, name: true, username: true }
        }
      }
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

// DELETE a reaction from a message
router.delete("/reactions/:reactionId", async (req, res, next) => {
  try {
    const { reactionId } = req.params;
    const userId = req.user.id;

    const reaction = await prisma.messageReaction.findUnique({
      where: { id: reactionId },
      select: { 
        userId: true, 
        message: { 
          select: { 
            id: true, 
            conversationId: true 
          } 
        } 
      }
    });

    if (!reaction) {
      return res.status(404).json({ error: "Reaction not found." });
    }

    if (reaction.userId !== userId) {
      return res.status(403).json({ error: "You can only delete your own reactions." });
    }

    await prisma.messageReaction.delete({
      where: { id: reactionId }
    });

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
