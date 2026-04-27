// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { Server, Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { verifyJwt } from "./utils/jwt.js";
import { sendPushNotification } from "./utils/sendPushNotification.js";
import { redisClient } from "./lib/redis.js"; 
import { AuthPayload } from "./types/auth.js";
import cookie from "cookie"; 
import { getSodium } from "./lib/sodium.js";

const terminatedBurners = new Set<string>();

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

// ✅ FIX: Tambahkan deviceId ke dalam interface
interface AuthenticatedSocket extends Socket<ClientToServerEvents, ServerToClientEvents> {
  user?: AuthPayload & { publicKey?: string | null, pqPublicKey?: string | null, deviceId?: string };
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
        const baseOrigins = Array.isArray(env.corsOrigin) ? env.corsOrigin : [env.corsOrigin];
        const allowedOrigins = [
          ...baseOrigins, 
          "http://localhost:5173", 
          "http://localhost:4173",
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
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true },
    allowEIO3: true,
    pingTimeout: 30000,
    pingInterval: 35000 
  });

  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redisOptions = { url: redisUrl, socket: { keepAlive: true, reconnectStrategy: (retries: number) => Math.min(retries * 50, 2000) } };

  const pubClient = createClient(redisOptions);
  const subClient = pubClient.duplicate();

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => { io.adapter(createAdapter(pubClient, subClient)); })
    .catch((err) => { console.error("❌ Socket.IO Redis Adapter Connection Failed:", err); });

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
        socket.user = undefined;
        return next(); 
      }

      // ✅ FIX: Konversi tipe payload agar mencakup deviceId
      const payload = verifyJwt(token) as { id?: string; sub?: string; role?: string; deviceId?: string } | null | string;
      if (!payload || typeof payload === 'string') {
        socket.user = undefined;
        return next();
      }

      const userId = payload.id || payload.sub;
      const deviceId = payload.deviceId;

      if (!userId || !deviceId) {
        socket.user = undefined;
        return next();
      }

      // ✅ FIX: Ambil publicKey dari relasi devices, bukan langsung dari user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, devices: { where: { id: deviceId }, select: { publicKey: true, pqPublicKey: true } } }
      });
      if (!user || user.devices.length === 0) {
        socket.user = undefined;
        return next();
      }

      socket.user = {
        id: user.id,
        publicKey: Buffer.from(user.devices[0].publicKey).toString('base64url'),
        pqPublicKey: user.devices[0].pqPublicKey ? Buffer.from(user.devices[0].pqPublicKey).toString('base64url') : null,
        deviceId: deviceId
      };      next();
    } catch (err) {
      console.error("[Socket] Auth Middleware Error:", err);
      socket.user = undefined;
      next();
    }
  });

  io.on("connection", async (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    // BURNER EVENTS (Accessible to both unauth Guests and auth Hosts)
    socket.on('burner:join', (payload: { roomId: string }) => {
      if (payload && payload.roomId && typeof payload.roomId === 'string') {
        if (terminatedBurners.has(payload.roomId)) {
          socket.emit('burner:terminated', { roomId: payload.roomId });
          return;
        }
        socket.join(payload.roomId);
      }
    });

    socket.on('burner:send', async (payload: { roomId: string, targetDeviceId: string, ciphertext: string, hostUserId: string }, callback) => {
        if (!payload.targetDeviceId || !payload.hostUserId) {
            return callback?.({ ok: false, error: "Invalid burner routing metadata" });
        }
        if (terminatedBurners.has(payload.roomId)) {
            return callback?.({ ok: false, error: "Room has been terminated." });
        }
        try {
            const targetSockets = await io.in(payload.hostUserId).fetchSockets();
            let delivered = false;
            for (const s of targetSockets) {
                const authSocket = s as unknown as AuthenticatedSocket;
                if (authSocket.user?.deviceId === payload.targetDeviceId) {
                    authSocket.emit('burner:receive', {
                        roomId: payload.roomId,
                        ciphertext: payload.ciphertext
                    });
                    delivered = true;
                }
            }
            if (delivered) {
                callback?.({ ok: true });
            } else {
                callback?.({ ok: false, error: "Host device is offline or unavailable." });
            }
        } catch (e) {
            callback?.({ ok: false, error: "Routing failed." });
        }
    });

    socket.on('burner:reply', (payload: { roomId: string, ciphertext: string }) => {
        if (payload?.roomId && payload?.ciphertext) {
            if (terminatedBurners.has(payload.roomId)) return;
            io.to(payload.roomId).emit('burner:receive', { roomId: payload.roomId, ciphertext: payload.ciphertext });
        }
    });

    socket.on('burner:destroy', (payload: { roomId: string }) => {
        if (payload?.roomId) {
            terminatedBurners.add(payload.roomId);
            io.to(payload.roomId).emit('burner:terminated', { roomId: payload.roomId });
            io.in(payload.roomId).socketsLeave(payload.roomId);
        }
    });

    if (!userId) {
      socket.on("auth:request_linking_qr", async (payload: { publicKey: string }, callback) => {
         const sodium = await getSodium();
         const linkingToken = sodium.to_hex(sodium.randombytes_buf(32));
         await socket.join(`linking:${linkingToken}`);
         if (typeof callback === 'function') callback({ ok: true, qrData: linkingToken });
      });

      socket.on('migration:join', (roomId: string) => {
        if (typeof roomId === 'string' && roomId.startsWith('mig_') && roomId.length > 20) {
          socket.join(roomId);
        } else {
          socket.emit("error", { message: "Invalid migration room" });
        }
      });

      socket.on('migration:ack', (data: { roomId: string, success: boolean }) => {
        if (data && data.roomId) socket.to(data.roomId).emit('migration:ack', data);
      });

      return;
    }

    socket.join(userId);

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

    const checkRateLimit = async (userIdStr: string, event: string, limit: number, windowSeconds: number): Promise<boolean> => {
      const key = `rate_limit:socket:${event}:${userIdStr}`;
      const current = await redisClient.incr(key);
      if (current === 1) {
        await redisClient.expire(key, windowSeconds);
      }
      return current <= limit;
    };

    socket.on("conversation:join", async (conversationId: string) => {
      if (!await checkRateLimit(userId, 'join', 10, 60)) return socket.emit("error", { message: "Rate limit exceeded" });
      try {
        const participant = await prisma.participant.findUnique({
          where: { userId_conversationId: { userId, conversationId } }
        });
        if (participant) socket.join(conversationId);
      } catch (e) {}
    });

    socket.on("typing:start", async ({ conversationId }: TypingPayload) => {
      if (!await checkRateLimit(userId, 'typing', 20, 10)) return; 
      if (conversationId && socket.user) socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: true });
    });

    socket.on("typing:stop", ({ conversationId }: TypingPayload) => {
       if (conversationId && socket.user) socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: false });
    });

    socket.on('messages:distribute_keys', async ({ conversationId, keys }: DistributeKeysPayload) => {
      if (!await checkRateLimit(userId, 'keys', 50, 60)) return; 
      if (!keys || !Array.isArray(keys) || !conversationId) return;
      
      try {
        const participant = await prisma.participant.findFirst({ where: { conversationId, userId } });
        if (!participant) return;
        
        // ✅ SMART ROUTING: Kirim kunci HANYA ke perangkat tujuan
        for (const keyPackage of keys) {
          if (keyPackage.userId && keyPackage.key) {
            
            if (keyPackage.targetDeviceId) {
               // Cari semua socket milik user tujuan
               const targetSockets = await io.in(keyPackage.userId).fetchSockets();
               
               for (const s of targetSockets) {
                  const authSocket = s as unknown as AuthenticatedSocket;
                  // Tembakkan hanya jika deviceId socket cocok dengan targetDeviceId
                  if (authSocket.user?.deviceId === keyPackage.targetDeviceId) {
                      authSocket.emit('session:new_key', {
                          conversationId,
                          encryptedKey: keyPackage.key,
                          type: 'GROUP_KEY',
                          senderId: userId,
                          senderDeviceKey: keyPackage.senderDeviceKey
                      });
                  }
               }
            } else {
               // Fallback: Jika tidak ada targetDeviceId, broadcast ke semua (untuk kompabilitas mundur)
               io.to(keyPackage.userId).emit('session:new_key', {
                  conversationId,
                  encryptedKey: keyPackage.key,
                  type: 'GROUP_KEY',
                  senderId: userId,
                  senderDeviceKey: keyPackage.senderDeviceKey
               });
            }
            
          }
        }
      } catch (error) {
        console.error(`[Key Distribution] Error:`, error);
      }
    });

    socket.on('message:send', async (message: MessageSendPayload, callback: (res: { ok: boolean, msg?: RawServerMessage, error?: string }) => void) => {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { isVerified: true } });

      if (!user?.isVerified) {
          try {
              const key = `sandbox:msg:${userId}`;
              const luaScript = `local c = redis.call("INCR", KEYS[1]); if c == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end; return c;`;
              const count = await redisClient.eval(luaScript, { keys: [key], arguments: ['60'] }) as number;
              if (count > 5) return callback?.({ ok: false, error: "SANDBOX_LIMIT_REACHED: Max 5 messages per minute. Verify account to unlock." });
          } catch (redisError) {
              return callback?.({ ok: false, error: "Service unavailable. Try again later." });
          }
      }

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

        const newMessageRaw = await prisma.message.create({
          data: { 
              conversationId, senderId: userId, content, sessionId: sessionId || null,
              repliedToId: repliedToId || null, expiresAt: expiresAt ? new Date(expiresAt) : null, isViewOnce: isViewOnce === true
          },
          include: { sender: { select: { id: true, encryptedProfile: true } } }
        });
        
        const safeMessage = toRawServerMessage(newMessageRaw);
        if (tempId !== undefined) safeMessage.tempId = typeof tempId === 'string' ? parseInt(tempId, 10) : tempId;
        
        conversation.participants.forEach(participant => {
          io.to(participant.userId).emit('message:new', safeMessage);
          if (participant.userId !== userId) {
             sendPushNotification(participant.userId, {
                 type: pushPayloads ? 'ENCRYPTED_MESSAGE' : 'GENERIC_MESSAGE',
                 data: { conversationId, messageId: safeMessage.id, pushPayloadMap: pushPayloads || undefined }
             }).catch(console.error);
          }
        });
        
        callback?.({ ok: true, msg: safeMessage });
      } catch (error) {
        callback?.({ ok: false, error: "Failed to send." });
      }
    });

    socket.on('message:unsend', async ({ messageId, conversationId }: { messageId: string, conversationId: string }) => {
      if (!messageId || !socket.user) return;
      const uid = socket.user.id;

      try {
        const msg = await prisma.message.findUnique({
          where: { id: messageId },
          select: { senderId: true, conversationId: true }
        });

        if (!msg || msg.conversationId !== conversationId || msg.senderId !== uid) return;

        await prisma.message.deleteMany({ where: { id: messageId, senderId: uid } });
        socket.to(conversationId).emit('message:deleted_remotely', { messageId, conversationId, deletedBy: uid });
      } catch (error) {}
    });

    socket.on('message:view_once_opened', async ({ messageId, conversationId }: { messageId: string, conversationId: string }) => {
        if (!messageId || !conversationId || !socket.user) return;
        const uid = socket.user.id;

        try {
            const isParticipant = await prisma.participant.findUnique({ where: { userId_conversationId: { userId: uid, conversationId } } });
            if (!isParticipant) return;

            const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, senderId: true } });
            if (!msg || msg.conversationId !== conversationId) return;

            if (msg.senderId === uid) return;

            socket.to(conversationId).emit('message:viewed', { messageId, conversationId });
        } catch (error) {}
    });

    socket.on("push:subscribe", async (data: PushSubscribePayload) => {
      // ✅ FIX: Ambil deviceId langsung dari session properties dengan aman
      if (!socket.user || !socket.user.deviceId) return;
      const deviceId = socket.user.deviceId;

      if (!data.endpoint || !data.keys?.p256dh || !data.keys?.auth) return;
      try {
        await prisma.pushSubscription.upsert({
          where: { endpoint: data.endpoint },
          update: { p256dh: data.keys.p256dh, auth: data.keys.auth, deviceId },
          create: { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, deviceId },
        });
      } catch (error) {
        console.error("Failed to save push subscription:", error);
      }
    });

    socket.on('message:mark_as_read', async ({ messageId, conversationId }: MarkAsReadPayload) => {
      if (!messageId || !socket.user) return;
      const uid = socket.user.id;

      try {
        const msg = await prisma.message.findUnique({
          where: { id: messageId },
          select: { id: true, conversationId: true, senderId: true, conversation: { select: { isGroup: true } } }
        });
        if (!msg || msg.conversationId !== conversationId) return;

        const isParticipant = await prisma.participant.findUnique({ where: { userId_conversationId: { userId: uid, conversationId } } });
        if (!isParticipant) return;

        if (msg.senderId === uid) return;

        await prisma.participant.update({
          where: { userId_conversationId: { userId: uid, conversationId } },
          data: { lastReadMsgId: messageId }
        });

        if (msg.senderId !== uid) {
          io.to(msg.senderId).emit('message:status_updated', { messageId, conversationId: msg.conversationId, readBy: uid, status: 'READ' });
        }

        if (msg.conversation.isGroup) {
           await prisma.messageStatus.upsert({
             where: { messageId_userId: { messageId, userId: uid } },
             update: { status: 'READ' },
             create: { messageId, userId: uid, status: 'READ' },
           });
        }
      } catch (error) {}
    });

    // --- E2EE Key Recovery Handlers ---
    
    socket.on('group:request_key', async ({ conversationId, targetSenderId, targetDeviceKey }: GroupKeyRequestPayload) => {
      if (!conversationId) return;
      
      const isParticipant = await prisma.participant.findFirst({
        where: { conversationId, userId: socket.user!.id }
      });
      if (!isParticipant) return;

      try {
        let fulfillerSocket = null;
        let fulfillerId = null;

        // 1. Ask specific target if provided
        if (targetSenderId) {
             const targetSockets = await io.in(targetSenderId).fetchSockets();
             if (targetDeviceKey) {
                 const matchingSocket = targetSockets.find(s => (s as unknown as AuthenticatedSocket).user?.publicKey === targetDeviceKey);
                 if (matchingSocket) {
                     fulfillerSocket = matchingSocket;
                     fulfillerId = targetSenderId;
                 }
             } else if (targetSockets.length > 0) {
                 // Fallback to another socket of that user ONLY if targetDeviceKey was not provided
                 const other = targetSockets.find(s => s.id !== socket.id);
                 if (other) {
                     fulfillerSocket = other;
                     fulfillerId = targetSenderId;
                 }
             }
        }

        // 2. Fallback to random online participant
        if (!fulfillerSocket) {
            const participants = await prisma.participant.findMany({
              where: { conversationId, userId: { not: userId } },
              select: { userId: true },
            });
            const allOnlineUsers = await redisClient.sMembers('online_users');
            const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
            
            if (onlineParticipants.length > 0) {
              fulfillerId = onlineParticipants[0].userId;
              const sockets = await io.in(fulfillerId).fetchSockets();
              if (sockets.length > 0) fulfillerSocket = sockets[0];
            }
        }
        
        if (fulfillerSocket && fulfillerId) {
          const requesterPublicKey = socket.user?.publicKey;
          const requesterPqPublicKey = socket.user?.pqPublicKey;
          const requesterDeviceId = socket.user?.deviceId;

          if (requesterPublicKey && requesterPqPublicKey) {
            fulfillerSocket.emit('group:fulfill_key_request', {
              conversationId,
              requesterId: userId,
              requesterPublicKey,
              requesterPqPublicKey,
              requesterDeviceId
            });
          } else {
             socket.emit("group:key_request_failed", { conversationId, reason: "Missing classical or PQ public key" });
          }
        }      } catch (error) {}
    });

    socket.on('group:fulfilled_key', async (payload: KeyFulfillmentPayload) => {
      const { requesterId, conversationId, encryptedKey, targetDeviceId, senderDeviceKey } = payload;
      if (!requesterId || !conversationId || !encryptedKey) return;
      
      const emitPayload = { conversationId, encryptedKey, type: 'GROUP_KEY' as const, senderId: userId, senderDeviceKey };
      
      if (targetDeviceId) {
         const targetSockets = await io.in(requesterId).fetchSockets();
         for (const s of targetSockets) {
            const authSocket = s as unknown as AuthenticatedSocket;
            if (authSocket.user?.deviceId === targetDeviceId) {
                authSocket.emit('session:new_key', emitPayload);
            }
         }
      } else {
         io.to(requesterId).emit('session:new_key', emitPayload);
      }
    });

    socket.on("session:request_missing", async ({ conversationId, sessionId }: { conversationId: string, sessionId: string }) => {
      try {
        const uid = socket.user?.id;
        if (!uid) return;

        const isParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: uid } });
        if (!isParticipant) return;

        if (!await checkRateLimit(uid, 'session_request_missing', 10, 60)) return;
        socket.to(conversationId).emit("session:key_requested", { requesterId: uid, conversationId, sessionId });
      } catch (error) {}
    });

    socket.on('session:request_key', async (data: KeyRequestPayload) => {
      const { conversationId, sessionId, targetId } = data;
      if (!conversationId) return;

      if (targetId) {
          try {
            const participants = await prisma.participant.findMany({
              where: { conversationId, userId: { in: [userId, targetId] } },
              select: { userId: true }
            });

            const participantIds = participants.map(p => p.userId);
            if (!participantIds.includes(userId) || !participantIds.includes(targetId)) return;

            io.to(targetId).emit('session:request_key', { 
              conversationId, 
              requesterId: userId, 
              sessionId,
              requesterPublicKey: socket.user?.publicKey || undefined,
              requesterPqPublicKey: socket.user?.pqPublicKey || undefined,
              requesterDeviceId: socket.user?.deviceId || socket.id
            });
          } catch (error) {}
          return;
      }

      if (!sessionId) return;

      const isParticipant = await prisma.participant.findFirst({ where: { conversationId, userId: socket.user!.id } });
      if (!isParticipant) return;

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
          const requesterPqPublicKey = socket.user?.pqPublicKey;

          if (requesterPublicKey && requesterPqPublicKey) {
            io.to(fulfillerId).emit('session:fulfill_request', { conversationId, sessionId, requesterId: userId, requesterPublicKey: requesterPublicKey, requesterPqPublicKey: requesterPqPublicKey });
          } else {
            socket.emit("session:request_key_failed", { sessionId, targetId: fulfillerId, reason: "Missing PQ or classical public key" });
          }
        }      } catch (error) {}
    });

    socket.on('session:fulfill_response', async (payload: KeyFulfillmentPayload) => {
      const { requesterId, conversationId, sessionId, encryptedKey, targetDeviceId } = payload;
      if (!requesterId || !encryptedKey) return;
      const emitPayload = { conversationId, sessionId, encryptedKey, type: 'SESSION_KEY' as const, senderId: userId };
      
      if (targetDeviceId) {
         const targetSockets = await io.in(requesterId).fetchSockets();
         for (const s of targetSockets) {
            const authSocket = s as unknown as AuthenticatedSocket;
            if (authSocket.user?.deviceId === targetDeviceId) {
                authSocket.emit('session:new_key', emitPayload);
            }
         }
      } else {
         io.to(requesterId).emit('session:new_key', emitPayload);
      }
    });

    socket.on('webrtc:secure_signal', async (data: { to: string, type: string, payload: string }) => {
      if (!data || !data.to) return;
      if (!await checkRateLimit(userId, 'webrtc_signal', 20, 60)) {
        socket.emit("error", { message: "Rate limit exceeded for WebRTC signaling" });
        return;
      }
      socket.to(data.to).emit('webrtc:secure_signal', { from: userId, type: data.type, payload: data.payload });
    });

    socket.on('migration:join', (roomId: string) => {
      if (typeof roomId === 'string' && roomId.startsWith('mig_') && roomId.length > 20) socket.join(roomId);
    });

    socket.on('migration:start', async (data: { roomId: string, totalChunks: number, sealedKey: string }) => {
      if (!data || !data.roomId || typeof data.roomId !== 'string' || !data.roomId.startsWith('mig_') || data.roomId.length <= 20) return;
      if (!await checkRateLimit(userId, 'migration_start', 10, 60)) {
        socket.emit("error", { message: "Rate limit exceeded for migration" });
        return;
      }
      await redisClient.set(`migration_owner:${data.roomId}`, userId, { EX: 3600 });
      socket.to(data.roomId).emit('migration:start', data);
    });

    socket.on('migration:chunk', async (data: { roomId: string, chunkIndex: number, chunk: ArrayBuffer }) => {
      if (!data || !data.roomId || typeof data.roomId !== 'string') return;
      const ownerId = await redisClient.get(`migration_owner:${data.roomId}`);
      if (ownerId !== userId) return;
      socket.to(data.roomId).emit('migration:chunk', data);
    });

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