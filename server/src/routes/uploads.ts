import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../utils/errors.js";
import { z } from "zod";
import { zodValidate } from "../utils/validate.js";
import { getIo } from "../socket.js";
import { sendPushNotification } from "../utils/sendPushNotification.js";
import { env } from "../config.js";
import { nanoid } from "nanoid";
import { getPresignedUploadUrl, deleteR2File } from "../utils/r2.js"; // Pastikan deleteR2File ada di utils/r2.ts
import { uploadLimiter } from "../middleware/rateLimiter.js";
import { deleteFromSupabase } from "../utils/supabase.js"; // Tetap simpan buat hapus file lama (Legacy)

const router: Router = Router();

// ============================================================================
// CATATAN MIGRASI R2:
// - Multer dihapus karena upload dilakukan Client -> R2 langsung.
// - Endpoint di bawah ini hanya menerima Metadata (URL, Nama File) untuk disimpan di DB.
// ============================================================================

// Helper: Hapus file lama (Support R2 & Legacy Supabase)
async function deleteOldFile(url: string) {
  try {
    if (!url) {
      return;
    }

    // Cek apakah file ada di R2 (berdasarkan domain)
    if (url.includes(env.r2PublicDomain)) {
      // Ambil key dari URL (misal: https://pub.r2.dev/avatars/user-123.jpg -> avatars/user-123.jpg)
      const key = url.replace(`${env.r2PublicDomain}/`, '');
      await deleteR2File(key);
    }
    // Jika bukan R2, asumsi file lama di Supabase
    else {
      await deleteFromSupabase(url);
    }
  } catch (error) {
    console.error("[Delete File Error]", error);
  }
}

// === 0. GENERATE PRESIGNED URL (Langkah 1) ===
router.post("/presigned", requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const { fileName, fileType, folder } = req.body;

    // Validasi input
    if (!fileName || !fileType || !folder) {
      return res.status(400).json({ error: "Missing required fields: fileName, fileType, or folder" });
    }

    // Validasi folder biar rapi
    const allowedFolders = ['avatars', 'attachments', 'groups'];
    const targetFolder = allowedFolders.includes(folder) ? folder : 'misc';

    // Validasi tipe file
    const allowedTypes = [
        // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  // Media
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/mp3',
  // Archives
  'application/zip',
  'application/x-rar-compressed',
  'application/octet-stream', // For encrypted files
    ];

    if (!allowedTypes.includes(fileType)) {
      return res.status(400).json({ error: `File type not allowed: ${fileType}` });
    }

    // Validasi ukuran file berdasarkan jenisnya
    const fileSize = req.body.fileSize ? parseInt(req.body.fileSize, 10) : 0;
    if (fileSize > 0) {
      // Konversi MB ke bytes
      const avatarMaxSize = 5 * 1024 * 1024; // 5MB
      const imageMaxSize = 15 * 1024 * 1024; // 15MB
      const videoMaxSize = 100 * 1024 * 1024; // 100MB
      const documentMaxSize = 50 * 1024 * 1024; // 50MB

      // Tentukan batas berdasarkan folder dan tipe file
      let maxSize: number;
      if (targetFolder === 'avatars') {
        maxSize = avatarMaxSize;
      } else if (fileType.startsWith('image/')) {
        maxSize = imageMaxSize;
      } else if (fileType.startsWith('video/')) {
        maxSize = videoMaxSize;
      } else if (fileType.startsWith('audio/')) {
        maxSize = videoMaxSize; // Audio mengikuti batas video
      } else if (fileType.startsWith('application/') || fileType === 'text/plain') {
        maxSize = documentMaxSize;
      } else {
        // Untuk tipe file lain, gunakan batas umum
        maxSize = documentMaxSize;
      }

      if (fileSize > maxSize) {
        const maxSizeMB = maxSize / (1024 * 1024);
        return res.status(400).json({
          error: `File too large. Maximum size for this file type is ${maxSizeMB}MB. Current file size is ${(fileSize / (1024 * 1024)).toFixed(2)}MB.`
        });
      }
    }

    // Validasi ekstensi file dari nama file
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!ext) {
      return res.status(400).json({ error: "File extension not found in filename" });
    }

    // Bikin Key Unik: folder/USER_ID-RANDOM.ext
    const key = `${targetFolder}/${req.user!.id}-${nanoid()}.${ext}`;

    // Minta URL upload ke Cloudflare R2
    const uploadUrl = await getPresignedUploadUrl(key, fileType);

    // Return URL Upload (buat PUT) & URL Public (buat simpan di DB)
    res.json({
      uploadUrl,
      key,
      publicUrl: `${env.r2PublicDomain}/${key}`
    });
  } catch (error) {
    console.error("[PRESIGNED-URL-ERROR]", error);
    next(error);
  }
});

// === 1. SIMPAN AVATAR USER (Langkah 2) ===
router.post(
  "/avatars/save", // Ganti nama route biar jelas ini cuma SAVE metadata
  requireAuth,
  uploadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fileUrl } = req.body; // Client kirim URL R2 yang sudah sukses diupload
      if (!req.user) throw new ApiError(401, "Unauthorized");
      if (!fileUrl) throw new ApiError(400, "Missing fileUrl.");

      const userId = req.user.id;
      
      // 1. Cek Avatar Lama
      const oldUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true }
      });

      // 2. Hapus Avatar Lama (Background Process)
      if (oldUser?.avatarUrl) {
        deleteOldFile(oldUser.avatarUrl).catch(console.error);
      }

      // 3. Update Database
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { avatarUrl: fileUrl },
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
      
      res.json(updatedUser);

    } catch (e) {
      next(e);
    }
  }
);

