// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Server, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { verifyJwt } from "./utils/jwt.js";
import { sendPushNotification } from "./utils/sendPushNotification.js";
import { redisClient } from "./lib/redis.js"; // Client untuk data aplikasi (Presence, dll)
import { AuthPayload } from "./types/auth.js";
import cookie from "cookie"; 
import crypto from "crypto";

// --- REDIS ADAPTER IMPORTS ---
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { toRawServerMessage } from './utils/mappers.js';
import type { 
  ServerToClientEvents, 
  ClientToServerEvents, 
  TypingPayload,
  DistributeKeysPayload,
  MessageSendPayload,
  PushSubscribePayload,
  MarkAsReadPayload,
  KeyRequestPayload,
  GroupKeyRequestPayload,
  KeyFulfillmentPayload,
  RawServerMessage
} from "@nyx/shared";

// Extend the Socket type from Socket.IO to include our custom user property
interface AuthenticatedSocket extends Socket<ClientToServerEvents, ServerToClientEvents> {
  user?: AuthPayload & { publicKey?: string | null };
}

export let io: Server<ClientToServerEvents, ServerToClientEvents>;

export function getIo() {
  if (!io) {
    throw new Error("Socket.IO not initialized!");
  }
  return io;
}

export function registerSocket(httpServer: HttpServer) {
  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        
        // Ratakan array
        const baseOrigins = Array.isArray(env.corsOrigin) ? env.corsOrigin : [env.corsOrigin];

        const allowedOrigins = [
          ...baseOrigins, 
          "http://localhost:5173", 
          "http://localhost:4173",
          // Tambahkan domain HTTP untuk support Cloudflare Tunnel
          "http://nyx-app.my.id",
          "https://nyx-app.my.id",
          "http://*.nyx-app.my.id",
          "https://*.nyx-app.my.id"
        ];
        
        if (
          allowedOrigins.includes(origin) || 
          origin.endsWith('.vercel.app') || 
          origin.endsWith('.koyeb.app') ||
          origin.endsWith('.onrender.com') ||
          origin.endsWith('.nyx-app.my.id') ||
          origin.endsWith('.ngrok-free.app')
        ) {
          callback(null, true);
        } else {
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
    pingTimeout: 30000,
    pingInterval: 35000 
  });

  // === REDIS ADAPTER SETUP (CLUSTER MODE SUPPORT) ===
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  
  // Opsi socket yang sama dengan main client agar konsisten
  const redisOptions = {
    url: redisUrl,
    socket: {
      keepAlive: true,
      reconnectStrategy: (retries: number) => Math.min(retries * 50, 2000),
    }
  };

  const pubClient = createClient(redisOptions);
  const subClient = pubClient.duplicate();

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
    })
    .catch((err) => {
      console.error("❌ Socket.IO Redis Adapter Connection Failed:", err);
    });
  // ==================================================

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
        socket.user = undefined;
        return next(); 
      }

      const payload = verifyJwt(token);
      if (!payload || typeof payload === 'string') {
        socket.user = undefined;
        return next();
      }

      const userId = payload.id || payload.sub;
      // OPTIMIZATION: Select publicKey here
      const user = await prisma.user.findUnique({ 
        where: { id: userId },
        select: { id: true, publicKey: true }
      });

      if (!user) {
        socket.user = undefined;
        return next();
      }

      socket.user = { 
        id: user.id, 
        publicKey: user.publicKey 
      };
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
         
         const linkingToken = crypto.randomBytes(32).toString('hex');
         await socket.join(`linking:${linkingToken}`);
         
         if (typeof callback === 'function') {
            callback({ ok: true, qrData: linkingToken });
         }
      });

      // MIGRATION GUEST RECEIVER
      socket.on('migration:join', (roomId: string) => {
        if (typeof roomId === 'string' && roomId.startsWith('mig_') && roomId.length > 20) {
          socket.join(roomId);
        } else {
          socket.emit("error", { message: "Invalid migration room" });
        }
      });

      socket.on('migration:ack', (data: { roomId: string, success: boolean }) => {
        if (data && data.roomId) {
           socket.to(data.roomId).emit('migration:ack', data);
        }
      });

      socket.on("disconnect", () => {
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
        const userSocketsKey = `user:${userId}:sockets`;
        const added = await redisClient.sAdd(userSocketsKey, socket.id);
        const currentCount = await redisClient.sCard(userSocketsKey);
        
        if (added === 1 && currentCount === 1) {
            await redisClient.sAdd('online_users', userId);
            socket.broadcast.emit("presence:user_joined", userId);
        }
        
        const onlineUserIds = await redisClient.sMembers('online_users');
        socket.emit("presence:init", onlineUserIds);
    }

    // --- RATE LIMITER HELPER ---
    const checkRateLimit = async (userIdStr: string, event: string, limit: number, windowSeconds: number): Promise<boolean> => {
      const key = `rate_limit:socket:${event}:${userIdStr}`;
      const current = await redisClient.incr(key);
      if (current === 1) {
        await redisClient.expire(key, windowSeconds);
      }
      return current <= limit;
    };

    // --- CHAT FEATURES ---

    socket.on("conversation:join", async (conversationId: string) => {
      // 1. Rate Limit
      if (!await checkRateLimit(userId, 'join', 10, 60)) { 
        return socket.emit("error", { message: "Rate limit exceeded" });
      }

      // 2. Validate Membership
      try {
        const participant = await prisma.participant.findUnique({
          where: {
            userId_conversationId: {
              userId,
              conversationId
            }
          }
        });

        if (participant) {
          socket.join(conversationId);
        }
      } catch (e) {
        console.error("Error joining conversation:", e);
      }
    });

    socket.on("typing:start", async ({ conversationId }: TypingPayload) => {
      if (!await checkRateLimit(userId, 'typing', 20, 10)) return; 

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
      if (!await checkRateLimit(userId, 'keys', 50, 60)) return; 
      
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

    socket.on('message:send', async (message: MessageSendPayload, callback: (res: { ok: boolean, msg?: RawServerMessage, error?: string }) => void) => {
      // 1. Sandbox Rate Limit (Strict)
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { isVerified: true } });

      console.log(`[MESSAGE] User ${userId} isVerified: ${user?.isVerified}`);

      if (!user?.isVerified) {
          try {
              const key = `sandbox:msg:${userId}`;
              
              const luaScript = `
                local c = redis.call("INCR", KEYS[1]);
                if c == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end;
                return c;
              `;
              
              const count = await redisClient.eval(luaScript, {
                keys: [key],
                arguments: ['60']
              }) as number;

              if (count === 1) {
                  console.log(`[SANDBOX] User ${userId} sent message 1/5 (window starts)`);
              } else {
                  console.log(`[SANDBOX] User ${userId} sent message ${count}/5`);
              }

              if (count > 5) {
                  console.log(`[SANDBOX] User ${userId} blocked - limit reached (${count}/5)`);
                  return callback?.({ ok: false, error: "SANDBOX_LIMIT_REACHED: Max 5 messages per minute. Verify account to unlock." });
              }
          } catch (redisError) {
              console.error(`[SANDBOX] Redis error:`, redisError);
              return callback?.({ ok: false, error: "Service unavailable. Try again later." });
          }
      }

      // 2. Standard Rate Limit
      if (!await checkRateLimit(userId, 'message', 15, 60)) { 
         return callback?.({ ok: false, error: "Rate limit exceeded. Slow down." });
      }

      const { conversationId, content, sessionId, tempId, expiresAt, isViewOnce, pushPayloads, repliedToId } = message;

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

        // --- TYPE SAFE DB TRANSACTION ---
        const newMessageRaw = await prisma.message.create({
          data: { 
              conversationId, 
              senderId: userId, 
              content, 
              sessionId: sessionId || null,
              repliedToId: repliedToId || null,
              expiresAt: expiresAt ? new Date(expiresAt) : null, 
              isViewOnce: isViewOnce === true
          },
          include: { 
              sender: { select: { id: true, encryptedProfile: true } }
          }
        });
        
        // Mapping ke Type-Safe RawServerMessage
        const safeMessage = toRawServerMessage(newMessageRaw);
        
        if (tempId !== undefined) {
          safeMessage.tempId = typeof tempId === 'string' ? parseInt(tempId, 10) : tempId;
        }
        
        conversation.participants.forEach(participant => {
          io.to(participant.userId).emit('message:new', safeMessage);
          
          if (participant.userId !== userId) {
             const encryptedPushPayload = pushPayloads ? pushPayloads[participant.userId] : null;
             sendPushNotification(participant.userId, {
                 type: encryptedPushPayload ? 'ENCRYPTED_MESSAGE' : 'GENERIC_MESSAGE',
                 data: { conversationId, messageId: safeMessage.id, encryptedPushPayload: encryptedPushPayload || undefined }
             }).catch(console.error);
          }
        });
        
        callback?.({ ok: true, msg: safeMessage });
      } catch (error) {
        console.error("Failed to process message:", error);
        callback?.({ ok: false, error: "Failed to send." });
      }
    });

    socket.on('message:unsend', async ({ messageId, conversationId }: { messageId: string, conversationId: string }) => {
      if (!messageId || !socket.user) return;
      const uid = socket.user.id;

      try {
        // 1. Cek apakah pesan itu ada dan memang milik si pengirim
        const msg = await prisma.message.findUnique({
          where: { id: messageId },
          select: { senderId: true, conversationId: true }
        });

        if (!msg || msg.conversationId !== conversationId || msg.senderId !== uid) {
          return; // Abaikan jika bukan pesan miliknya
        }

        // 2. HANCURKAN DARI SERVER (Jika pesan masih belum terbaca/terkirim oleh penerima)
        await prisma.message.deleteMany({
          where: { id: messageId, senderId: uid } // Gunakan deleteMany agar tidak crash jika ID tidak ada
        });
        
        console.log(`[Zero-Knowledge] Pesan ${messageId} ditarik oleh pengirim dan dihapus dari server.`);

        // 3. Beri tahu Klien yang Sedang Online (Tombstone Relay)
        // Kita menggunakan socket untuk memberi sinyal real-time agar UI frontend langsung merespons
        socket.to(conversationId).emit('message:deleted_remotely', { 
          messageId, 
          conversationId,
          deletedBy: uid
        });

      } catch (error) {
        console.error('Failed to unsend message on server:', error);
      }
    });

    socket.on('message:view_once_opened', async ({ messageId, conversationId }: { messageId: string, conversationId: string }) => {
        if (!messageId || !conversationId || !socket.user) return;
        const uid = socket.user.id;

        try {
            // 1. Verify membership in the conversation
            const isParticipant = await prisma.participant.findUnique({
                where: { userId_conversationId: { userId: uid, conversationId } }
            });
            if (!isParticipant) return;

            // 2. Verify the message exists and belongs to this conversation
            const msg = await prisma.message.findUnique({
                where: { id: messageId },
                select: { conversationId: true, senderId: true }
            });
            if (!msg || msg.conversationId !== conversationId) return;

            // 3. Only broadcast if the viewer is NOT the sender (sender already knows)
            if (msg.senderId === uid) return;

            socket.to(conversationId).emit('message:viewed', { messageId, conversationId });
        } catch (error) {
            console.error('Failed to authorize view_once_opened:', error);
        }
    });

    socket.on("push:subscribe", async (data: PushSubscribePayload) => {
      if (!socket.user) return;
      const authUser = socket.user as { id: string; deviceId?: string };
      const deviceId = authUser.deviceId;
      if (!deviceId) return;

      try {
        await prisma.pushSubscription.upsert({
          where: { endpoint: data.endpoint },
          update: { p256dh: data.keys.p256dh, auth: data.keys.auth, deviceId },
          create: { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, deviceId },
        });
      } catch (error) {
        console.error('Failed to save push subscription:', error);
      }
    });

    socket.on('message:mark_as_read', async ({ messageId, conversationId }: MarkAsReadPayload) => {
      if (!messageId || !socket.user) return;
      const uid = socket.user.id;

      try {
        // 1. Ambil data pesan SEKALIGUS dengan info grup (hanya 1x query)
        const msg = await prisma.message.findUnique({
          where: { id: messageId },
          select: { 
            id: true, 
            conversationId: true, 
            senderId: true,
            conversation: { select: { isGroup: true } } // Join ringan untuk cek tipe chat
          }
        });
        if (!msg || msg.conversationId !== conversationId) return;

        // 2. Validasi apakah user tergabung dalam percakapan
        const isParticipant = await prisma.participant.findUnique({
          where: { userId_conversationId: { userId: uid, conversationId } }
        });
        if (!isParticipant) return;

        // ✅ FIX: Early return if the reader is the message sender (self-authored ACK)
        // No need to mutate server state for self-read receipts
        if (msg.senderId === uid) return;

        // 3. Update penanda baca terakhir dari participant
        await prisma.participant.update({
          where: { userId_conversationId: { userId: uid, conversationId } },
          data: { lastReadMsgId: messageId }
        });

        // 4. Beritahu pengirim bahwa pesan sudah dibaca (Centang Biru) via Socket
        if (msg.senderId !== uid) {
          io.to(msg.senderId).emit('message:status_updated', {
            messageId,
            conversationId: msg.conversationId,
            readBy: uid,
            status: 'READ',
          });
        }

        // 5. Store-and-Forward: Hancurkan vs Simpan Status
        if (!msg.conversation.isGroup) {
           // Jika ini chat pribadi (1-on-1), HANCURKAN pesan dari server
           await prisma.message.delete({
             where: { id: messageId }
           });
        } else {
           // Jika ini Grup, simpan status READ (penghapusan ditangani oleh messageSweeper setelah 14 hari)
           await prisma.messageStatus.upsert({
             where: { messageId_userId: { messageId, userId: uid } },
             update: { status: 'READ' },
             create: { messageId, userId: uid, status: 'READ' },
           });
        }

      } catch (error) {
        console.error('Failed to mark message as read:', error);
      }
    });

    // --- E2EE Key Recovery Handlers ---
    
    socket.on('group:request_key', async ({ conversationId }: GroupKeyRequestPayload) => {
      if (!conversationId) return;
      
      const isParticipant = await prisma.participant.findFirst({
        where: { conversationId, userId: socket.user!.id }
      });
      if (!isParticipant) {
        console.warn(`[Socket] Unauthorized key request from ${socket.user!.id}`);
        return;
      }

      try {
        const participants = await prisma.participant.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
        
        if (onlineParticipants.length > 0) {
          const fulfillerId = onlineParticipants[0].userId;
          const requesterPublicKey = socket.user?.publicKey;
          
          if (requesterPublicKey) {
            io.to(fulfillerId).emit('group:fulfill_key_request', {
              conversationId,
              requesterId: userId,
              requesterPublicKey: requesterPublicKey,
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

    socket.on("session:request_missing", async ({ conversationId, sessionId }: { conversationId: string, sessionId: string }) => {
      try {
        const uid = socket.user?.id;
        if (!uid) return;

        const isParticipant = await prisma.participant.findFirst({
          where: { conversationId, userId: uid }
        });

        if (!isParticipant) {
          console.warn(`[Socket] Unauthorized session key request from ${uid} to ${conversationId}`);
          return;
        }

        if (!await checkRateLimit(uid, 'session_request_missing', 10, 60)) {
          return socket.emit("error", { message: "Rate limit exceeded for missing key requests." });
        }

        socket.to(conversationId).emit("session:key_requested", {
          requesterId: uid,
          conversationId,
          sessionId
        });

      } catch (error) {
        console.error("Error handling session request:", error);
      }
    });

    socket.on('session:request_key', async (data: KeyRequestPayload) => {
      const { conversationId, sessionId, targetId } = data;
      if (!conversationId) return;

      if (targetId) {
          try {
            const participants = await prisma.participant.findMany({
              where: {
                conversationId,
                userId: { in: [userId, targetId] }
              },
              select: { userId: true }
            });

            const participantIds = participants.map(p => p.userId);
            if (!participantIds.includes(userId) || !participantIds.includes(targetId)) {
              socket.emit('error', { error: 'Unauthorized key request relay' });
              return;
            }

            io.to(targetId).emit('session:request_key', {
                conversationId,
                requesterId: userId,
                sessionId
            });
          } catch (error) {
            console.error("Error in targeted session:request_key:", error);
          }
          return;
      }

      if (!sessionId) return;

      const isParticipant = await prisma.participant.findFirst({
        where: { conversationId, userId: socket.user!.id }
      });
      if (!isParticipant) {
        console.warn(`[Socket] Unauthorized key request from ${socket.user!.id}`);
        return;
      }

      try {
        const participants = await prisma.participant.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
        
        if (onlineParticipants.length > 0) {
          const fulfillerId = onlineParticipants[0].userId;
          const requesterPublicKey = socket.user?.publicKey;
          
          if (requesterPublicKey) {
            io.to(fulfillerId).emit('session:fulfill_request', {
              conversationId,
              sessionId,
              requesterId: userId,
              requesterPublicKey: requesterPublicKey,
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

    // === WEBRTC E2EE SIGNALING (P2P CALLS) ===
    socket.on('webrtc:secure_signal', (data: { to: string, type: string, payload: string }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('webrtc:secure_signal', { from: userId, type: data.type, payload: data.payload });
    });

    // === DEVICE MIGRATION TUNNEL ===
    socket.on('migration:join', (roomId: string) => {
      if (typeof roomId === 'string' && roomId.startsWith('mig_') && roomId.length > 20) {
        socket.join(roomId);
      } else {
        socket.emit("error", { message: "Invalid migration room" });
      }
    });

    socket.on('migration:start', async (data: { roomId: string, totalChunks: number, sealedKey: string, iv: string }) => {
      if (!data || !data.roomId || typeof data.roomId !== 'string' || !data.roomId.startsWith('mig_')) {
        socket.emit("error", { message: "Invalid migration room payload" });
        return;
      }
      
      await redisClient.setEx(`migration_owner:${data.roomId}`, 3600, userId);
      socket.to(data.roomId).emit('migration:start', data);
    });

    // PENGHAPUSAN ANY DI SINI: ganti "chunk: any" dengan tipe yang valid (misalnya ArrayBuffer untuk binary)
    socket.on('migration:chunk', async (data: { roomId: string, chunkIndex: number, chunk: ArrayBuffer }) => {
      if (!data || !data.roomId || typeof data.roomId !== 'string') return;
      
      const ownerId = await redisClient.get(`migration_owner:${data.roomId}`);
      if (ownerId !== userId) {
        socket.emit("error", { message: "Permission denied for this migration room" });
        return;
      }
      
      socket.to(data.roomId).emit('migration:chunk', data);
    });

    // === PRESENCE MANAGEMENT (AWAY/ACTIVE) ===
    socket.on("user:away", async () => {
      if (!userId) return;
      const userSocketsKey = `user:${userId}:sockets`;
      await redisClient.sRem(userSocketsKey, socket.id);
      
      const remainingSockets = await redisClient.sCard(userSocketsKey);
      if (remainingSockets === 0) {
        await redisClient.sRem('online_users', userId);
        socket.broadcast.emit("presence:user_left", userId);
      }
    });

    socket.on("user:active", async () => {
      if (!userId) return;
      const userSocketsKey = `user:${userId}:sockets`;
      const added = await redisClient.sAdd(userSocketsKey, socket.id);
      const currentCount = await redisClient.sCard(userSocketsKey);
      
      if (added === 1 && currentCount === 1) {
        await redisClient.sAdd('online_users', userId);
        socket.broadcast.emit("presence:user_joined", userId);
      }
    });

    // Disconnect Handler
    socket.on("disconnect", async () => {
       const userSocketsKey = `user:${userId}:sockets`;
       await redisClient.sRem(userSocketsKey, socket.id);
       
       setTimeout(async () => {
           const remainingSockets = await redisClient.sCard(userSocketsKey);
           if (remainingSockets === 0) {
               await redisClient.sRem('online_users', userId);
               io.emit("presence:user_left", userId);
           }
       }, 5000);
    });

  }); 

  return io;
}