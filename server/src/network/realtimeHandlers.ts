// server/src/network/realtimeHandlers.ts
//
// Extracted MVP realtime handlers (CHAT_MESSAGE, KEY_SYNC, PRESENCE, ACK) that
// were previously inlined as switch cases inside redisBridge.ts.
//
// They are intentionally dependency-injected via `RealtimeContext` so that BOTH
// the Rust-WebTransport upstream path (redisBridge.ts) and the new socket.io
// WebSocket fallback gateway (gateway.ts) can drive identical business logic
// without creating an import cycle between this module and redisBridge.ts.
//
// The bodies below are carried over VERBATIM from redisBridge.ts — only the
// bridge-local helpers (sendAck / emitEventToUser / sendJsonToUser / prisma /
// redisClient / pubClient / checkRateLimit / isActiveDeviceAllowed) are now
// reached through `ctx`. Do NOT redesign the logic here.

import type { RedisClientType } from 'redis';
import type { PrismaClient } from '@prisma/client';
import {
  TransportOpCode,
  MessageSendPayloadSchema,
} from '@nyx/shared';
import type {
  MessageSendPayload,
  RawServerMessage,
  KeyRequestPayload,
  KeyFulfillmentPayload,
  GroupKeyRequestPayload,
  DistributeKeysPayload,
  PushSubscribePayload,
} from '@nyx/shared';
import { toRawServerMessage } from '../utils/mappers.js';
import { sendPushNotification } from '../utils/sendPushNotification.js';
import { sanitizeForLog } from '../utils/logger.js';
import { safeEqualStrings } from '../utils/validate.js';
import { getSodium } from '../lib/sodium.js';

/**
 * Dependency-injection context. Every helper the extracted handlers need is
 * supplied by the caller (redisBridge.ts for the WT path, gateway.ts for the
 * WS path) so outbound delivery always rides `nyx:downstream` uniformly.
 */
export interface RealtimeContext {
  sendToUser: (
    targetUserId: string,
    opCode: TransportOpCode,
    base64Payload: string,
    isDatagram?: boolean,
    deviceId?: string
  ) => Promise<void>;
  sendToDevice: (
    targetUserId: string,
    targetDeviceId: string,
    opCode: TransportOpCode,
    base64Payload: string,
    isDatagram?: boolean
  ) => Promise<void>;
  broadcastToUsers: (
    userIds: string[],
    opCode: TransportOpCode,
    data: unknown
  ) => Promise<void>;
  sendJsonToUser: (
    targetUserId: string,
    opCode: TransportOpCode,
    data: unknown,
    isDatagram?: boolean,
    deviceId?: string
  ) => Promise<void>;
  checkRateLimit: (
    userId: string,
    event: string,
    limit: number,
    windowSeconds: number
  ) => Promise<boolean>;
  isActiveDeviceAllowed: (userId: string, deviceId: string) => Promise<boolean>;
  prisma: PrismaClient;
  redisClient: RedisClientType;
  pubClient: RedisClientType;
}

// --- Internal thin wrappers (mirror redisBridge.sendAck / emitEventToUser) ---
// These are reimplemented here (instead of imported) to keep this module free
// of a runtime import on redisBridge.ts and thus break the cycle.

async function sendAck(
  ctx: RealtimeContext,
  userId: string,
  deviceId: string,
  msgId: string,
  data: Record<string, unknown>
): Promise<void> {
  await ctx.sendJsonToUser(userId, TransportOpCode.ACK, { msgId, data }, false, deviceId);
}

async function emitEventToUser(
  ctx: RealtimeContext,
  userId: string,
  event: string,
  data: unknown,
  deviceId?: string
): Promise<void> {
  await ctx.sendJsonToUser(userId, TransportOpCode.KEY_SYNC, { event, data }, false, deviceId);
}

// ===========================================================================
// CHAT_MESSAGE (0x01)
// ===========================================================================
// --- Idempotensi message:send (FIX duplicate-on-retry) ---
// Client re-send pesan yang ACK-nya hilang (timeout 5s/15s). Tanpa dedupe,
// retry tersimpan sebagai pesan baru → penerima melihat duplikat. Kunci dedupe
// per (deviceId, tempId) dengan TTL 24 jam, reserve atomik via Redis SET NX.
//
// Kondisi tempId dari schema: number (z.number().int()) ATAU string numerik
// (payload lama yang lolos coercion). String non-numerik tidak mungkin lolos
// schema — z.number() menolaknya.
const SEND_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

function buildSendDedupeKey(deviceId: string, tempId: string | number): string {
  return `nyx:send_dedupe:${deviceId}:${tempId}`;
}

