import { createClient, type RedisClientType } from 'redis';
import { prisma } from '../lib/prisma.js';
import { redisClient } from '../lib/redis.js';
import { getSodium } from '../lib/sodium.js';
import { toRawServerMessage } from '../utils/mappers.js';
import { sendPushNotification } from '../utils/sendPushNotification.js';
import { TransportOpCode } from '@nyx/shared';
import type { MessageSendPayload, ServerToClientEvents, ClientToServerEvents, RawServerMessage, KeyRequestPayload, KeyFulfillmentPayload, GroupKeyRequestPayload, DistributeKeysPayload, PushSubscribePayload } from '@nyx/shared';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Unified connection management
export const pubClient: RedisClientType = createClient({ url: redisUrl });
export const subClient: RedisClientType = pubClient.duplicate();

export async function initializeRedisBridge() {
  await Promise.all([pubClient.connect(), subClient.connect()]);
  console.log('🌐 Redis Bridge initialized and connected.');

  // Subscribe to all upstream messages from Rust Sidecar
  await subClient.pSubscribe('nyx:upstream:*', async (message, channel) => {
    try {
      const opCode = parseInt(channel.split(':').pop() || '0', 10);
      const data = JSON.parse(message) as { user_id: string; device_id: string; op_code: number; payload: string; msgId?: string };
      
      await handleUpstreamMessage(data.user_id, data.device_id, opCode, data.payload, data.msgId);
    } catch (error) {
      console.error('❌ Error processing upstream message:', error);
    }
  });
}

/**
 * Sends a message to the Rust Sidecar to be delivered to a specific client.
 */
export async function sendToUser(targetUserId: string, opCode: TransportOpCode, base64Payload: string, isDatagram = false, deviceId?: string) {
  const downstreamPayload = {
    user_id: targetUserId,
    device_id: deviceId,
    op_code: opCode,
    is_datagram: isDatagram,
    payload: base64Payload
  };
  await pubClient.publish('nyx:downstream', JSON.stringify(downstreamPayload));
}

export async function sendToDevice(targetUserId: string, targetDeviceId: string, opCode: TransportOpCode, base64Payload: string, isDatagram = false) {
  await sendToUser(targetUserId, opCode, base64Payload, isDatagram, targetDeviceId);
}

/**
 * Emits a named event to a specific user (legacy compatibility).
 */
export async function emitEventToUser(userId: string, event: string, data: any, deviceId?: string) {
  await sendJsonToUser(userId, TransportOpCode.KEY_SYNC, { event, data }, false, deviceId);
}

/**
 * Emits a named event to all participants of a conversation.
 */
export async function emitEventToConversation(conversationId: string, event: string, data: any, excludeUserId?: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participants: { select: { userId: true } } }
  });
  
  if (!conversation) return;
  
  for (const participant of conversation.participants) {
    if (participant.userId === excludeUserId) continue;
    await emitEventToUser(participant.userId, event, data);
  }
}

/**
 * Emits a named event to multiple users.
 */
export async function emitEventToUsers(userIds: string[], event: string, data: any) {
  for (const userId of userIds) {
    await emitEventToUser(userId, event, data);
  }
}

/**
 * Utility to send JSON payload (encoded to Base64) to a user.
 */
export async function sendJsonToUser(targetUserId: string, opCode: TransportOpCode, data: any, isDatagram = false, deviceId?: string) {
  const base64 = Buffer.from(JSON.stringify(data)).toString('base64');
  await sendToUser(targetUserId, opCode, base64, isDatagram, deviceId);
}

/**
 * Broadcasts a message to all participants of a conversation.
 */
export async function broadcastToConversation(conversationId: string, opCode: TransportOpCode, data: unknown, excludeUserId?: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participants: { select: { userId: true } } }
  });
  
  if (!conversation) return;
  
  for (const participant of conversation.participants) {
    if (participant.userId === excludeUserId) continue;
    await sendJsonToUser(participant.userId, opCode, data);
  }
}

/**
 * Broadcasts a message to multiple users.
 */
