import { Server } from "socket.io";
import type { Server as HttpServer } from "http";
import { socketAuthMiddleware } from "./middleware/auth.js";
import { prisma } from "./lib/prisma.js";
import { sendPushNotification } from "./utils/sendPushNotification.js";
import crypto from "crypto";
import { redisClient } from "./lib/redis.js";

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
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  io.use(socketAuthMiddleware);

  io.on("connection", async (socket: any) => {
    const userId = socket.user?.id;

    // Handle authenticated users
    if (userId) {
      socket.join(userId);
      console.log(`[Socket Connect] User connected: ${userId}`);
      await redisClient.sAdd('online_users', userId);
      
      const onlineUserIds = await redisClient.sMembers('online_users');
      socket.emit("presence:init", onlineUserIds);
      socket.broadcast.emit("presence:user_joined", userId);
    } else {
      console.log(`[Socket Connect] Guest connected: ${socket.id}`);
    }

    // Handle device linking
    socket.on("linking:join_room", (roomId: string) => {
      if (!userId) { // Only non-authenticated sockets can join linking rooms
        socket.join(roomId);
        console.log(`[Linking] Guest ${socket.id} joined room ${roomId}`);
      }
    });

    socket.on("linking:send_payload", async (data: { roomId: string, encryptedMasterKey: string }) => {
      // This event must be from an authenticated user
      if (!userId) return;

      console.log(`[Linking Server] Received payload from ${userId} for room ${data.roomId}`);

      // Generate a single-use token for finalization
      const linkingToken = crypto.randomBytes(32).toString('hex');
      await redisClient.set(linkingToken, userId, { EX: 300 }); // 5 minutes expiry

      // Relay the payload to the new device in the specific room
      console.log(`[Linking Server] Relaying payload to room ${data.roomId}`);
      io.to(data.roomId).emit("linking:receive_payload", { 
        encryptedMasterKey: data.encryptedMasterKey,
        linkingToken: linkingToken, // Send the token to the new device
      });
    });

    socket.on("disconnect", async () => {
      if (userId) {
        console.log(`[Socket Disconnect] User disconnected: ${userId}`);
        await redisClient.sRem('online_users', userId);
        io.emit("presence:user_left", userId);
      } else {
        console.log(`[Socket Disconnect] Guest disconnected: ${socket.id}`);
      }
    });

    socket.on("conversation:join", (conversationId: string) => {
      socket.join(conversationId);
    });

    socket.on("typing:start", ({ conversationId }) => {
      if (conversationId && socket.user) {
        socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: true });
      }
    });

    socket.on("typing:stop", ({ conversationId }) => {
      if (conversationId && socket.user) {
        socket.to(conversationId).emit("typing:update", { userId: socket.user.id, conversationId, isTyping: false });
      }
    });

    socket.on("push:subscribe", async (data) => {
      try {
        const { endpoint, keys } = data;
        if (!userId || !endpoint || !keys?.p256dh || !keys?.auth) return;
        await prisma.pushSubscription.upsert({
          where: { endpoint },
          update: { p256dh: keys.p256dh, auth: keys.auth },
          create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userId },
        });
      } catch (error) {
        console.error("Failed to save push subscription:", error);
      }
    });

    socket.on('message:mark_as_read', async ({ messageId, conversationId }) => {
      try {
        if (!userId || !messageId) return;

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

    socket.on('session:request_key', async ({ conversationId, sessionId }) => {
      if (!userId || !conversationId || !sessionId) return;

      try {
        // 1. Find other participants in the same conversation
        const participants = await prisma.participant.findMany({
          where: {
            conversationId,
            userId: { not: userId }, // Exclude the requester
          },
          select: { userId: true },
        });

        // 2. Find which of them are online by checking against Redis
        const allOnlineUsers = await redisClient.sMembers('online_users');
        const allOnlineUsersSet = new Set(allOnlineUsers);
        const onlineParticipants = participants.filter(p => allOnlineUsersSet.has(p.userId));

        if (onlineParticipants.length === 0) {
          console.log(`[Key Request] No online users found in convo ${conversationId} to fulfill key request for ${sessionId}`);
          // Optional: could emit an event back to the requester indicating failure
          return;
        }

        // 3. Pick one online user to be the fulfiller (e.g., the first one)
        const fulfillerId = onlineParticipants[0].userId;

        // 3. Get the requester's public key
        const requester = await prisma.user.findUnique({
          where: { id: userId },
          select: { publicKey: true },
        });

        if (!requester?.publicKey) {
          console.error(`[Key Request] Requester ${userId} has no public key.`);
          return;
        }

        // 4. Emit an event to the fulfiller, asking them to re-encrypt the key
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

    socket.on('session:fulfill_response', ({ requesterId, conversationId, sessionId, encryptedKey }) => {
      if (!userId || !requesterId || !encryptedKey) return;

      // The fulfiller (current socket user) is sending a key for the requester.
      // Simply relay it to the requester.
      console.log(`[Key Fulfill] Relaying key for session ${sessionId} from ${userId} to ${requesterId}`);
      io.to(requesterId).emit('session:new_key', {
        conversationId,
        sessionId,
        encryptedKey,
      });
    });

  });

  return io;
}