// Hasil reserve: 'reserved' = boleh insert; { existingMsgId } = sudah pernah
// tersimpan (duplicate) — nilainya disimpan SETELAH insert sukses.
// "pending" = insert lain masih berjalan untuk kunci yang sama.
async function reserveMessageSlot(
  ctx: RealtimeContext,
  userId: string,
  deviceId: string,
  tempId: string | number,
  msgId?: string
): Promise<'reserved' | 'pending' | { existingMsgId: string }> {
  const key = buildSendDedupeKey(deviceId, tempId);
  // SET NX: atomik — hanya satu request yang berhasil meng-claim kunci.
  const set = await ctx.redisClient.set(key, 'pending', { NX: true, EX: SEND_DEDUPE_TTL_SECONDS });
  if (set === 'OK') return 'reserved';

  // Kunci sudah ada. Tunggu singkat insert paralel selesai, lalu baca msgId
  // hasilnya (duplikat tersimpan memakai id pesan asli sebagai value).
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const val = await ctx.redisClient.get(key);
    if (typeof val === 'string' && val !== 'pending') {
      return { existingMsgId: val };
    }
  }
  // Insert paralel belum selesai juga setelah ~1.5s: anggap gagal/stuck dan
  // biarkan request ini jalan (dedupe bukan hard-gate; race bawah 1.5s pada
  // pengiriman ganda nyata praktis mustahil — retry memakai tempId sama).
  console.warn('[Dedupe] Slot pending terlalu lama, meneruskan tanpa dedupe:', sanitizeForLog(userId));
  if (msgId) {
    await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: 'Duplicate send in progress, retry' });
  }
  return 'pending';
}

async function completeMessageSlot(
  ctx: RealtimeContext,
  deviceId: string,
  tempId: string | number,
  createdMessageId: string
): Promise<void> {
  // Simpan id pesan hasil insert sebagai value — request duplicate berikutnya
  // menerima ACK ok:true dengan pesan yang SAMA, bukan error.
  await ctx.redisClient.set(
    buildSendDedupeKey(deviceId, tempId),
    createdMessageId,
    { EX: SEND_DEDUPE_TTL_SECONDS }
  ).catch((e: unknown) => console.warn('[Dedupe] Failed to finalize dedupe slot:', e));
}

async function releaseMessageSlot(
  ctx: RealtimeContext,
  deviceId: string,
  tempId: string | number
): Promise<void> {
  // Insert gagal → bebaskan slot agar retry nyata (mis. setelah perbaikan
  // server) bisa tersimpan. Delete race-aman: paling buruk duplikat, paling
  // baik retry sukses.
  await ctx.redisClient.del(buildSendDedupeKey(deviceId, tempId))
    .catch((e: unknown) => console.warn('[Dedupe] Failed to release dedupe slot:', e));
}

