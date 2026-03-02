import { Server, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { verifyJwt, signAccessToken, newJti, refreshExpiryDate } from "./utils/jwt.js";
import { sendPushNotification } from "./utils/sendPushNotification.js";
import { redisClient } from "./lib/redis.js"; // Client untuk data aplikasi (Presence, dll)
import { Message } from "@prisma/client";
import { AuthPayload } from "./types/auth.js";
import cookie from "cookie"; 
import crypto from "crypto";

// --- REDIS ADAPTER IMPORTS ---
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";

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
  expiresAt?: string; // New field for Disappearing Messages
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
  user?: AuthPayload & { publicKey: string | null };
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
                callback(new Error('Not allowed by CORS'));        }
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

      // @ts-ignore
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
            callback({ token: linkingToken });
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
        await redisClient.sAdd('online_users', userId);
        const onlineUserIds = await redisClient.sMembers('online_users');
        socket.emit("presence:init", onlineUserIds);
        socket.broadcast.emit("presence:user_joined", userId);
    }

    // --- RATE LIMITER HELPER ---
    const checkRateLimit = async (userId: string, event: string, limit: number, windowSeconds: number): Promise<boolean> => {
      const key = `rate_limit:socket:${event}:${userId}`;
      const current = await redisClient.incr(key);
      if (current === 1) {
        await redisClient.expire(key, windowSeconds);
      }
      return current <= limit;
    };

    // --- CHAT FEATURES ---

    socket.on("conversation:join", async (conversationId: string) => {
      // 1. Rate Limit
      if (!await checkRateLimit(userId, 'join', 10, 60)) { // 10 joins / minute
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
        } else {
          // Silent fail or emit error? Silent is better for security (anti-guessing)
          // But for UX, maybe a generic error.
          // socket.emit("error", { message: "Unauthorized" });
        }
      } catch (e) {
        console.error("Error joining conversation:", e);
      }
    });

    socket.on("typing:start", async ({ conversationId }: TypingPayload) => {
      if (!await checkRateLimit(userId, 'typing', 20, 10)) return; // 20 typing events / 10s (prevent spam)

      if (conversationId && socket.user) {
        // Optional: Check membership if you want to be super paranoid, 
        // but since typing only goes to the room (which is secured above), it's less critical.
        // However, if they bypass join, they can't emit to the room unless they are IN it.
        // Socket.IO rooms require the socket to be joined.
        socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: true });
      }
    });

    socket.on("typing:stop", ({ conversationId }: TypingPayload) => {
       // Rate limit not strictly needed for stop, but good practice.
       if (conversationId && socket.user) {
        socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: false });
      }
    });

    socket.on('messages:distribute_keys', async ({ conversationId, keys }: DistributeKeysPayload) => {
      if (!await checkRateLimit(userId, 'keys', 50, 60)) return; // 50 key distributions / minute
      
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
      // 1. Sandbox Rate Limit (Strict)
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { isVerified: true } });
      if (!user?.isVerified) {
          const key = `sandbox:msg:${userId}`;
          const count = await redisClient.incr(key);
          if (count === 1) await redisClient.expire(key, 60);
          
          if (count > 5) {
              return callback?.({ ok: false, error: "SANDBOX_LIMIT_REACHED: Max 5 messages per minute. Verify account to unlock." });
          }
      }

      // 2. Standard Rate Limit
      if (!await checkRateLimit(userId, 'message', 15, 60)) { // 15 messages / minute
         return callback?.({ ok: false, error: "Rate limit exceeded. Slow down." });
      }

      const { conversationId, content, sessionId, tempId, expiresAt, isViewOnce } = message as any;

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
          data: { 
              conversationId, 
              senderId: userId, 
              content, 
              sessionId,
              expiresAt: expiresAt ? new Date(expiresAt) : null, // Save expiration
              isViewOnce: isViewOnce === true
          },
          include: { sender: { select: { id: true, encryptedProfile: true } } }
        });
        
        const finalMessage = { ...newMessage, tempId };
        
        conversation.participants.forEach(participant => {
          io.to(participant.userId).emit('message:new', finalMessage);
          
          if (participant.userId !== userId) {
             sendPushNotification(participant.userId, {
                 title: "Encrypted Message",
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
          // OPTIMIZATION: Use socket.user.publicKey instead of DB query
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

    socket.on("session:request_missing", async ({ conversationId, sessionId }) => {
      try {
        const userId = socket.user?.id;
        if (!userId) return;

        // Cek apakah user member grup
        // (Opsional: Query DB untuk validasi)

        // Broadcast ke semua member di room percakapan
        // "Hei, ada user (userId) yang butuh kunci sesi (sessionId) nih!"
        socket.to(conversationId).emit("session:key_requested", {
          requesterId: userId,
          conversationId,
          sessionId
        });

      } catch (error) {
        console.error("Error handling session request:", error);
      }
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
          // OPTIMIZATION: Use socket.user.publicKey instead of DB query
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

    // === WEBRTC SIGNALING (P2P CALLS) ===
    socket.on('call:request', (data: { to: string, isVideo: boolean, callerProfile: any }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('call:incoming', { from: userId, isVideo: data.isVideo, callerProfile: data.callerProfile });
    });

    socket.on('call:accept', (data: { to: string }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('call:accepted', { from: userId });
    });

    socket.on('call:reject', (data: { to: string, reason?: string }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('call:rejected', { from: userId, reason: data.reason || 'declined' });
    });

    socket.on('call:end', (data: { to: string }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('call:ended', { from: userId });
    });

    socket.on('webrtc:offer', (data: { to: string, offer: RTCSessionDescriptionInit }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('webrtc:offer', { from: userId, offer: data.offer });
    });

    socket.on('webrtc:answer', (data: { to: string, answer: RTCSessionDescriptionInit }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('webrtc:answer', { from: userId, answer: data.answer });
    });

    socket.on('webrtc:ice-candidate', (data: { to: string, candidate: RTCIceCandidateInit }) => {
      if (!data || !data.to) return;
      socket.to(data.to).emit('webrtc:ice-candidate', { from: userId, candidate: data.candidate });
    });

    // === DEVICE MIGRATION TUNNEL ===
    socket.on('migration:join', (roomId: string) => {
      // Allow logged-in user to join a migration room (just in case they are the receiver somehow)
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
      
      // Mark ownership of this room to the current authenticated user
      await redisClient.setEx(`migration_owner:${data.roomId}`, 3600, userId);
      socket.to(data.roomId).emit('migration:start', data);
    });

    socket.on('migration:chunk', async (data: { roomId: string, chunkIndex: number, chunk: any }) => {
      if (!data || !data.roomId || typeof data.roomId !== 'string') return;
      
      // Verify ownership
      const ownerId = await redisClient.get(`migration_owner:${data.roomId}`);
      if (ownerId !== userId) {
        socket.emit("error", { message: "Permission denied for this migration room" });
        return;
      }
      
      socket.to(data.roomId).emit('migration:chunk', data);
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