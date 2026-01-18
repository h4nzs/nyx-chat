import { Server, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { verifyJwt } from "./utils/jwt.js";
import { sendPushNotification } from "./utils/sendPushNotification.js";
import { redisClient } from "./lib/redis.js";
import { Message } from "@prisma/client";
import { AuthPayload } from "./types/auth.js";
import cookie from "cookie"; // Pastikan install: pnpm add cookie @types/cookie
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
    // === BAGIAN PERBAIKAN KONEKSI (JANGAN DIHAPUS) ===
    cors: {
      origin: (origin, callback) => {
        // 1. Izinkan request tanpa origin (mobile apps/curl)
        if (!origin) return callback(null, true);

        // 2. Daftar domain yang diizinkan (Localhost)
        const allowedOrigins = [
          env.corsOrigin, 
          "http://localhost:5173", 
          "http://localhost:4173"
        ];

        // 3. Cek apakah origin valid (termasuk Vercel & Render)
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
      credentials: true, // Wajib true agar cookie dikirim
      methods: ["GET", "POST"]
    },
    path: '/socket.io', // Pastikan path sesuai dengan client
    transports: ['polling', 'websocket'], // Polling wajib aktif untuk Vercel Proxy
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // Buffer 2 menit
      skipMiddlewares: true,
    },
    allowEIO3: true, // Kompatibilitas maksimum
    pingTimeout: 20000,
    pingInterval: 25000
    // === AKHIR BAGIAN PERBAIKAN ===
  });

  // === MIDDLEWARE AUTH MANUAL (LEBIH ROBUST UNTUK PROXY) ===
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
        return next(new Error("Authentication error: Token missing"));
      }

      const payload = verifyJwt(token);
      if (!payload || typeof payload === 'string') {
        return next(new Error("Authentication error: Invalid token"));
      }

      // Pastikan payload.id sesuai dengan struktur JWT Anda (kadang 'sub', kadang 'id')
      // @ts-ignore
      const userId = payload.id || payload.sub;

      const user = await prisma.user.findUnique({ 
        where: { id: userId } 
      });

      if (!user) {
        return next(new Error("Authentication error: User not found"));
      }

      // Mapping ke AuthPayload yang diharapkan aplikasi
      socket.user = {
        id: user.id,
        email: user.email,
        username: user.username,
        // tambahkan field lain jika AuthPayload memintanya
      };
      
      next();
    } catch (err) {
      console.error("[Socket Auth] Error:", err);
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", async (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    if (userId) {
      socket.join(userId);
      // Jika connectionStateRecovery aktif, socket.recovered akan true saat reconnect
      if (!socket.recovered) {
          console.log(`[Socket Connect] User connected: ${userId}`);
          await redisClient.sAdd('online_users', userId);
          const onlineUserIds = await redisClient.sMembers('online_users');
          socket.emit("presence:init", onlineUserIds);
          socket.broadcast.emit("presence:user_joined", userId);
      } else {
          console.log(`[Socket Recovered] User recovered session: ${userId}`);
      }
    }

    // === LOGIKA ASLI (DIKEMBALIKAN SEMUA) ===

    socket.on("linking:join_room", (roomId: string) => {
      if (!userId) {
        socket.join(roomId);
        console.log(`[Linking] Guest ${socket.id} joined room ${roomId}`);
      }
    });

    socket.on("linking:send_payload", async (data: { roomId: string, encryptedMasterKey: string }) => {
      if (!userId) return;
      console.log(`[Linking Server] Received payload from ${userId} for room ${data.roomId}`);
      const linkingToken = crypto.randomBytes(32).toString('hex');
      await redisClient.set(linkingToken, userId, { EX: 300 });
      io.to(data.roomId).emit("linking:receive_payload", { 
        encryptedMasterKey: data.encryptedMasterKey,
        linkingToken: linkingToken,
      });
    });

    socket.on("disconnect", async () => {
      if (userId) {
        // Delay sedikit update presence untuk handle refresh page/reconnect cepat
        setTimeout(async () => {
            const sockets = await io.in(userId).fetchSockets();
            if (sockets.length === 0) {
                console.log(`[Socket Disconnect] User disconnected: ${userId}`);
                await redisClient.sRem('online_users', userId);
                io.emit("presence:user_left", userId);
            }
        }, 5000);
      }
    });

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
      if (!userId || !keys || !Array.isArray(keys) || !conversationId) return;
      console.log(`[Key Distribution] User ${userId} is distributing ${keys.length} key(s) for conversation ${conversationId}`);
      try {
        const participant = await prisma.participant.findFirst({
          where: { conversationId, userId },
        });
        if (!participant) {
          console.error(`[Key Distribution] User ${userId} is not a participant of conversation ${conversationId}`);
          return;
        }
        keys.forEach(keyPackage => {
          if (keyPackage.userId && keyPackage.key) {
            io.to(keyPackage.userId).emit('session:new_key', {
              conversationId,
              encryptedKey: keyPackage.key,
              type: 'GROUP_KEY',
              senderId: userId // Tambahkan senderId agar client tahu sumber kunci
            });
          } else {
            console.warn(`[Key Distribution] Invalid key package for conversation ${conversationId}`);
          }
        });
      } catch (error) {
        console.error(`[Key Distribution] Error distributing keys for conversation ${conversationId}:`, error);
      }
    });

    socket.on('message:send', async (message: MessageSendPayload, callback: (res: { ok: boolean, msg?: Message, error?: string }) => void) => {
      if (!userId) return callback?.({ ok: false, error: "Not authenticated." });
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
          return callback?.({ ok: false, error: "Conversation not found or you are not a participant." });
        }
        
        // Simpan pesan ke DB
        const newMessage = await prisma.message.create({
          data: { conversationId, senderId: userId, content, sessionId },
          include: { sender: { select: { id: true, name: true, avatarUrl: true, username: true } } }
        });
        
        const finalMessage = { ...newMessage, tempId };
        
        // Broadcast ke partisipan lain
        conversation.participants.forEach(participant => {
          io.to(participant.userId).emit('message:new', finalMessage);
          
          // Kirim Push Notification (jika bukan pengirim)
          if (participant.userId !== userId) {
             // Panggil fungsi utilitas push notification Anda
             sendPushNotification(participant.userId, {
                 title: newMessage.sender.name || newMessage.sender.username,
                 body: "Sent a secure message", // Jangan tampilkan isi pesan terenkripsi
                 url: `/chat/${conversationId}`
             }).catch(console.error);
          }
        });
        
        callback?.({ ok: true, msg: finalMessage });
      } catch (error) {
        console.error("Failed to process message:send event:", error);
        callback?.({ ok: false, error: "Failed to save or distribute message." });
      }
    });

    socket.on("push:subscribe", async (data: PushSubscribePayload) => {
      if (!userId || !data.endpoint || !data.keys?.p256dh || !data.keys?.auth) return;
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
      if (!userId || !messageId) return;
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

    // --- Handlers for E2EE Key Recovery ---
    socket.on('group:request_key', async ({ conversationId }: GroupKeyRequestPayload) => {
      if (!userId || !conversationId) return;
      console.log(`[Group Key Request] User ${userId} is requesting key for conversation ${conversationId}`);
      try {
        const participants = await prisma.participant.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
        if (onlineParticipants.length === 0) {
          console.log(`[Group Key Request] No online users found in ${conversationId} to fulfill key request.`);
          return;
        }
        const fulfillerId = onlineParticipants[0].userId;
        const requester = await prisma.user.findUnique({
          where: { id: userId },
          select: { publicKey: true },
        });
        if (!requester?.publicKey) {
          console.error(`[Group Key Request] Requester ${userId} has no public key.`);
          return;
        }
        console.log(`[Group Key Request] Asking ${fulfillerId} to fulfill key request for ${userId}.`);
        io.to(fulfillerId).emit('group:fulfill_key_request', {
          conversationId,
          requesterId: userId,
          requesterPublicKey: requester.publicKey,
        });
      } catch (error) {
        console.error(`[Group Key Request] Error processing group:request_key for ${conversationId}:`, error);
      }
    });

    // FIX: Gunakan nama event 'group:fulfilled_key' sesuai dengan Client
    socket.on('group:fulfilled_key', ({ requesterId, conversationId, encryptedKey }: KeyFulfillmentPayload) => {
      if (!userId || !requesterId || !conversationId || !encryptedKey) return;
      console.log(`[Group Key Fulfill] Relaying group key for ${conversationId} from ${userId} to ${requesterId}`);
      io.to(requesterId).emit('session:new_key', {
        conversationId,
        encryptedKey,
        type: 'GROUP_KEY',
        senderId: userId // Tambahkan sender
      });
    });

    socket.on('session:request_key', async ({ conversationId, sessionId }: KeyRequestPayload) => {
      if (!userId || !conversationId || !sessionId) return;
      try {
        const participants = await prisma.participant.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
        if (onlineParticipants.length === 0) {
          console.log(`[Key Request] No online users found in convo ${conversationId} to fulfill key request for ${sessionId}`);
          return;
        }
        const fulfillerId = onlineParticipants[0].userId;
        const requester = await prisma.user.findUnique({
          where: { id: userId },
          select: { publicKey: true },
        });
        if (!requester?.publicKey) {
          console.error(`[Key Request] Requester ${userId} has no public key.`);
          return;
        }
        console.log(`[Key Request] Asking ${fulfillerId} to fulfill key request for ${userId} (session: ${sessionId})`);
        io.to(fulfillerId).emit('session:fulfill_request', {
          conversationId,
          sessionId,
          requesterId: userId,
          requesterPublicKey: requester.publicKey,
        });
      } catch (error) {
        console.error('[Key Request] Error processing session:request_key', error);
      }
    });

    socket.on('session:fulfill_response', ({ requesterId, conversationId, sessionId, encryptedKey }: KeyFulfillmentPayload) => {
      if (!userId || !requesterId || !encryptedKey) return;
      console.log(`[Key Fulfill] Relaying key for session ${sessionId} from ${userId} to ${requesterId}`);
      io.to(requesterId).emit('session:new_key', {
        conversationId,
        sessionId,
        encryptedKey,
        type: 'SESSION_KEY', // Tambahkan tipe agar jelas
        senderId: userId
      });
    });
  });

  return io;
}