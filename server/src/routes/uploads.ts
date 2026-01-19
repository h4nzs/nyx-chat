import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../utils/errors.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { getIo } from "../socket.js";
import { sendPushNotification } from "../utils/sendPushNotification.js";
import multer from "multer";
import { nanoid } from "nanoid";
import path from "path";
import { uploadLimiter } from "../middleware/rateLimiter.js"; // Import
import { uploadToSupabase } from "../utils/supabase.js";

const router: Router = Router();

// KONFIGURASI MULTER (MEMORY STORAGE)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // Limit 50MB
});

// ============================================================================
// FIX: Route Statis & Spesifik WAJIB ditaruh DI ATAS route dinamis (/:id...)
// agar tidak tertangkap/intersep oleh parameter dinamis.
// ============================================================================

// === 1. UPLOAD AVATAR USER ===
router.post(
  "/avatars/upload",
  requireAuth,
  uploadLimiter, // <--- Pasang disini
  upload.single("avatar"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Unauthorized");
      if (!req.file) throw new ApiError(400, "No file uploaded.");

      const userId = req.user.id;
      
      // Upload ke Supabase (Folder: avatars)
      const uniqueFilename = `${nanoid()}-${Date.now()}${path.extname(req.file.originalname)}`;
      const supabasePath = `avatars/${userId}/${uniqueFilename}`;

      console.log(`[Avatar Upload] Uploading to Supabase: ${supabasePath}`);

      const publicUrl = await uploadToSupabase(
        req.file.buffer,
        supabasePath,
        req.file.mimetype
      );

      // Update User di Database
      // Kita kembalikan object user yang sudah diupdate agar frontend bisa langsung update state
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { avatarUrl: publicUrl },
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          avatarUrl: true,
          description: true,
          showEmailToOthers: true,
          hasCompletedOnboarding: true
        }
      });
      
      console.log(`[Avatar Upload] Success. URL: ${publicUrl}`);
      res.json(updatedUser);

    } catch (e) {
      console.error("[AVATAR-UPLOAD-ERROR]", e);
      next(e);
    }
  }
);

// === 2. UPLOAD AVATAR GROUP ===
router.post(
  "/groups/:id/avatar", 
  uploadLimiter, // <--- Pasang disini
  requireAuth, 
  upload.single("avatar"), 
  async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.user) throw new ApiError(401, "Unauthorized");
        if (!req.file) throw new ApiError(400, "No file uploaded.");
        
        const groupId = req.params.id;
        
        // Cek akses user ke grup
        const participant = await prisma.participant.findFirst({
            where: { userId: req.user.id, conversationId: groupId }
        });
        if (!participant) throw new ApiError(403, "You are not a member of this group");

        // Upload ke Supabase (Folder: groups)
        const uniqueFilename = `${nanoid()}-${Date.now()}${path.extname(req.file.originalname)}`;
        const supabasePath = `groups/${groupId}/${uniqueFilename}`;

        const publicUrl = await uploadToSupabase(
            req.file.buffer,
            supabasePath,
            req.file.mimetype
        );

        // Update Database
        await prisma.conversation.update({
            where: { id: groupId },
            data: { avatarUrl: publicUrl }
        });
        
        // Notifikasi realtime ke semua member grup
        const io = getIo();
        io.to(groupId).emit("conversation:updated", { id: groupId, avatarUrl: publicUrl });

        res.json({ url: publicUrl });

    } catch (e) {
        console.error("[GROUP-AVATAR-ERROR]", e);
        next(e);
    }
});

// === 3. UPLOAD ATTACHMENT CHAT (Dynamic Route) ===
// Ditaruh PALING BAWAH agar "avatars" atau "groups" tidak dianggap sebagai "conversationId"
router.post(
  "/:conversationId/upload",
  uploadLimiter, // <--- Pasang disini
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

      // --- DEBUG LOG ---
      console.log(`[UPLOAD-DEBUG] Incoming Request Body for ${conversationId}:`, {
        fileKey: !!fileKey,
        sessionId,
        tempId,
        isFilePresent: !!file
      });

      if (!file) throw new ApiError(400, "No file uploaded.");
      if (!fileKey) throw new ApiError(400, "Missing required encrypted key.");
      if (!tempId || !Number.isFinite(parsedTempId)) throw new ApiError(400, "Invalid tempId.");

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true } // Include participants untuk validasi & push notif
      });

      if (!conversation) throw new ApiError(404, "Conversation not found.");

      // Validasi member
      const isParticipant = conversation.participants.some(p => p.userId === senderId);
      if (!isParticipant) throw new ApiError(403, "Forbidden.");
      
      // Upload ke Supabase (Folder: attachments)
      const uniqueFilename = `${nanoid()}${path.extname(file.originalname)}`;
      const supabasePath = `attachments/${conversationId}/${uniqueFilename}`;

      console.log(`[UPLOAD-DEBUG] Uploading to Supabase: ${supabasePath}`);
      const fileUrl = await uploadToSupabase(
        file.buffer,
        supabasePath,
        file.mimetype
      );

      // Simpan Message ke DB
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
              create: conversation.participants.map(p => ({
                userId: p.userId,
                status: p.userId === senderId ? 'READ' : 'SENT',
              })),
            },
          },
          include: { sender: { select: { id: true, name: true, username: true, avatarUrl: true } } },
        });

        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: msg.createdAt },
        });
        return msg;
      });

      const messageToBroadcast = { ...newMessage, tempId: parsedTempId };
      
      // Broadcast Socket
      const io = getIo();
      io.to(conversationId).emit("message:new", messageToBroadcast);
      
      // Push Notification
      const pushRecipients = conversation.participants.filter(p => p.userId !== senderId);
      const pushBody = `Sent a file: ${file.originalname}`;
      pushRecipients.forEach(p => sendPushNotification(p.userId, { 
          title: newMessage.sender.name || newMessage.sender.username, 
          body: pushBody.substring(0, 200),
          url: `/chat/${conversationId}`
      }));

      res.status(201).json(messageToBroadcast);

    } catch (e) {
      console.error("[UPLOAD-ERROR]", e);
      next(e);
    }
  }
);

export default router;