export async function handleChatMessage(
  ctx: RealtimeContext,
  userId: string,
  deviceId: string,
  payload: unknown,
  msgId?: string
): Promise<void> {
  let validatedPayload;
  try {
    validatedPayload = MessageSendPayloadSchema.parse(payload);
  } catch (e) {
    console.error("Invalid chat message payload:", e);
    if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: "Invalid payload format" });
    return;
  }

  const { conversationId, content, sessionId, tempId, expiresAt, isViewOnce, pushPayloads, repliedToId, targetRecipients, deleteSecret } = validatedPayload;

  try {
    // --- IDEMPOTENSI: reserve slot dedupe sebelum menyentuh DB ---
    // Hanya bila tempId tersedia (selalu ada dari kedua jalur client).
    if (tempId !== undefined && deviceId) {
      const reservation = await reserveMessageSlot(ctx, userId, deviceId, tempId, msgId);
      if (reservation === 'pending') return; // ACK error sudah dikirim
      if (typeof reservation === 'object') {
        // Duplicate: kirim ulang ACK sukses dengan pesan yang SUDAH ADA di DB
        // (bukan insert baru), supaya removeFromQueue/update optimistic tetap
        // berjalan seperti ACK asli.
        const existing = await ctx.prisma.message.findUnique({
          where: { id: reservation.existingMsgId },
          include: { sender: { select: { id: true, encryptedProfile: true } } }
        });
        if (existing) {
          const safeMessage = toRawServerMessage(existing) as RawServerMessage;
          safeMessage.tempId = typeof tempId === 'string' ? parseInt(tempId, 10) : tempId;
          if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true, msg: safeMessage });
          return;
        }
        // Pesan sudah terhapus (mis. read + sweeper) → slot basi, lanjut insert
        // ulang sebagai jalur biasa (jarang; bukan error state).
        await releaseMessageSlot(ctx, deviceId, tempId);
      }
    }

    const conversation = await ctx.prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation) {
      if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: "Conversation not found" });
      return;
    }

    const [newMessageRaw] = await ctx.prisma.$transaction([
      ctx.prisma.message.create({
        data: {
            conversationId, senderId: conversation.isGroup ? userId : null, content, sessionId: sessionId || null,
            repliedToId: repliedToId || null, expiresAt: expiresAt ? new Date(expiresAt) : null,
            isViewOnce: isViewOnce === true,
            deleteSecret
        },
        include: { sender: { select: { id: true, encryptedProfile: true } } }
      }),
      ctx.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() }
      })
    ]);

    // Finalisasi slot dedupe dengan id pesan hasil insert.
    if (tempId !== undefined && deviceId) {
      await completeMessageSlot(ctx, deviceId, tempId, newMessageRaw.id);
    }

    const safeMessage = toRawServerMessage(newMessageRaw) as RawServerMessage;
    if (tempId !== undefined) safeMessage.tempId = typeof tempId === 'string' ? parseInt(tempId, 10) : tempId;

    // Acknowledge the sender
    if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true, msg: safeMessage });

    // Relay to target recipients explicitly passed by the sender (Opaque Mailbox routing)
    if (Array.isArray(targetRecipients)) {
        if (targetRecipients.length > 500) {
            console.warn('[Security] User', sanitizeForLog(userId), 'attempted to send message to', targetRecipients.length, 'recipients (max 500)');
            if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: 'Too many recipients (max 500)' });
            return;
        }
        // PARALEL: publish ke semua penerima sekaligus (sebelumnya sequential per recipient)
        await Promise.all(targetRecipients.map(async (targetIdRaw) => {
            const targetId = String(targetIdRaw);
            await ctx.sendJsonToUser(targetId, TransportOpCode.CHAT_MESSAGE, safeMessage);

            if (targetId !== userId) {
                sendPushNotification(targetId, {
                    type: pushPayloads ? 'ENCRYPTED_MESSAGE' : 'GENERIC_MESSAGE',
                    data: { conversationId, messageId: safeMessage.id, pushPayloadMap: pushPayloads || undefined }
                }).catch((e: unknown) => { console.error("[RedisBridge] Failed to send push notification:", e); });

                // Register this conversation for the target recipient so they can discover it later
                // (Critical for new users who have never synced this conversation before)
                ctx.prisma.userHiddenConversation.upsert({
                    where: { userId_conversationId: { userId: targetId, conversationId } },
                    create: { userId: targetId, conversationId },
                    update: {} // No-op if already exists
                }).catch((e: unknown) => console.warn('[OpaqueMailbox] Failed to upsert UserHiddenConversation:', e));
            }
        }));
    }
  } catch (error) {
    console.error('Failed to handle chat message:', error);
    // Insert gagal → bebaskan slot dedupe agar retry berikutnya bisa tersimpan.
    if (tempId !== undefined && deviceId) {
      await releaseMessageSlot(ctx, deviceId, tempId);
    }
    if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: "Internal server error" });
  }
}

// ===========================================================================
// PRESENCE (0x05) — includes handlePresence + typing fan-out
// ===========================================================================
export async function handlePresence(
  ctx: RealtimeContext,
  userId: string,
  payload: { event: string, conversationId?: string }
): Promise<void> {
  if (payload.event === 'active' || payload.event === 'user:active') {
    const added = await ctx.pubClient.sAdd('online_users', userId);
    const onlineUsers = await ctx.pubClient.sMembers('online_users');

    // Send the current list of online users to this user
    await ctx.sendJsonToUser(userId, TransportOpCode.PRESENCE, { type: 'bulk', userIds: onlineUsers });

    if (added === 1) {
      await ctx.broadcastToUsers(onlineUsers, TransportOpCode.PRESENCE, { type: 'join', userId });
    }
  } else if (payload.event === 'away' || payload.event === 'user:away') {
    const removed = await ctx.pubClient.sRem('online_users', userId);
    if (removed === 1) {
      const onlineUsers = await ctx.pubClient.sMembers('online_users');
      await ctx.broadcastToUsers(onlineUsers, TransportOpCode.PRESENCE, { type: 'leave', userId });
    }
  }

  if (payload.conversationId && (payload.event === 'typing:start' || payload.event === 'typing:stop' || payload.event === 'typing')) {
     const conversationId = payload.conversationId;
     const isTyping = payload.event === 'typing:start' || payload.event === 'typing';
     const typingData = { type: 'typing', userId, conversationId, isTyping };

     // Opaque Mailbox: sender explicitly provides targetRecipients
     const targetRecipients = (payload as { targetRecipients?: string[] }).targetRecipients;
     if (Array.isArray(targetRecipients) && targetRecipients.length > 0) {
         for (const pId of targetRecipients) {
             if (typeof pId === 'string' && pId !== userId) {
               await ctx.sendJsonToUser(pId, TransportOpCode.PRESENCE, typingData);
             }
         }
     }
  }
}