export async function broadcastToUsers(userIds: string[], opCode: TransportOpCode, data: unknown) {
  for (const userId of userIds) {
    await sendJsonToUser(userId, opCode, data);
  }
}

async function handleUpstreamMessage(userId: string, deviceId: string, opCode: number, base64Payload: string, _msgIdFromWrapper?: string) {
  const buffer = Buffer.from(base64Payload, 'base64');
  const payloadStr = buffer.toString('utf-8');
  let payload: Record<string, unknown>;
  
  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>;
  } catch (e) {
    payload = { raw: payloadStr };
  }
  
  const msgId = typeof payload?.msgId === 'string' ? payload.msgId : undefined;

  switch (opCode) {
    case TransportOpCode.CHAT_MESSAGE:
      await handleChatMessage(userId, deviceId, payload as unknown as MessageSendPayload, msgId);
      break;
    case TransportOpCode.WEBRTC_SIGNAL:
      await handleWebRtcRelay(userId, payload as { to: string, type: string, payload: string }, TransportOpCode.WEBRTC_SIGNAL);
      break;
    case TransportOpCode.WEBRTC_ICE:
      await handleWebRtcRelay(userId, payload as { to: string, type: string, payload: string }, TransportOpCode.WEBRTC_ICE);
      break;
    case TransportOpCode.PRESENCE:
      await handlePresence(userId, payload as { event: 'active' | 'away' | 'typing:start' | 'typing:stop', conversationId?: string });
      break;
    case TransportOpCode.KEY_SYNC:
      await handleKeySync(userId, deviceId, payload as { event: string, msgId: string, data: Record<string, unknown> }, msgId);
      break;
    case 99: // DISCONNECT
      await handleDisconnect(userId);
      break;
    default:
      console.warn(`⚠️ Unhandled OpCode: 0x${opCode.toString(16)} from user ${userId}`);
  }
  }

  async function handleDisconnect(userId: string) {
  await pubClient.sRem('online_users', userId);

  // Cleanup presence and rooms
  const onlineUsers = await pubClient.sMembers('online_users');
  await broadcastToUsers(onlineUsers, TransportOpCode.PRESENCE, { event: 'leave', userId });

  // Optional: Best-effort cleanup for burner/migration rooms
  try {
    let cursor = '0';
    do {
      const result = await pubClient.scan(cursor, { MATCH: 'burner:room:*', COUNT: 100 });
      cursor = result.cursor;
      for (const key of result.keys) {
        await pubClient.sRem(key, userId);
      }
    } while (cursor !== '0');

    cursor = '0';
    do {
      const result = await pubClient.scan(cursor, { MATCH: 'migration:room:*', COUNT: 100 });
      cursor = result.cursor;
      for (const key of result.keys) {
        await pubClient.sRem(key, userId);
      }
    } while (cursor !== '0');
  } catch (e) {
    console.error('[RedisBridge] Room cleanup error:', e);
  }
  }

async function handleChatMessage(userId: string, deviceId: string, payload: MessageSendPayload, msgId?: string) {
  const { conversationId, content, sessionId, tempId, expiresAt, isViewOnce, pushPayloads, repliedToId } = payload;

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { select: { userId: true } } },
    });

    if (!conversation || !conversation.participants.some(p => p.userId === userId)) {
      if (msgId) await sendAck(userId, deviceId, msgId, { ok: false, error: "Conversation not found or access denied" });
      return;
    }

    const newMessageRaw = await prisma.message.create({
      data: { 
          conversationId, senderId: userId, content, sessionId: sessionId || null,
          repliedToId: repliedToId || null, expiresAt: expiresAt ? new Date(expiresAt) : null, isViewOnce: isViewOnce === true
      },
      include: { sender: { select: { id: true, encryptedProfile: true } } }
    });
    
    const safeMessage = toRawServerMessage(newMessageRaw) as RawServerMessage;
    if (tempId !== undefined) safeMessage.tempId = typeof tempId === 'string' ? parseInt(tempId, 10) : tempId;

    // Acknowledge the sender
    if (msgId) await sendAck(userId, deviceId, msgId, { ok: true, msg: safeMessage });

    // Relay to all participants
    for (const participant of conversation.participants) {
      if (participant.userId === userId) continue; 
      await sendJsonToUser(participant.userId, TransportOpCode.CHAT_MESSAGE, safeMessage);
      
      sendPushNotification(participant.userId, {
          type: pushPayloads ? 'ENCRYPTED_MESSAGE' : 'GENERIC_MESSAGE',
          data: { conversationId, messageId: safeMessage.id, pushPayloadMap: pushPayloads || undefined }
      }).catch(console.error);
    }
  } catch (error) {
    console.error('Failed to handle chat message:', error);
    if (msgId) await sendAck(userId, deviceId, msgId, { ok: false, error: "Internal server error" });
  }
}

