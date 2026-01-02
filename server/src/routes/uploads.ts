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

router.post(
  "/:conversationId/upload",
  requireAuth,
  zodValidate({ params: z.object({ conversationId: z.string().cuid() }) }),
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentication required.");
      const { conversationId } = req.params;
      const senderId = req.user.id;
      const file = req.file;
      const { fileKey, sessionId, repliedToId, tempId, duration } = req.body;
      const parsedTempId = Number(tempId);

      // --- DEBUG LOG 1: Incoming Data ---
      console.log(`[UPLOAD-DEBUG] Incoming Request Body for ${conversationId}:`, {
        fileKey: !!fileKey,
        sessionId,
        sessionIdType: typeof sessionId,
        tempId,
        isFilePresent: !!file
      });

      if (!file) {
        throw new ApiError(400, "No file uploaded or file type is not allowed.");
      }
      if (!fileKey) {
        throw new ApiError(400, "Missing required encrypted key for the file.");
      }
      if (!tempId || !Number.isFinite(parsedTempId)) {
        throw new ApiError(400, "A valid temporary ID (tempId) is required.");
      }

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });

      if (!conversation) {
        throw new ApiError(404, "Conversation not found.");
      }

      if (!conversation.isGroup && !sessionId) {
        throw new ApiError(400, "Missing required session for a 1-on-1 file message.");
      }

      const participant = await prisma.participant.findFirst({
        where: { userId: senderId, conversationId },
      });

      if (!participant) {
        throw new ApiError(403, "Forbidden: You are not a participant of this conversation");
      }
      
    const categoryFolder = path.basename(file.destination);

    const fileUrl = `/uploads/${categoryFolder}/${file.filename}`;

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
            sessionId, // Pastikan ini masuk ke DB
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

        // --- DEBUG LOG 2: Prisma Result ---
        // Memastikan prisma mengembalikan sessionId setelah create
        if (!conversation.isGroup && !msg.sessionId) {
            console.error("[UPLOAD-CRITICAL] Prisma created message BUT sessionId is missing in return object!", msg);
        }

        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: msg.createdAt },
        });
        return msg;
      });

      const messageToBroadcast = { ...newMessage, tempId: parsedTempId };
      
      // --- DEBUG LOG 3: Pre-Broadcast ---
      // Ini adalah bukti terakhir sebelum data meninggalkan server
      console.log("[UPLOAD-DEBUG] Broadcasting Message Payload:", JSON.stringify({
        id: messageToBroadcast.id,
        sessionId: messageToBroadcast.sessionId, // Cek nilai ini di log!
        isGroup: conversation.isGroup,
        conversationId: messageToBroadcast.conversationId
      }, null, 2));

      const io = getIo();
      io.to(conversationId).emit("message:new", messageToBroadcast);
      
      const pushRecipients = participants.filter(p => p.userId !== senderId);
      const pushBody = `Sent a file: ${file.originalname}`;
      const payload = { title: `New message from ${req.user.username}`, body: pushBody.substring(0, 200) };
      pushRecipients.forEach(p => sendPushNotification(p.userId, payload));

      res.status(201).json(messageToBroadcast);

    } catch (e) {
      console.error("[UPLOAD-ERROR]", e);
      next(e);
    }
  }
);

export default router;