// ===========================================================================
// ACK (0x06) — message delivery/read status updates
// ===========================================================================
export async function handleAck(
  ctx: RealtimeContext,
  userId: string,
  _deviceId: string,
  payload: { conversationId: string, messageId: string, targetRecipient?: string }
): Promise<void> {
  await handleMessageStatusUpdate(ctx, userId, payload.conversationId, payload.messageId, 'DELIVERED', payload.targetRecipient);
}

// ===========================================================================
// KEY_SYNC (0x02) — session / group key exchange + assorted realtime events
// ===========================================================================
export async function handleKeySync(
  ctx: RealtimeContext,
  userId: string,
  deviceId: string,
  payload: { event: string, msgId: string, data: unknown },
  msgIdFromRust?: string
): Promise<void> {
   const { event, msgId, data } = payload;

   try {
     switch (event) {
       case 'session:request_key': {
         const { conversationId, sessionId, targetId } = data as KeyRequestPayload;
         if (!conversationId) return;
         if (!await ctx.checkRateLimit(userId, 'session_request_key', 20, 60)) return;

         if (targetId) {
             const me = await ctx.prisma.user.findUnique({ where: { id: userId }, include: { devices: { where: { id: deviceId } } } });
             const meDevice = me?.devices[0];

             await emitEventToUser(ctx, targetId, 'session:request_key', {
                 conversationId,
                 requesterId: userId,
                 sessionId,
                 requesterPublicKey: meDevice?.publicKey ? Buffer.from(meDevice.publicKey).toString('base64url') : undefined,
                 requesterPqPublicKey: meDevice?.pqPublicKey ? Buffer.from(meDevice.pqPublicKey).toString('base64url') : undefined,
                 requesterDeviceId: deviceId
             });
         } else if (sessionId) {
             // In Opaque Mailbox, we can't find an online participant automatically because we don't know who they are.
             // We require the client to provide targetId.
             await emitEventToUser(ctx, userId, "session:request_key_failed", { sessionId, targetId: "UNKNOWN", reason: "Opaque Mailbox requires targetId" });
         }
         break;
       }

       case 'session:fulfill_response': {
         const { requesterId, conversationId, sessionId, encryptedKey, targetDeviceId } = data as KeyFulfillmentPayload;
         if (!requesterId || !encryptedKey) return;
         if (!await ctx.checkRateLimit(userId, 'session_fulfill_response', 60, 60)) return;

         const emitPayload = { conversationId, sessionId, encryptedKey, type: 'SESSION_KEY', senderId: userId };
         await emitEventToUser(ctx, requesterId, 'session:new_key', emitPayload, targetDeviceId);
         break;
       }

       case 'session:request_missing': {
         const { conversationId, targetId } = data as { conversationId: string, targetId?: string };
         if (conversationId && targetId) {
           await emitEventToUser(ctx, targetId, 'session:key_requested', {
              conversationId,
              requesterId: userId,
              deviceId
           });
         }
         break;
       }

       case 'messages:distribute_keys': {
         const { conversationId, keys } = data as DistributeKeysPayload;
         if (!conversationId || !Array.isArray(keys)) {
            if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: 'Invalid payload' });
            return;
         }
         if (!await ctx.checkRateLimit(userId, 'distribute_keys', 40, 60)) {
            if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: 'Rate limit exceeded' });
            return;
         }

         for (const k of keys) {
              const { userId: targetId, key, targetDeviceId, senderDeviceKey, drHeader } = k;
              const emitPayload: Record<string, unknown> = { conversationId, encryptedKey: key, type: 'GROUP_KEY', senderId: userId, senderDeviceKey };
              if (drHeader) emitPayload.drHeader = drHeader;

             // Restore offline catchup: persist distributed keys to the database
             await ctx.prisma.message.create({
                 data: {
                     id: `msg_sys_key_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                     conversationId,
                     senderId: userId, // Store actual sender for group key routing
                     type: 'SYSTEM',
                     content: JSON.stringify(emitPayload),
                     isViewOnce: false,
                     expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
                 }
             });

             await emitEventToUser(ctx, targetId, 'session:new_key', emitPayload, targetDeviceId);
         }
         if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true });
         break;
       }

       case 'group:request_key': {
         const { conversationId, targetSenderId, targetDeviceKey } = data as GroupKeyRequestPayload;
         if (!conversationId) return;
         if (!await ctx.checkRateLimit(userId, 'group_request_key', 20, 60)) return;

         let fulfillerId = targetSenderId;
         if (!fulfillerId) {
             // Opaque Mailbox requires targetSenderId to be provided by client
             return;
         }

         if (fulfillerId) {
             const me = await ctx.prisma.user.findUnique({ where: { id: userId }, include: { devices: { where: { id: deviceId } } } });
             const meDevice = me?.devices[0];

             if (meDevice?.publicKey && meDevice?.pqPublicKey) {
                 await emitEventToUser(ctx, fulfillerId, 'group:fulfill_key_request', {
                     conversationId,
                     requesterId: userId,
                     requesterPublicKey: Buffer.from(meDevice.publicKey).toString('base64url'),
                     requesterPqPublicKey: Buffer.from(meDevice.pqPublicKey).toString('base64url'),
                     requesterDeviceId: deviceId,
                     targetDeviceKey
                 });
             } else {
                 await emitEventToUser(ctx, userId, "group:key_request_failed", { conversationId, reason: "Missing classical or PQ public key" });
             }
         }
         break;
       }

       case 'group:fulfilled_key': {
           const { requesterId, conversationId, encryptedKey, targetDeviceId, senderDeviceKey, drHeader } = data as KeyFulfillmentPayload;
           if (!requesterId || !conversationId || !encryptedKey) return;
           if (!await ctx.checkRateLimit(userId, 'group_fulfilled_key', 60, 60)) return;

           const emitPayload: Record<string, unknown> = { conversationId, encryptedKey, type: 'GROUP_KEY', senderId: userId, senderDeviceKey };
           if (drHeader) emitPayload.drHeader = drHeader;
           await emitEventToUser(ctx, requesterId, 'session:new_key', emitPayload, targetDeviceId);
           break;
         }

        case 'metadata:updated': {
           const { conversationId, encryptedMetadata, targetRecipients } = data as { conversationId: string; encryptedMetadata: string; targetRecipients: string[] };
           if (!conversationId || !encryptedMetadata || !Array.isArray(targetRecipients)) return;
           if (!await ctx.checkRateLimit(userId, 'metadata_updated', 20, 60)) return;

           // Persist to DB for offline delivery (like messages:distribute_keys)
           await ctx.prisma.message.create({
               data: {
                   id: `msg_sys_meta_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                   conversationId,
                   senderId: userId,
                   type: 'SYSTEM',
                   content: JSON.stringify({ type: 'METADATA_UPDATED', encryptedMetadata }),
                   isViewOnce: false,
                   expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
               }
           });

           for (const targetId of targetRecipients) {
               if (typeof targetId === 'string') {
                   await emitEventToUser(ctx, targetId, 'conversation:updated', { id: conversationId, encryptedMetadata });
               }
           }
           break;
         }

        case 'auth:request_linking_qr': {
         if (!await ctx.checkRateLimit(userId, 'linking_qr', 5, 60)) return;
         const sodium = await getSodium();
         const linkingToken = sodium.to_hex(sodium.randombytes_buf(32));

         // Simpan di Redis: linkingToken -> { userId, deviceId }
         await ctx.redisClient.setEx(`linking_token:${linkingToken}`, 300, JSON.stringify({ userId, deviceId }));

         await emitEventToUser(ctx, userId, 'auth:linking_qr_ready', { linkingToken }, deviceId);
         break;
       }

        case 'message:unsend': {
          const { messageId, conversationId, targetRecipients, deleteSecret } = data as { messageId: string, conversationId: string, targetRecipients?: string[], deleteSecret?: string };
          if (!messageId || !conversationId) return;
          const msg = await ctx.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, senderId: true, deleteSecret: true } });
          if (!msg || msg.conversationId !== conversationId) return;

          // Authorization: pengirim pesan ATAU pemegang deleteSecret (blind auth) yang boleh unsend.
          // Pesan 1:1 disimpan dengan senderId null (Opaque Mailbox), jadi proof via deleteSecret.
          const isSender = msg.senderId !== null && msg.senderId === userId;
          const hasValidSecret = typeof deleteSecret === 'string' && !!msg.deleteSecret && safeEqualStrings(deleteSecret, msg.deleteSecret);
          if (!isSender && !hasValidSecret) {
            console.warn('[Security] Unauthorized unsend attempt by', sanitizeForLog(userId), 'for message', sanitizeForLog(messageId));
            return;
          }

          await ctx.prisma.message.delete({ where: { id: messageId } });

         // Notify recipients about the unsend (Opaque Mailbox: explicit targetRecipients from client)
         const recipients = Array.isArray(targetRecipients) && targetRecipients.length > 0
           ? targetRecipients
           : (msg.senderId ? [msg.senderId] : []);
         for (const targetId of recipients) {
           if (typeof targetId === 'string' && targetId !== userId) {
             await emitEventToUser(ctx, targetId, 'message:deleted_remotely', { messageId, conversationId, deletedBy: userId });
           }
         }
         break;
       }

       case 'message:view_once_opened': {
         const { messageId, conversationId, targetRecipient } = data as { messageId: string, conversationId: string, targetRecipient?: string };
         if (!messageId || !conversationId) return;
         const msg = await ctx.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, senderId: true } });
         if (!msg || msg.conversationId !== conversationId) return;

         // Emit viewed event to sender then OBLITERATE from server
         // Opaque Mailbox: use explicit targetRecipient from client if available, fallback to msg.senderId
         const notifyTarget = targetRecipient || msg.senderId;
         if (notifyTarget && notifyTarget !== userId) {
           await emitEventToUser(ctx, notifyTarget, 'message:viewed', { messageId, conversationId });
         }
         await ctx.prisma.message.delete({ where: { id: messageId } }).catch(() => {});
         break;
       }

       case 'push:subscribe': {
         const { endpoint, keys } = data as PushSubscribePayload;
         if (!endpoint || !keys?.p256dh || !keys?.auth) return;
         await ctx.prisma.pushSubscription.upsert({
           where: { endpoint },
           update: { p256dh: keys.p256dh, auth: keys.auth, deviceId },
           create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, deviceId }
         });
         break;
       }

       case 'push:unsubscribe': {
         await ctx.prisma.pushSubscription.deleteMany({ where: { deviceId } });
         break;
       }

       // --- BURNER CHAT EVENTS ---
       case 'burner:join': {
         const { roomId } = data as { roomId?: string };
         if (roomId) await ctx.pubClient.sAdd(`burner:room:${roomId}`, userId);
         break;
       }
       case 'burner:send': {
         const { roomId, targetDeviceId, hostUserId, ciphertext } = data as { roomId: string, targetDeviceId?: string, hostUserId: string, ciphertext: string };
         if (await ctx.redisClient.exists(`burner:terminated:${roomId}`)) return;

         // Broadcast to all active sessions of the host if specific device ID fails or isn't strictly required
         await ctx.sendJsonToUser(hostUserId, TransportOpCode.KEY_SYNC, { event: 'burner:receive', data: { roomId, ciphertext } }, false, targetDeviceId);

         if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true });
         break;
       }
       case 'burner:reply': {
         const { roomId, ciphertext } = data as { roomId: string, ciphertext: string };
         if (await ctx.redisClient.exists(`burner:terminated:${roomId}`)) return;
         const members = await ctx.pubClient.sMembers(`burner:room:${roomId}`);
         for (const memberId of members) {
            if (memberId !== userId) await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'burner:receive', data: { roomId, ciphertext } });
         }
         break;
       }
       case 'burner:destroy': {
         const { roomId } = data as { roomId: string };
         await ctx.redisClient.set(`burner:terminated:${roomId}`, "1", { EX: 86400 });
         const members = await ctx.pubClient.sMembers(`burner:room:${roomId}`);
         for (const memberId of members) {
            await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'burner:terminated', data: { roomId } });
         }
         await ctx.pubClient.del(`burner:room:${roomId}`);
         break;
       }

       // --- MIGRATION EVENTS ---
       case 'migration:prepare': {
         await ctx.redisClient.set(`is_migrating:${userId}`, "1", { EX: 900 }); // 15 mins grace period
         if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true });
         break;
       }
       case 'migration:cancel': {
         await ctx.redisClient.del(`is_migrating:${userId}`);
         break;
       }
       case 'migration:join': {
         if (data) await ctx.pubClient.sAdd(`migration:room:${data}`, userId);
         break;
       }
       case 'migration:start': {
         const { roomId } = data as { roomId: string };
         await ctx.redisClient.set(`migration_owner:${roomId}`, userId, { EX: 3600 });
         const members = await ctx.pubClient.sMembers(`migration:room:${roomId}`);
         for (const memberId of members) {
            if (memberId !== userId) await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'migration:start', data });
         }
         break;
       }
       case 'migration:chunk': {
         const { roomId } = data as { roomId: string };
         const ownerId = await ctx.redisClient.get(`migration_owner:${roomId}`);
         if (ownerId !== userId) return;
         const members = await ctx.pubClient.sMembers(`migration:room:${roomId}`);
         for (const memberId of members) {
            if (memberId !== userId) await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'migration:chunk', data });
         }
         break;
       }
       case 'migration:ack': {
         const { roomId } = data as { roomId: string };
         const ownerId = await ctx.redisClient.get(`migration_owner:${roomId}`);

         // Clear migration grace period flag as it's finished
         await ctx.redisClient.del(`is_migrating:${userId}`);

         if (ownerId) await ctx.sendJsonToUser(ownerId, TransportOpCode.KEY_SYNC, { event: 'migration:ack', data });
         break;
       }

       case 'message:mark_read':
       case 'message:mark_as_read': {
         const { conversationId, messageId, targetRecipient } = data as { conversationId: string, messageId: string, targetRecipient?: string };
         await handleMessageStatusUpdate(ctx, userId, conversationId, messageId, 'READ', targetRecipient);
         break;
       }

       case 'message:ack_delivered': {
         const { conversationId, messageId, targetRecipient } = data as { conversationId: string, messageId: string, targetRecipient?: string };
         await handleMessageStatusUpdate(ctx, userId, conversationId, messageId, 'DELIVERED', targetRecipient);
         break;
       }

       case 'messages:mark_as_read':
       case 'messages:mark_read':
       case 'messages:mark_delivered': {
         const { conversationId, messageIds } = data as { conversationId: string, messageIds: string[] };
         const status = (event === 'messages:mark_read' || event === 'messages:mark_as_read') ? 'READ' : 'DELIVERED';
         if (!conversationId || !Array.isArray(messageIds)) return;

         // [PERF N+1] Batch path — lihat handleMessageStatusBatchUpdate.
         await handleMessageStatusBatchUpdate(ctx, userId, conversationId, messageIds, status);
         break;
       }

       case 'message:deleted': {
         const { conversationId, id: messageId, targetRecipients } = data as { conversationId: string, id: string, targetRecipients?: string[] };
         if (!conversationId || !messageId) return;

         const message = await ctx.prisma.message.findUnique({ where: { id: messageId } });
         if (!message || message.senderId !== userId) return;

         await ctx.prisma.message.delete({ where: { id: messageId } });

         // Notify recipients about the deletion (Opaque Mailbox: explicit targetRecipients from client)
         const recipients = Array.isArray(targetRecipients) && targetRecipients.length > 0
           ? targetRecipients
           : (message.senderId ? [message.senderId] : []);
         for (const targetId of recipients) {
           if (typeof targetId === 'string' && targetId !== userId) {
             await emitEventToUser(ctx, targetId, 'message:deleted', { conversationId, id: messageId });
           }
         }
         break;
       }

       default:
         console.warn(`[RedisBridge] Unhandled generic event: ${event}`);
     }
   } catch (e) {
     console.error(`[RedisBridge] Error in handleKeySync:`, e);
   }
}