async function handleWebRtcRelay(fromUserId: string, payload: { to: string, type: string, payload: string }, opCode: TransportOpCode) {
  if (!payload.to) return;
  const relayPayload = { from: fromUserId, type: payload.type, payload: payload.payload };
  await sendJsonToUser(payload.to, opCode, relayPayload, opCode === TransportOpCode.WEBRTC_ICE);
}

async function handlePresence(userId: string, payload: { event: 'active' | 'away' | 'typing:start' | 'typing:stop', conversationId?: string }) {
  if (payload.event === 'active') {
    await pubClient.sAdd('online_users', userId);
  } else if (payload.event === 'away') {
    await pubClient.sRem('online_users', userId);
  }
  
  if (payload.conversationId && (payload.event === 'typing:start' || payload.event === 'typing:stop')) {
     const conversation = await prisma.conversation.findUnique({
       where: { id: payload.conversationId },
       include: { participants: { select: { userId: true } } }
     });
     
     if (conversation) {
       const typingData = { userId, conversationId: payload.conversationId, isTyping: payload.event === 'typing:start' };
       for (const p of conversation.participants) {
         if (p.userId !== userId) {
           await sendJsonToUser(p.userId, TransportOpCode.PRESENCE, typingData);
         }
       }
     }
  }
}

export async function checkRateLimit(userId: string, event: string, limit: number, windowSeconds: number) {
    const key = `rate_limit:socket:${event}:${userId}`;
    const current = await redisClient.incr(key);
    if (current === 1) {
        await redisClient.expire(key, windowSeconds);
    }
    return current <= limit;
}