// === 2. SIMPAN AVATAR GROUP (Langkah 2) ===
router.post(
  "/groups/:id/avatar", 
  uploadLimiter,
  requireAuth, 
  async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { fileUrl } = req.body;
        const groupId = req.params.id;

        if (!req.user) throw new ApiError(401, "Unauthorized");
        if (!fileUrl) throw new ApiError(400, "Missing fileUrl.");
        
        // Cek Admin
        const participant = await prisma.participant.findFirst({
            where: { userId: req.user.id, conversationId: groupId }
        });
        if (!participant || participant.role !== "ADMIN") throw new ApiError(403, "Forbidden: Only admin can change group avatar");

        // 1. Cek Avatar Lama
        const oldGroup = await prisma.conversation.findUnique({
            where: { id: groupId },
            select: { avatarUrl: true }
        });

        // 2. Hapus Avatar Lama
        if (oldGroup?.avatarUrl) {
            deleteOldFile(oldGroup.avatarUrl).catch(console.error);
        }

        // 3. Update Database
        const updatedConversation = await prisma.conversation.update({
            where: { id: groupId },
            data: { avatarUrl: fileUrl },
            include: {
              participants: {
                select: {
                  user: { select: { id: true, username: true, name: true, avatarUrl: true, description: true, publicKey: true } },
                  role: true,
                }
              },
              creator: { select: { id: true, username: true } },
            },
          });

        const transformedConversation = {
          ...updatedConversation,
          participants: updatedConversation.participants.map(p => ({ ...p.user, role: p.role })),
        };

        // Notifikasi Socket
        getIo().to(groupId).emit("conversation:updated", {
          id: groupId,
          avatarUrl: fileUrl,
          lastUpdated: updatedConversation.updatedAt
        });

        res.json(transformedConversation);

    } catch (e) {
        next(e);
    }
});

// === 3. SIMPAN ATTACHMENT CHAT (Langkah 2) ===
// Endpoint ini dipanggil setelah Frontend selesai upload ke R2
router.post(
  "/messages/:conversationId", // Rename jadi lebih RESTful
  uploadLimiter,
  requireAuth,
  zodValidate({ params: z.object({ conversationId: z.string().cuid() }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new ApiError(401, "Authentication required.");
      const { conversationId } = req.params;
      const senderId = req.user.id;
      
      // Terima Metadata lengkap dari Frontend
      const {
        fileUrl,
        fileName,
        fileType,
        fileSize,
        duration,
        tempId,
        fileKey,
        sessionId,
        repliedToId
      } = req.body;

      if (!fileUrl) throw new ApiError(400, "Missing fileUrl.");
      if (!fileKey) throw new ApiError(400, "Missing encrypted key (E2EE required).");

      // Validasi ukuran file berdasarkan jenisnya
      if (fileSize) {
        // Konversi MB ke bytes
        const imageMaxSize = 15 * 1024 * 1024; // 15MB
        const videoMaxSize = 100 * 1024 * 1024; // 100MB
        const documentMaxSize = 50 * 1024 * 1024; // 50MB

        // Tentukan batas berdasarkan tipe file
        let maxSize: number;
        if (fileType.startsWith('image/')) {
          maxSize = imageMaxSize;
        } else if (fileType.startsWith('video/')) {
          maxSize = videoMaxSize;
        } else if (fileType.startsWith('audio/')) {
          maxSize = videoMaxSize; // Audio mengikuti batas video
        } else if (fileType.startsWith('application/') || fileType === 'text/plain') {
          maxSize = documentMaxSize;
        } else {
          // Untuk tipe file lain, gunakan batas umum
          maxSize = documentMaxSize;
        }

        if (fileSize > maxSize) {
          const maxSizeMB = maxSize / (1024 * 1024);
          throw new ApiError(400, `File too large. Maximum size for this file type is ${maxSizeMB}MB. Current file size is ${(fileSize / (1024 * 1024)).toFixed(2)}MB.`);
        }
      }

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true }
      });

      if (!conversation) throw new ApiError(404, "Conversation not found.");

      // Validasi member
      const isParticipant = conversation.participants.some(p => p.userId === senderId);
      if (!isParticipant) throw new ApiError(403, "Forbidden.");
      
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
            fileName,
            fileType, // ex: "image/jpeg;encrypted=true"
            fileSize,
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

      const messageToBroadcast = { ...newMessage, tempId: Number(tempId) };
      
      // Broadcast Socket
      const io = getIo();
      io.to(conversationId).emit("message:new", messageToBroadcast);
      
      // Push Notification
      const pushRecipients = conversation.participants.filter(p => p.userId !== senderId);
      const pushBody = `Sent a file: ${fileName}`;
      pushRecipients.forEach(p => sendPushNotification(p.userId, { 
          title: newMessage.sender.name || newMessage.sender.username, 
          body: pushBody.substring(0, 200),
          url: `/chat/${conversationId}`
      }));

      res.status(201).json(messageToBroadcast);

    } catch (e) {
      console.error("[MESSAGE-UPLOAD-ERROR]", e);
      next(e);
    }
  }
);

export default router;