// --- Internal: message status update (READ / DELIVERED) ---

// [FIX OFFLINE-LOSS] Grace period antara receipt READ dan penghapusan ciphertext
// 1:1 oleh messageSweeper. Receipt bisa tiba di server sebelum ciphertext tersimpan
// aman di sisi penerima (sync ulang / kunci datang belakangan); menghapus segera
// saat READ membuat pesan itu mustahil dipulihkan. Dengan grace period, pesan tetap
// bisa di-fetch catch-up (GET /api/messages) selama 24 jam setelah dibaca.
const READ_DELETE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 jam

async function handleMessageStatusUpdate(
  ctx: RealtimeContext,
  userId: string,
  conversationId: string,
  messageId: string,
  status: 'READ' | 'DELIVERED',
  targetRecipient?: string
): Promise<void> {
  if (!conversationId || !messageId) return;

  try {
    // 1. Cek keberadaan pesan & info grup (karena pesan ephemeral/cepat dihapus)
    const msg = await ctx.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, conversation: { select: { isGroup: true } } }
    });
    if (!msg) return;

    // Jangan update status jika pengirim sedang membaca pesan sendiri
    if (msg.senderId === userId) return;

    // [FIX OFFLINE-LOSS] Deteksi apakah pesan sudah pernah di-READ sebelumnya,
    // agar receipt READ berulang tidak memperpanjang masa retensi (arm TTL hanya sekali).
    const existingStatus = await ctx.prisma.messageStatus.findUnique({
      where: { messageId_userId: { messageId, userId } },
      select: { status: true }
    });
    const wasAlreadyRead = existingStatus?.status === 'READ';

    await ctx.prisma.messageStatus.upsert({
      where: { messageId_userId: { messageId, userId } },
      update: { status },
      create: { messageId, userId, status }
    });

    // Notify the original message sender about the status update
    // Opaque Mailbox: use explicit targetRecipient from client if available, fallback to msg.senderId
    const notifyTarget = targetRecipient || msg.senderId;
    if (notifyTarget && notifyTarget !== userId) {
      await emitEventToUser(ctx, notifyTarget, 'message:status_updated', {
        conversationId,
        messageId,
        userId,
        status
      });
    }

    // 2. LOGIKA PENGHAPUSAN OTOMATIS (Store-and-Forward Ephemerality)
    if (status === 'READ') {
        if (!msg.conversation.isGroup) {
            // [FIX OFFLINE-LOSS] Jangan hapus segera saat READ. Receipt prematur
            // (terkirim meski dekripsi di klien belum sukses) yang dulu langsung
            // menghancurkan satu-satunya salinan server. Sekarang cukup arm TTL
            // grace: messageSweeper menghapusnya lewat expiresAt, dan selama grace
            // pesan tetap bisa di-fetch catch-up offline.
            if (!wasAlreadyRead) {
                const graceExpiresAt = new Date(Date.now() + READ_DELETE_GRACE_MS);
                // One-shot: hanya persempit TTL (null atau lebih jauh dari grace);
                // receipt READ berulang tidak boleh memperpanjang retensi.
                await ctx.prisma.message.updateMany({
                    where: {
                        id: messageId,
                        OR: [
                            { expiresAt: null },
                            { expiresAt: { gt: graceExpiresAt } }
                        ]
                    },
                    data: { expiresAt: graceExpiresAt }
                }).catch(() => {});
            }
        }
        // Dalam grup (Opaque Mailbox), server tidak tahu jumlah partisipan.
        // Pesan akan dihapus otomatis oleh TTL (expiresAt).
    }
  } catch (e: unknown) {
    // Tangani P2003 (FK Violation) jika pesan dihapus tepat saat kueri berjalan
    if ((e as Record<string, unknown>).code === 'P2003') return;
    console.error(`[RedisBridge] Failed to update message status:`, e);
  }
}