async function handleKeySync(userId: string, deviceId: string, payload: { event: string, msgId: string, data: unknown }, msgIdFromRust?: string) {
   const { event, msgId, data } = payload;

   try {
     switch (event) {
       case 'session:request_key': {
         const { conversationId, sessionId, targetId } = data as any;
         if (!conversationId) return;
         if (!await checkRateLimit(userId, 'session_request_key', 20, 60)) return;

         if (targetId) {
             const participants = await prisma.participant.findMany({
                 where: { conversationId, userId: { in: [userId, targetId] } },
                 select: { userId: true }
             });
             const participantIds = participants.map(p => p.userId);
             if (!participantIds.includes(userId) || !participantIds.includes(targetId)) return;

             const me = await prisma.user.findUnique({ where: { id: userId }, include: { devices: { where: { id: deviceId } } } });
             const meDevice = me?.devices[0];

             await emitEventToUser(targetId, 'session:request_key', {
                 conversationId,
                 requesterId: userId,
                 sessionId,
                 requesterPublicKey: meDevice?.publicKey ? Buffer.from(meDevice.publicKey).toString('base64url') : undefined,
                 requesterPqPublicKey: meDevice?.pqPublicKey ? Buffer.from(meDevice.pqPublicKey).toString('base64url') : undefined,
                 requesterDeviceId: deviceId
             });
         } else if (sessionId) {
             const isParticipant = await prisma.participant.findFirst({ where: { conversationId, userId } });
             if (!isParticipant) return;

             const participants = await prisma.participant.findMany({
                 where: { conversationId, userId: { not: userId } },
                 select: { userId: true },
             });
             const allOnlineUsers = await redisClient.sMembers('online_users');
             const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
             
             if (onlineParticipants.length > 0) {
                 const fulfillerId = onlineParticipants[0].userId;
                 const me = await prisma.user.findUnique({ where: { id: userId }, include: { devices: { where: { id: deviceId } } } });
                 const meDevice = me?.devices[0];

                 if (meDevice?.publicKey && meDevice?.pqPublicKey) {
                     await emitEventToUser(fulfillerId, 'session:fulfill_request', { 
                        conversationId, 
                        sessionId, 
                        requesterId: userId, 
                        requesterPublicKey: Buffer.from(meDevice.publicKey).toString('base64url'), 
                        requesterPqPublicKey: Buffer.from(meDevice.pqPublicKey).toString('base64url') 
                     });
                 } else {
                     await emitEventToUser(userId, "session:request_key_failed", { sessionId, targetId: fulfillerId, reason: "Missing PQ or classical public key" });
                 }
             }
         }
         break;
       }

       case 'session:fulfill_response': {
         const { requesterId, conversationId, sessionId, encryptedKey, targetDeviceId } = data as KeyFulfillmentPayload;
         if (!requesterId || !encryptedKey) return;
         if (!await checkRateLimit(userId, 'session_fulfill_response', 60, 60)) return;

         const emitPayload = { conversationId, sessionId, encryptedKey, type: 'SESSION_KEY', senderId: userId };
         await emitEventToUser(requesterId, 'session:new_key', emitPayload, targetDeviceId);
         break;
       }

       case 'messages:distribute_keys': {
         const { conversationId, keys } = data as DistributeKeysPayload;
         if (!conversationId || !Array.isArray(keys)) {
            if (msgId) await sendAck(userId, deviceId, msgId, { ok: false, error: 'Invalid payload' });
            return;
         }
         if (!await checkRateLimit(userId, 'distribute_keys', 40, 60)) {
            if (msgId) await sendAck(userId, deviceId, msgId, { ok: false, error: 'Rate limit exceeded' });
            return;
         }
         const isParticipant = await prisma.participant.findFirst({ where: { conversationId, userId } });
         if (!isParticipant) {
            if (msgId) await sendAck(userId, deviceId, msgId, { ok: false, error: 'Not a member' });
            return;
         }

         for (const k of keys) {
             const { userId: targetId, key, targetDeviceId, senderDeviceKey } = k;
             const emitPayload = { conversationId, encryptedKey: key, type: 'GROUP_KEY', senderId: userId, senderDeviceKey };
             await emitEventToUser(targetId, 'session:new_key', emitPayload, targetDeviceId);
         }
         if (msgId) await sendAck(userId, deviceId, msgId, { ok: true });
         break;
       }

       case 'group:request_key': {
         const { conversationId, targetSenderId, targetDeviceKey } = data as GroupKeyRequestPayload;
         if (!conversationId) return;
         if (!await checkRateLimit(userId, 'group_request_key', 20, 60)) return;

         const isParticipant = await prisma.participant.findFirst({ where: { conversationId, userId } });
         if (!isParticipant) return;

         let fulfillerId = targetSenderId;
         if (!fulfillerId) {
             const participants = await prisma.participant.findMany({
                 where: { conversationId, userId: { not: userId } },
                 select: { userId: true },
             });
             const allOnlineUsers = await redisClient.sMembers('online_users');
             const onlineParticipants = participants.filter(p => allOnlineUsers.includes(p.userId));
             if (onlineParticipants.length > 0) {
                 fulfillerId = onlineParticipants[0].userId;
             }
         }

         if (fulfillerId) {
             const me = await prisma.user.findUnique({ where: { id: userId }, include: { devices: { where: { id: deviceId } } } });
             const meDevice = me?.devices[0];

             if (meDevice?.publicKey && meDevice?.pqPublicKey) {
                 await emitEventToUser(fulfillerId, 'group:fulfill_key_request', {
                     conversationId,
                     requesterId: userId,
                     requesterPublicKey: Buffer.from(meDevice.publicKey).toString('base64url'),
                     requesterPqPublicKey: Buffer.from(meDevice.pqPublicKey).toString('base64url'),
                     requesterDeviceId: deviceId
                 });
             } else {
                 await emitEventToUser(userId, "group:key_request_failed", { conversationId, reason: "Missing classical or PQ public key" });
             }
         }
         break;
       }

       case 'group:fulfilled_key': {
         const { requesterId, conversationId, encryptedKey, targetDeviceId, senderDeviceKey } = data as any;
         if (!requesterId || !conversationId || !encryptedKey) return;
         if (!await checkRateLimit(userId, 'group_fulfilled_key', 60, 60)) return;

         const emitPayload = { conversationId, encryptedKey, type: 'GROUP_KEY', senderId: userId, senderDeviceKey };
         await emitEventToUser(requesterId, 'session:new_key', emitPayload, targetDeviceId);
         break;
       }

       case 'auth:request_linking_qr': {
         if (!await checkRateLimit(userId, 'linking_qr', 5, 60)) return;
         const sodium = await getSodium();
         const linkingToken = sodium.to_hex(sodium.randombytes_buf(32));
         
         // Simpan di Redis: linkingToken -> { userId, deviceId }
         await redisClient.setEx(`linking_token:${linkingToken}`, 300, JSON.stringify({ userId, deviceId }));
         
         await emitEventToUser(userId, 'auth:linking_qr_ready', { linkingToken }, deviceId);
         break;
       }

       case 'message:unsend': {
         const { messageId, conversationId } = data as any;
         if (!messageId || !conversationId) return;
         const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { senderId: true, conversationId: true } });
         if (!msg || msg.conversationId !== conversationId || msg.senderId !== userId) return;
         await prisma.message.deleteMany({ where: { id: messageId, senderId: userId } });
         await emitEventToConversation(conversationId, 'message:deleted_remotely', { messageId, conversationId, deletedBy: userId }, userId);
         break;
       }

       case 'message:view_once_opened': {
         const { messageId, conversationId } = data as any;
         if (!messageId || !conversationId) return;
         const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { senderId: true, conversationId: true } });
         if (!msg || msg.senderId === userId || msg.conversationId !== conversationId) return;
         await emitEventToConversation(conversationId, 'message:viewed', { messageId, conversationId }, userId);
         break;
       }

       case 'push:subscribe': {
         const { endpoint, keys } = data as PushSubscribePayload;
         if (!endpoint || !keys?.p256dh || !keys?.auth) return;
         await prisma.pushSubscription.upsert({
           where: { endpoint },
           update: { p256dh: keys.p256dh, auth: keys.auth, deviceId },
           create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, deviceId }
         });
         break;
       }

       case 'push:unsubscribe': {
         await prisma.pushSubscription.deleteMany({ where: { deviceId } });
         break;
       }

       // --- BURNER CHAT EVENTS ---
       case 'burner:join': {
         const { roomId } = data as { roomId?: string };
         if (roomId) await pubClient.sAdd(`burner:room:${roomId}`, userId);
         break;
       }
       case 'burner:send': {
         const { roomId, targetDeviceId, hostUserId, ciphertext } = data as any;
         if (await redisClient.exists(`burner:terminated:${roomId}`)) return;
         await sendJsonToUser(hostUserId, TransportOpCode.KEY_SYNC, { event: 'burner:receive', data: { roomId, ciphertext } }, false, targetDeviceId);
         if (msgId) await sendAck(userId, deviceId, msgId, { ok: true });
         break;
       }
       case 'burner:reply': {
         const { roomId, ciphertext } = data as { roomId: string, ciphertext: string };
         if (await redisClient.exists(`burner:terminated:${roomId}`)) return;
         const members = await pubClient.sMembers(`burner:room:${roomId}`);
         for (const memberId of members) {
            if (memberId !== userId) await sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'burner:receive', data: { roomId, ciphertext } });
         }
         break;
       }
       case 'burner:destroy': {
         const { roomId } = data as any;
         await redisClient.set(`burner:terminated:${roomId}`, "1", { EX: 86400 });
         const members = await pubClient.sMembers(`burner:room:${roomId}`);
         for (const memberId of members) {
            await sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'burner:terminated', data: { roomId } });
         }
         await pubClient.del(`burner:room:${roomId}`);
         break;
       }

       // --- MIGRATION EVENTS ---
       case 'migration:join': {
         if (data) await pubClient.sAdd(`migration:room:${data}`, userId);
         break;
       }
       case 'migration:start': {
         const { roomId } = data as any;
         await redisClient.set(`migration_owner:${roomId}`, userId, { EX: 3600 });
         const members = await pubClient.sMembers(`migration:room:${roomId}`);
         for (const memberId of members) {
            if (memberId !== userId) await sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'migration:start', data });
         }
         break;
       }
       case 'migration:chunk': {
         const { roomId } = data as any;
         const ownerId = await redisClient.get(`migration_owner:${roomId}`);
         if (ownerId !== userId) return;
         const members = await pubClient.sMembers(`migration:room:${roomId}`);
         for (const memberId of members) {
            if (memberId !== userId) await sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'migration:chunk', data });
         }
         break;
       }
       case 'migration:ack': {
         const { roomId } = data as any;
         const ownerId = await redisClient.get(`migration_owner:${roomId}`);
         if (ownerId) await sendJsonToUser(ownerId, TransportOpCode.KEY_SYNC, { event: 'migration:ack', data });
         break;
       }

       case 'message:mark_read':
       case 'message:mark_as_read': {
         const { conversationId, messageId } = data as { conversationId: string, messageId: string };
         await handleMessageStatusUpdate(userId, conversationId, messageId, 'READ');
         break;
       }

       case 'message:ack_delivered': {
         const { conversationId, messageId } = data as { conversationId: string, messageId: string };
         await handleMessageStatusUpdate(userId, conversationId, messageId, 'DELIVERED');
         break;
       }

       case 'messages:mark_as_read':
       case 'messages:mark_read':
       case 'messages:mark_delivered': {
         const { conversationId, messageIds } = data as any;
         const status = (event === 'messages:mark_read' || event === 'messages:mark_as_read') ? 'READ' : 'DELIVERED';
         if (!conversationId || !Array.isArray(messageIds)) return;
         
         await prisma.messageStatus.updateMany({
           where: { messageId: { in: messageIds }, userId },
           data: { status }
         });

         await emitEventToConversation(conversationId, 'message:status_updated', {
           conversationId,
           messageIds,
           userId,
           status
         }, userId);
         break;
       }

       case 'message:deleted': {
         const { conversationId, id: messageId } = data as any;
         if (!conversationId || !messageId) return;

         const message = await prisma.message.findUnique({ where: { id: messageId } });
         if (!message || message.senderId !== userId) return;

         await prisma.message.delete({ where: { id: messageId } });
         await emitEventToConversation(conversationId, 'message:deleted', { conversationId, id: messageId }, userId);
         break;
       }
       
       default:
         console.warn(`[RedisBridge] Unhandled generic event: ${event}`);
     }
   } catch (e) {
     console.error(`[RedisBridge] Error in handleKeySync:`, e);
   }
}

async function sendAck(userId: string, deviceId: string, msgId: string, data: Record<string, unknown>) {
  await sendJsonToUser(userId, TransportOpCode.ACK, { msgId, data }, false, deviceId);
}

async function handleMessageStatusUpdate(userId: string, conversationId: string, messageId: string, status: 'READ' | 'DELIVERED') {
  if (!conversationId || !messageId) return;

  await prisma.messageStatus.upsert({
    where: {
      messageId_userId: { messageId, userId }
    },
    update: { status },
    create: { messageId, userId, status }
  });

  await emitEventToConversation(conversationId, 'message:status_updated', {
    conversationId,
    messageId,
    userId,
    status
  }, userId);
}
