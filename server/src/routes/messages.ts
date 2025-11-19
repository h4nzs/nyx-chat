import { Router, Request } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../utils/errors.js";
import { io } from "../socket.js";
import fs from "fs/promises";
import path from "path";

const router = Router();


// ... (GET and DELETE message routes remain the same)

// === GET: semua pesan dalam conversation (user harus anggota) ===
router.get("/:conversationId", requireAuth, async (req: Request, res, next) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const { cursor } = req.query;

    const participant = await prisma.participant.findUnique({
      where: { userId_conversationId: { userId, conversationId } },
    });

    if (!participant) {
      throw new ApiError(403, "Forbidden: You are not a participant of this conversation.");
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        createdAt: { 
          gte: participant.joinedAt // Only fetch messages since the user joined
        },
      },
      take: 50,
      ...(cursor && {
        skip: 1,
        cursor: {
          id: cursor,
        },
      }),
      include: {
        sender: {
          select: { id: true, username: true, avatarUrl: true, name: true },
        },
        reactions: {
          include: {
            user: { select: { id: true, username: true } },
          },
        },
        statuses: true,
        repliedTo: { // Include the message being replied to
          include: {
            sender: { // And the sender of that original message
              select: { id: true, name: true, username: true }
            }
          }
        }
      },
      orderBy: {
        createdAt: "desc", // Fetch newest messages first
      },
    });

    // Reverse the array on the server to send them in ascending order (oldest to newest)
    res.json({ items: messages.reverse() });
  } catch (e) {
    next(e);
  }
});

// === DELETE: hanya sender boleh hapus pesannya ===
router.delete("/:messageId", requireAuth, async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const message = await prisma.message.findFirst({
      where: { id: messageId, senderId: userId },
      select: { conversationId: true, fileUrl: true, imageUrl: true },
    });

    if (!message) {
      throw new ApiError(404, "Message not found or you do not have permission to delete it");
    }

    // Hapus file fisik jika ada
    const urlToDelete = message.fileUrl || message.imageUrl;
    if (urlToDelete) {
      try {
        // urlToDelete is like: http://localhost:4000/uploads/archives/file-123.zip
        const url = new URL(urlToDelete);
        const pathname = url.pathname; // /uploads/archives/file-123.zip
        
        // Find the part of the path relative to the project root
        const uploadsDir = '/uploads/';
        const relativePathIndex = pathname.indexOf(uploadsDir);
        
        if (relativePathIndex !== -1) {
          const filePathInProject = pathname.substring(relativePathIndex + 1); // uploads/archives/file-123.zip
          const absolutePath = path.join(process.cwd(), filePathInProject);
          
          await fs.unlink(absolutePath);
        }
      } catch (fileError: any) {
        // Jangan gagalkan seluruh permintaan jika file tidak ada (mungkin sudah dihapus)
        if (fileError.code !== 'ENOENT') {
          console.error(`Failed to delete file for URL ${urlToDelete}:`, fileError);
        }
      }
    }

    await prisma.message.delete({ where: { id: messageId } });

    io.to(message.conversationId).emit("message:deleted", { messageId, conversationId: message.conversationId });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});


// === REACTION ROUTES ===

router.post("/:messageId/reactions", requireAuth, async (req: Request, res, next) => {
  try {
    const { emoji } = req.body;
    const userId = req.user.id;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
    if (!message) throw new ApiError(404, "Message not found");

    const reaction = await prisma.messageReaction.create({
      data: { emoji, messageId, userId },
      include: { user: { select: { id: true, username: true } } },
    });

    io.to(message.conversationId).emit("reaction:new", reaction);
    res.status(201).json(reaction);
  } catch (e) {
    next(e);
  }
});

router.delete("/reactions/:reactionId", requireAuth, async (req: Request, res, next) => {
  try {
    const { reactionId } = req.params;
    const userId = req.user.id;

    const reaction = await prisma.messageReaction.findFirst({
      where: { id: reactionId, userId },
      select: { id: true, message: { select: { conversationId: true, id: true } } },
    });

    if (!reaction) {
      throw new ApiError(404, "Reaction not found or you do not have permission to delete it");
    }

    await prisma.messageReaction.delete({ where: { id: reactionId } });

    io.to(reaction.message.conversationId).emit("reaction:remove", { reactionId, messageId: reaction.message.id });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});

export default router;