// --- Batch receipt (N+1 fix) ---
// [PERF] `messages:mark_as_read` (plural) dulu memanggil
// handleMessageStatusUpdate per messageId = 2-3 query sequential per pesan
// (findUnique message + findUnique existing status + upsert + optional
// updateMany TTL). Membuka grup dengan banyak unread = ratusan round-trip DB
// di VPS 1-core. Kini: 1x fetch pesan (findMany), 1x fetch existing status
// (findMany), 1x promise.all upsert (paralel, tetap per-baris karena
// upsert massal belum didukung Prisma untuk composite-unique), 1x updateMany
// TTL (sekali untuk semua pesan 1:1 yang belum READ), dan broadcast paralel.
const BATCH_RECEIPT_MAX = 100;

async function handleMessageStatusBatchUpdate(
  ctx: RealtimeContext,
  userId: string,
  conversationId: string,
  messageIds: string[],
  status: 'READ' | 'DELIVERED'
): Promise<void> {
  if (!conversationId || !Array.isArray(messageIds) || messageIds.length === 0) return;
  // Dedupe + batasi ukuran batch (client mengirim list per conversation; cap
  // melindungi server dari payload tak wajar — sisanya bisa direceipt ulang).
  const ids = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id))).slice(0, BATCH_RECEIPT_MAX);
  if (ids.length === 0) return;

  try {
    // 1. Satu query untuk semua pesan: keberadaan + sender + isGroup
    const messages = await ctx.prisma.message.findMany({
      where: { id: { in: ids } },
      select: { id: true, senderId: true, conversation: { select: { isGroup: true } } }
    });
    if (messages.length === 0) return;

    const msgById = new Map(messages.map((m) => [m.id, m]));

    // 2. Satu query untuk semua status existing milik user ini
    const existingStatuses = await ctx.prisma.messageStatus.findMany({
      where: { messageId: { in: messages.map((m) => m.id) }, userId },
      select: { messageId: true, status: true }
    });
    const wasReadSet = new Set(
      existingStatuses.filter((s) => s.status === 'READ').map((s) => s.messageId)
    );

    // 3. Upsert paralel — skip pesan sendiri (pengirim tidak me-receipt dirinya)
    await Promise.all(messages
      .filter((m) => m.senderId !== userId)
      .map((m) => ctx.prisma.messageStatus.upsert({
        where: { messageId_userId: { messageId: m.id, userId } },
        update: { status },
        create: { messageId: m.id, userId, status }
      }).catch(() => {}) // P2003: pesan dihapus race — abaikan per-item
      ));

    // 4. Broadcast status ke pengirim — paralel (senderId bisa null pada pesan
    //    1:1 sealed-sender → tidak ada target notifikasi, dilewati).
    await Promise.all(messages
      .filter((m) => m.senderId !== null && m.senderId !== userId)
      .map((m) => emitEventToUser(ctx, m.senderId as string, 'message:status_updated', {
        conversationId,
        messageId: m.id,
        userId,
        status
      }).catch(() => {})));

    // 5. Grace TTL READ 1:1 — SATU updateMany untuk semua kandidat yang belum
    //    pernah READ. One-shot tetap terjaga: filter `wasAlreadyRead` + kondisi
    //    `expiresAt null atau lebih jauh dari grace` sama seperti jalur tunggal.
    if (status === 'READ') {
      const oneToOneCandidates = messages.filter((m) =>
        m.senderId !== userId && !m.conversation.isGroup && !wasReadSet.has(m.id)
      );
      if (oneToOneCandidates.length > 0) {
        const graceExpiresAt = new Date(Date.now() + READ_DELETE_GRACE_MS);
        await ctx.prisma.message.updateMany({
          where: {
            id: { in: oneToOneCandidates.map((m) => m.id) },
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: graceExpiresAt } }
            ]
          },
          data: { expiresAt: graceExpiresAt }
        }).catch(() => {});
      }
    }
  } catch (e: unknown) {
    if ((e as Record<string, unknown>).code === 'P2003') return;
    console.error(`[RedisBridge] Failed to batch update message statuses:`, e);
  }
}
