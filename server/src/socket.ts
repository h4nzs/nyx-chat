import { Server, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { verifyJwt, signAccessToken } from "./utils/jwt.js"; // Pastikan signAccessToken diimport
import { sendPushNotification } from "./utils/sendPushNotification.js";
import { redisClient } from "./lib/redis.js";
import { Message } from "@prisma/client";
import { AuthPayload } from "./types/auth.js";
import cookie from "cookie"; 
import crypto from "crypto";

// --- Type Definitions for Socket Payloads ---
interface TypingPayload {
  conversationId: string;
}

interface DistributeKeysPayload {
  conversationId: string;
  keys: { userId: string; key: string }[];
}

interface MessageSendPayload {
  conversationId: string;
  content: string;
  sessionId?: string;
  tempId: number;
}

interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface MarkAsReadPayload {
  messageId: string;
  conversationId: string;
}

interface KeyRequestPayload {
  conversationId: string;
  sessionId: string;
}

interface GroupKeyRequestPayload {
  conversationId: string;
}

interface KeyFulfillmentPayload {
  requesterId: string;
  conversationId: string;
  sessionId?: string;
  encryptedKey: string;
}

// Extend the Socket type from Socket.IO to include our custom user property
interface AuthenticatedSocket extends Socket {
  user?: AuthPayload;
}

export let io: Server;

export function getIo() {
  if (!io) {
    throw new Error("Socket.IO not initialized!");
  }
  return io;
}

export function registerSocket(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowedOrigins = [
          env.corsOrigin, 
          "http://localhost:5173", 
          "http://localhost:4173"
        ];
        if (
          allowedOrigins.includes(origin) || 
          origin.endsWith('.vercel.app') || 
          origin.endsWith('.koyeb.app') ||
          origin.endsWith('.onrender.com') ||
          origin.endsWith('.ngrok-free.app')
        ) {
          callback(null, true);
        } else {
          console.warn(`[Socket] Blocked CORS origin: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ["GET", "POST"]
    },
    path: '/socket.io',
    transports: ['polling', 'websocket'],
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
    allowEIO3: true,
    pingTimeout: 30000, // Diubah dari 20000 ke 30000 untuk konsistensi
    pingInterval: 35000  // Diubah dari 25000 ke 35000 untuk konsistensi
  });

  // === MIDDLEWARE AUTH ===
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      let token = socket.handshake.auth?.token;

      if (!token) {
        const cookieHeader = socket.handshake.headers.cookie;
        if (cookieHeader) {
          const cookies = cookie.parse(cookieHeader);
          token = cookies.at;
        }
      }

      if (!token) {
        // ALLOW GUEST for Device Linking
        console.log(`[Socket] Guest connection allowed: ${socket.id}`);
        socket.user = undefined;
        return next(); 
      }

      const payload = verifyJwt(token);
      if (!payload || typeof payload === 'string') {
        console.warn(`[Socket] Invalid token, treating as guest: ${socket.id}`);
        socket.user = undefined;
        return next();
      }

      // @ts-ignore
      const userId = payload.id || payload.sub;
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (!user) {
        socket.user = undefined;
        return next();
      }

      socket.user = { id: user.id, email: user.email, username: user.username };
      next();
    } catch (err) {
      console.error("[Socket] Auth Middleware Error:", err);
      socket.user = undefined;
      next();
    }
  });

  io.on("connection", async (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    // ==========================================
    // 🅰️ GUEST ZONE (Belum Login / HP Baru)
    // ==========================================
    if (!userId) {
      // Event 1: Request QR Token (Dipanggil oleh LinkDevicePage)
      socket.on("auth:request_linking_qr", async (payload: { publicKey: string }, callback) => {
         console.log(`[Socket] Generating QR token for guest ${socket.id}`);
         
         const linkingToken = crypto.randomBytes(32).toString('hex');
         await socket.join(`linking:${linkingToken}`);
         
         console.log(`[Socket] Guest joined room: linking:${linkingToken}`);

         if (typeof callback === 'function') {
            callback({ token: linkingToken });
         }
      });

      socket.on("disconnect", () => {
        console.log(`[Socket] Guest disconnected: ${socket.id}`);
      });

      // STOP! Guest tidak boleh lanjut ke logika user
      return;
    }

    // ==========================================
    // 🅱️ USER ZONE (Sudah Login / HP Lama)
    // ==========================================
    
    // Join room pribadi user
    socket.join(userId);

    // Update Presence
    if (!socket.recovered) {
        await redisClient.sAdd('online_users', userId);
        const onlineUserIds = await redisClient.sMembers('online_users');
        socket.emit("presence:init", onlineUserIds);
        socket.broadcast.emit("presence:user_joined", userId);
    }

    // --- FITUR LINKING DEVICE (Sisi Scanner/HP Lama) ---
    socket.on("linking:send_payload", async (data: { roomId: string, encryptedMasterKey: string }) => {
      console.log(`[Linking] User ${userId} authorizing login for room ${data.roomId}`);
      
      try {
        // 1. Generate Token Baru untuk device baru
        // Kita pakai fungsi signAccessToken agar token valid & fresh
        const newAccessToken = signAccessToken({
            id: socket.user!.id,
            email: socket.user!.email,
            username: socket.user!.username
        });

        // 2. Kirim paket lengkap ke Device Baru (Guest di Room)
        io.to(`linking:${data.roomId}`).emit("auth:linking_success", {
            accessToken: newAccessToken, // Token login buat device baru
            user: socket.user,           // Info user
            encryptedMasterKey: data.encryptedMasterKey // Kunci enkripsi
        });

        console.log(`[Linking] Success sending auth data to room ${data.roomId}`);
      } catch (e) {
        console.error("[Linking] Failed to sign token or send payload:", e);
      }
    });

    // --- CHAT FEATURES ---

    socket.on("conversation:join", (conversationId: string) => {
      socket.join(conversationId);
    });

    socket.on("typing:start", ({ conversationId }: TypingPayload) => {
      if (conversationId && socket.user) {
        socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: true });
      }
    });

    socket.on("typing:stop", ({ conversationId }: TypingPayload) => {
      if (conversationId && socket.user) {
        socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: false });
      }
    });

    socket.on('messages:distribute_keys', async ({ conversationId, keys }: DistributeKeysPayload) => {
      if (!keys || !Array.isArray(keys) || !conversationId) return;
      
      try {
        const participant = await prisma.participant.findFirst({
          where: { conversationId, userId },
        });
        if (!participant) return;

        keys.forEach(keyPackage => {
          if (keyPackage.userId && keyPackage.key) {
            io.to(keyPackage.userId).emit('session:new_key', {
              conversationId,
              encryptedKey: keyPackage.key,
              type: 'GROUP_KEY',
              senderId: userId
            });
          }
        });
      } catch (error) {
        console.error(`[Key Distribution] Error:`, error);
      }
    });

    socket.on('message:send', async (message: MessageSendPayload, callback: (res: { ok: boolean, msg?: Message, error?: string }) => void) => {
      const { conversationId, content, sessionId, tempId } = message;

      if (!content || typeof content !== 'string' || content.length > 10000) {
        return callback?.({ ok: false, error: "Invalid message content." });
      }

      try {
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { participants: { select: { userId: true } } },
        });
        if (!conversation || !conversation.participants.some(p => p.userId === userId)) {
          return callback?.({ ok: false, error: "Conversation not found." });
        }
        
        const newMessage = await prisma.message.create({
          data: { conversationId, senderId: userId, content, sessionId },
          include: { sender: { select: { id: true, name: true, avatarUrl: true, username: true } } }
        });
        
        const finalMessage = { ...newMessage, tempId };
        
        conversation.participants.forEach(participant => {
          io.to(participant.userId).emit('message:new', finalMessage);
          
          if (participant.userId !== userId) {
             sendPushNotification(participant.userId, {
                 title: newMessage.sender.name || newMessage.sender.username,
                 body: "🔒 1 New Secure Message", 
                 conversationId: conversationId
             }).catch(console.error);
          }
        });
        
        callback?.({ ok: true, msg: finalMessage });
      } catch (error) {
        console.error("Failed to process message:", error);
        callback?.({ ok: false, error: "Failed to send." });
      }
    });

    socket.on("push:subscribe", async (data: PushSubscribePayload) => {
      if (!data.endpoint || !data.keys?.p256dh || !data.keys?.auth) return;
      try {
        await prisma.pushSubscription.upsert({
          where: { endpoint: data.endpoint },
          update: { p256dh: data.keys.p256dh, auth: data.keys.auth },
          create: { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, userId },
        });
      } catch (error) {
        console.error("Failed to save push subscription:", error);
      }
    });

    socket.on('message:mark_as_read', async ({ messageId, conversationId }: MarkAsReadPayload) => {
      if (!messageId) return;
      try {
        await prisma.messageStatus.upsert({
          where: { messageId_userId: { messageId, userId } },
          update: { status: 'READ' },
          create: { messageId, userId, status: 'READ' },
        });
        const message = await prisma.message.findUnique({
          where: { id: messageId },
          select: { senderId: true, conversationId: true },
        });
        if (message && message.senderId !== userId) {
          io.to(message.senderId).emit('message:status_updated', {
            messageId,
            conversationId: message.conversationId,
            readBy: userId,
            status: 'READ',
          });
        }
      } catch (error) {
        console.error('Failed to mark message as read:', error);
      }
    });

    // --- E2EE Key Recovery Handlers ---
    
    socket.on('group:request_key', async ({ conversationId }: GroupKeyRequestPayload) => {
      if (!conversationId) return;
      try {
        const participants = await prisma.participant.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
        
        if (onlineParticipants.length > 0) {
          const fulfillerId = onlineParticipants[0].userId;
          const requester = await prisma.user.findUnique({
            where: { id: userId },
            select: { publicKey: true },
          });
          
          if (requester?.publicKey) {
            io.to(fulfillerId).emit('group:fulfill_key_request', {
              conversationId,
              requesterId: userId,
              requesterPublicKey: requester.publicKey,
            });
          }
        }
      } catch (error) {
        console.error(`Error processing group key request`, error);
      }
    });

    socket.on('group:fulfilled_key', ({ requesterId, conversationId, encryptedKey }: KeyFulfillmentPayload) => {
      if (!requesterId || !conversationId || !encryptedKey) return;
      io.to(requesterId).emit('session:new_key', {
        conversationId,
        encryptedKey,
        type: 'GROUP_KEY',
        senderId: userId 
      });
    });

    socket.on('session:request_key', async ({ conversationId, sessionId }: KeyRequestPayload) => {
      if (!conversationId || !sessionId) return;
      try {
        const participants = await prisma.participant.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
        
        if (onlineParticipants.length > 0) {
          const fulfillerId = onlineParticipants[0].userId;
          const requester = await prisma.user.findUnique({
            where: { id: userId },
            select: { publicKey: true },
          });
          
          if (requester?.publicKey) {
            io.to(fulfillerId).emit('session:fulfill_request', {
              conversationId,
              sessionId,
              requesterId: userId,
              requesterPublicKey: requester.publicKey,
            });
          }
        }
      } catch (error) {
        console.error('Error processing session key request', error);
      }
    });

    socket.on('session:fulfill_response', ({ requesterId, conversationId, sessionId, encryptedKey }: KeyFulfillmentPayload) => {
      if (!requesterId || !encryptedKey) return;
      io.to(requesterId).emit('session:new_key', {
        conversationId,
        sessionId,
        encryptedKey,
        type: 'SESSION_KEY',
        senderId: userId
      });
    });

    // Disconnect Handler (Untuk User)
    socket.on("disconnect", async () => {
       setTimeout(async () => {
           const sockets = await io.in(userId).fetchSockets();
           if (sockets.length === 0) {
               await redisClient.sRem('online_users', userId);
               io.emit("presence:user_left", userId);
           }
       }, 5000);
    });

  }); // End io.on connection

  return io;
}