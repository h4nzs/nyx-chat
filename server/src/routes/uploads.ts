import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../utils/upload.js";
import { ApiError } from "../utils/errors.js";
import path from 'path';
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { getIo } from "../socket.js";
import { sendPushNotification } from "../utils/sendPushNotification.js";

const router = Router();

// Correctly structured endpoint with proper middleware usage and error handling
router.post(
  "/:conversationId/upload",
  requireAuth,
  zodValidate({ params: z.object({ conversationId: z.string().cuid() }) }),
  upload.single("file"), // Use multer as middleware before the handler
  async (req: Request, res: Response, next: NextFunction) => { // Ensure 'next' is defined
    try {
      const { conversationId } = req.params;
      const senderId = req.user.id;
      const file = req.file;
      const { fileKey, sessionId, repliedToId, tempId, duration } = req.body;

      if (!file) {
        throw new ApiError(400, "No file uploaded or file type is not allowed.");
      }
      if (!fileKey || !sessionId) {
        throw new ApiError(400, "Missing required encrypted key or session for the file.");
      }

      const participant = await prisma.participant.findFirst({
        where: { userId: senderId, conversationId },
      });

      if (!participant) {
        throw new ApiError(403, "Forbidden: You are not a participant of this conversation");
      }
      
      const fileUrl = `/uploads/${path.basename(file.destination)}/${file.filename}`;

      const participants = await prisma.participant.findMany({
        where: { conversationId },
        select: { userId: true },
      });

      const newMessage = await prisma.$transaction(async (tx) => {
        const msg = await tx.message.create({
          data: {
            conversationId,
            senderId,
            fileUrl,
            fileKey,
            sessionId,
            repliedToId,
            fileName: file.originalname,
            fileType: `${file.mimetype};encrypted=true`,
            fileSize: file.size,
            duration: duration ? parseInt(duration, 10) : undefined,
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

      const messageToBroadcast = { ...newMessage, tempId: Number(tempId) };
      const io = getIo();
      io.to(conversationId).emit("message:new", messageToBroadcast);
      
      const pushRecipients = participants.filter(p => p.userId !== senderId);
      const pushBody = `Sent a file: ${file.originalname}`;
      const payload = { title: `New message from ${req.user.username}`, body: pushBody.substring(0, 200) };
      pushRecipients.forEach(p => sendPushNotification(p.userId, payload));

      // Return both the message and the file data to the client for verification
      res.status(201).json({
        message: messageToBroadcast,
        file: {
          url: fileUrl,
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
        }
      });

    } catch (e) {
      next(e);
    }
  }
);

export default router;