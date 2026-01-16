import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../utils/errors.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { getIo } from "../socket.js";
import { sendPushNotification } from "../utils/sendPushNotification.js";
import multer from "multer"; // Import Multer langsung
import { nanoid } from "nanoid"; // Install jika belum: pnpm add nanoid
import path from "path";
import { uploadToSupabase } from "../utils/supabase.js"; // Import utility Supabase

const router: Router = Router();

// KONFIGURASI MULTER (MEMORY STORAGE)
// Kita simpan file di RAM sebentar untuk diteruskan ke Supabase
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // Limit 50MB (sesuaikan kebutuhan)
});

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
      
      // Ambil body data
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
      
      // --- PERUBAHAN UTAMA DI SINI (SUPABASE) ---
      // Generate nama file unik
      const uniqueFilename = `${nanoid()}${path.extname(file.originalname)}`;
      const supabasePath = `attachments/${conversationId}/${uniqueFilename}`;

      // Upload ke Supabase
      console.log(`[UPLOAD-DEBUG] Uploading to Supabase: ${supabasePath}`);
      const fileUrl = await uploadToSupabase(
        file.buffer, // Gunakan buffer dari memory storage
        supabasePath,
        file.mimetype
      );
      // -------------------------------------------

      const participants = await prisma.participant.findMany({
        where: { conversationId },
        select: { userId: true },
      });

      const newMessage = await prisma.$transaction(async (tx) => {
        const msg = await tx.message.create({
          data: {
            conversationId,
            senderId,
            fileUrl, // URL Publik dari Supabase
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

        // --- DEBUG LOG 2: Prisma Result ---
        if (!conversation.isGroup && !msg.sessionId) {
            console.error("[UPLOAD-CRITICAL] Prisma created message BUT sessionId is missing!", msg);
        }

        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: msg.createdAt },
        });
        return msg;
      });

      const messageToBroadcast = { ...newMessage, tempId: parsedTempId };
      
      // --- DEBUG LOG 3: Pre-Broadcast ---
      console.log("[UPLOAD-DEBUG] Broadcasting Message Payload:", JSON.stringify({
        id: messageToBroadcast.id,
        sessionId: messageToBroadcast.sessionId,
        isGroup: conversation.isGroup,
        conversationId: messageToBroadcast.conversationId,
        fileUrl: messageToBroadcast.fileUrl // Cek URL di sini
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