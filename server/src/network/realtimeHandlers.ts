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
import crypto from 'crypto';
import { toRawServerMessage, resolveRepliedToId } from '../utils/mappers.js';
// [docs/28 Tier 2 — B1] seq atomik per-conversation.
import { reserveMessageSeq, type SeqPrismaClient } from '../utils/messageSequence.js';
// [docs/28 Tier 2 — B3] bucket waktu pesan (createdAt/expiresAt kasar).
import { messageTimeBucket } from '../utils/temporalBucket.js';
import { sendPushNotification } from '../utils/sendPushNotification.js';
import { sanitizeForLog } from '../utils/logger.js';
import { safeEqualStrings } from '../utils/validate.js';
import { getSodium } from '../lib/sodium.js';
import { credentialTokenMatches, hashCredentialToken, sealAtRest } from '../utils/atRestSecrets.js';
import { collectPresencePeers, type PresenceMembershipClient } from '../utils/presencePeers.js';
// [docs/28 Tier 1.5 / D14] presence lazy (langganan in-memory) + identitas Redis
// yang tidak lagi memuat userId asli.
import {
  MAX_PRESENCE_SUBSCRIPTIONS,
  notifyPresenceWatchers,
  subscribePresence,
} from '../utils/presenceSubscriptions.js';
import {
  identityKey,
  identityMatches,
  identityTag,
  openIdentity,
  openIdentityMembers,
  sealIdentity,
} from '../utils/redisIdentity.js';
import { conversationScopedTag } from '../utils/atRestSecrets.js';
import { upsertMembership, type MembershipPrisma } from '../utils/routingIdentity.js';
// [docs/28 Tier 4] identitas pengirim at-rest: pseudonym klien dipakai apa
// adanya, selain itu userId disimpan TER-SEAL dan dibuka lagi di jalur baca.
import {
  openMessageForClient,
  openSenderId,
  sealSystemContentDeviceKeys,
  senderIdForStorage,
} from '../utils/senderIdentity.js';
import { sanitizeGroupMetadataBlob } from '../utils/groupMetadataBlob.js';

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

  const { conversationId, content, sessionId, tempId, expiresAt, isViewOnce, pushPayloads, repliedToId, targetRecipients, deleteSecret, senderPseudonym, targetDeliveryTokens } = validatedPayload;

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
          include: {}
        });
        if (existing) {
          const safeMessage = toRawServerMessage(await openMessageForClient(existing)) as RawServerMessage;
          // [docs/28 Tier 2 — 2.2] buka reply edge ter-seal sebelum dikirim.
          safeMessage.repliedToId = (await resolveRepliedToId(existing.repliedToId)) ?? undefined;
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

    // [docs/28 Tier 2 — B1] Urutan pesan ditetapkan server lewat seq atomik
    // per-conversation. `reserveMessageSeq` + `create` berada dalam SATU
    // transaksi supaya pesan tidak pernah tersimpan tanpa seq yang benar.
    const newMessageRaw = await ctx.prisma.$transaction(async (tx) => {
      const seq = await reserveMessageSeq(tx as unknown as SeqPrismaClient, conversationId);
      // [docs/28 Tier 2 — B3] createdAt dikasar (15 mnt); expiresAt diturunkan dari
      // waktu kasar yang SAMA supaya presisi tidak bocor lewat expiresAt − TTL.
      const messageAt = messageTimeBucket();
      const ttlMs = expiresAt
        ? Math.max(0, new Date(expiresAt).getTime() - Date.now())
        : 14 * 24 * 60 * 60 * 1000;
      const created = await tx.message.create({
        data: {
            conversationId,
            // [T1 GROUP PSEUDONYMS — doc 26.2] Group messages: store the client-
            // supplied `senderPseudonym` (opaque, unlinkable to accounts) instead
            // of the authenticated userId. 1:1 stays sealed (senderId: null).
            // [docs/28 Tier 4] pseudonym apa adanya; TANPA pseudonym → userId
            // TER-SEAL (jaring pengaman; klien sekarang selalu mengirim pseudonym).
            senderId: await senderIdForStorage({
              isGroup: conversation.isGroup === true,
              userId,
              senderPseudonym,
            }),
            content,
            // [docs/28 Tier 4] sessionId (relasi device↔percakapan) ter-seal.
            sessionId: sessionId ? await sealAtRest(sessionId) : null,
            // [docs/28 Tier 2 — 2.2] edge balasan disimpan TER-SEAL (dump tidak
            // memuat "siapa membalas siapa"); dibuka lagi saat read.
            repliedToId: repliedToId ? await sealAtRest(repliedToId) : null,
            seq,
            createdAt: messageAt,
            // [PARITY TTL] Jalur REST (routes/messages.ts) memakai default 14 hari
            // (store-and-forward). Tanpa default yang sama di sini, payload WT
            // tanpa `expiresAt` tersimpan TANPA TTL — pesan jadi persisten
            // selamanya (ditemukan saat inspeksi DB lokal: 1 dari 10 pesan).
            expiresAt: new Date(messageAt.getTime() + ttlMs),
            isViewOnce: isViewOnce === true,
            // [docs/28 Tier 0 — D3] blind-delete token disimpan sebagai HASH
            // (SHA-256 hex): dump DB tidak memberi kemampuan unsend pesan orang
            // lain. Verifikasi dual-mode via credentialTokenMatches.
            deleteSecret: deleteSecret ? hashCredentialToken(deleteSecret) : null
        },
        include: {}
      });
      await tx.conversation.update({
        where: { id: conversationId },
        // [docs/28 Tier 2 — B3] lastMessageAt diturunkan dari waktu kasar yang sama.
        data: { lastMessageAt: messageAt }
      });
      return created;
    });

    // Finalisasi slot dedupe dengan id pesan hasil insert.
    if (tempId !== undefined && deviceId) {
      await completeMessageSlot(ctx, deviceId, tempId, newMessageRaw.id);
    }

    const safeMessage = toRawServerMessage(await openMessageForClient(newMessageRaw)) as RawServerMessage;
    // [docs/28 Tier 2 — 2.2] kirim id balasan ASLI (bukan nilai ter-seal).
    if (repliedToId) safeMessage.repliedToId = repliedToId;
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
                // [T3b TOKEN-FIRST] Membership row kunci token (issuer = pengirim);
                // userId disertai HANYA untuk routing (push, sweeper). Pesan tanpa
                // token untuk target tidak membuat baris — discovery = possession.
                const targetToken = targetDeliveryTokens?.[targetId];
                if (targetToken) {
                    // [docs/28 Tier 1.2] routing identity ter-seal (lihat util-nya).
                    upsertMembership(ctx.prisma as unknown as MembershipPrisma, {
                        userId: targetId, conversationId, deliveryToken: targetToken
                    }).catch((e: unknown) => console.warn('[OpaqueMailbox] Failed to upsert UserHiddenConversation:', e));
                }
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
  payload: { event: string, conversationId?: string, userIds?: string[] }
): Promise<void> {
  // [docs/28 Tier 1.5 / D14] Presence lazy/opt-in: klien MEMINTA status untuk
  // kontak yang sedang ia tampilkan (`subscribe`), tidak ada snapshot otomatis,
  // dan join/leave hanya dikirim ke klien yang berlangganan user tersebut.
  // Daftar peer tetap diturunkan server (`UserHiddenConversation`) — klien tidak
  // bisa memakai endpoint ini untuk memetakan pengguna yang tidak ia kenal.
  if (payload.event === 'subscribe' || payload.event === 'presence:subscribe') {
    if (!await ctx.checkRateLimit(userId, 'presence_subscribe', 60, 60)) return;

    const requested = Array.isArray(payload.userIds)
      ? payload.userIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_PRESENCE_SUBSCRIPTIONS)
      : [];

    const peers = await collectPresencePeers(ctx.prisma as unknown as PresenceMembershipClient, userId);
    const peerSet = new Set(peers);
    const allowed = requested.filter((id) => peerSet.has(id));
    const stored = subscribePresence(userId, allowed);

    // Balas status terkini HANYA untuk peer yang benar-benar disimpan.
    const onlineTags = new Set(await ctx.pubClient.sMembers('online_users'));
    const statuses = stored.map((id) => ({ userId: id, online: onlineTags.has(identityTag(id)) }));
    await ctx.sendJsonToUser(userId, TransportOpCode.PRESENCE, { type: 'sync', statuses });
    return;
  }

  if (payload.event === 'active' || payload.event === 'user:active') {
    // [docs/28 Tier 1.5 / D14] `online_users` menyimpan TAG (bukan userId asli).
    const added = await ctx.pubClient.sAdd('online_users', identityTag(userId));
    if (added === 1) {
      await notifyPresenceWatchers(userId, (target) =>
        ctx.sendJsonToUser(target, TransportOpCode.PRESENCE, { type: 'join', userId })
      );
    }
    return;
  }

  if (payload.event === 'away' || payload.event === 'user:away') {
    const removed = await ctx.pubClient.sRem('online_users', identityTag(userId));
    if (removed === 1) {
      await notifyPresenceWatchers(userId, (target) =>
        ctx.sendJsonToUser(target, TransportOpCode.PRESENCE, { type: 'leave', userId })
      );
    }
    return;
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
         // [T2 FINAL — REMOVED] Jalur legacy distribusi kunci grup dihapus
         // (blueprint 26.5: deferred removal kini dieksekusi — prod di-reset,
         // semua klien ter-update, pairwise GROUP_KEY adalah satu-satunya jalur).
         // Handler menjadi no-op yang selalu menolak: klien lama yang masih
         // mengirim event ini mendapat ACK error eksplisit, bukan hening.
         if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: false, error: 'distribute_keys removed — use pairwise GROUP_KEY delivery' });
         break;
       }        case 'group:request_key': {
         const { conversationId, targetSenderId, targetDeviceKey } = data as GroupKeyRequestPayload;
         if (!conversationId) return;
         if (!await ctx.checkRateLimit(userId, 'group_request_key', 60, 60)) return;

         // [BUGFIX 2026-10-02 — ROUTING VIA DEVICE KEY] Peminta yang belum punya
         // metadata grup tidak bisa me-resolve pseudonym → targetSenderId =
         // PSEUDONYM (bukan userId) → emitEventToUser ke id tak dikenal →
         // fulfillment TIDAK PERNAH sampai (gejala: anggota baru hanya bisa
         // dekripsi pesan pembuat grup, karena wrapper metadata memakai userId
         // mentah sedangkan wrapper pesan memakai pseudonym — log 3-browser
         // 2026-10-02). senderDeviceKey = identity key device pengirim yang
         // SUDAH tersimpan di tabel Device → server map sendiri ke userId.
         // Server tidak membocorkan apa pun yang belum dia ketahui.
         let fulfillerId = targetSenderId;
         if (targetDeviceKey) {
             try {
                 const dev = await ctx.prisma.device.findFirst({
                     where: { publicKey: Buffer.from(targetDeviceKey, 'base64url') },
                     select: { userId: true }
                 });
                 if (dev?.userId) fulfillerId = dev.userId;
             } catch {
                 // fallback ke targetSenderId apa adanya
             }
         }
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
           const { requesterId, conversationId, encryptedKey, targetDeviceId, senderDeviceKey, senderSigningKey, drHeader, senderPseudonym, adminToken } = data as KeyFulfillmentPayload & { senderPseudonym?: string; senderSigningKey?: string; adminToken?: boolean };
           if (!requesterId || !conversationId || !encryptedKey) return;
           if (!await ctx.checkRateLimit(userId, 'group_fulfilled_key', 60, 60)) return;

           // [T1] Fulfillment replay pakai pseudonym pengirim asli (bila klien
           // menyertakan) — requester mengenali sender via peta metadata.
           // [T2 FIX #9 2026-09-28] senderSigningKey = public signing key pengirim,
           // diikat ke receiver state penerima (pola libsignal SenderKeyState).
           // [docs/28 Tier 4] Satu-satunya tempat `?? userId` masih dipakai:
           // payload IN-FLIGHT ini harus memuat identitas yang bisa di-resolve
           // penerima untuk menyimpan state kunci grup (`storeReceivedSessionKey`
           // menolak senderId kosong). Nilainya tidak pernah persist di DB; klien
           // selalu mengirim pseudonym lewat ensureMyPseudonym, jadi cabang ini
           // hanya jaring pengaman bila payload cacat.
           const emitPayload: Record<string, unknown> = { conversationId, encryptedKey, type: 'GROUP_KEY', senderId: senderPseudonym ?? userId, senderDeviceKey, senderSigningKey };
           if (drHeader) emitPayload.drHeader = drHeader;
           // [26.9 RBAC] Amplop admin capability token ditandai eksplisit agar
           // penerima TIDAK memprosesnya sebagai chain key GROUP_KEY.
           if (adminToken) emitPayload.adminToken = true;

           // [OFFLINE-KEY PERSIST — FIX 2026-09-27] Kunci juga dipersist sebagai
           // SYSTEM message (TTL 7d, pola = metadata:updated): fulfillment yang
           // datang saat requester OFFLINE tidak boleh hilang, kalau tidak dia
           // terjebak waiting_for_key sampai pengirim online lagi. Offline catch-up
           // mengenali content '"type":"GROUP_KEY"' dan meng-unseal envelope-nya.
           // [docs/28 Tier 2 — B1] pesan SYSTEM juga partisipan urutan → ikut seq.
           // [R7 2026-10-15] reserve + create dalam SATU transaksi, sama seperti
           // jalur pesan pengguna. Sebelumnya `reserveMessageSeq(...).catch(() => 0)`
           // bisa MENULIS seq 0 — sentinel "baris legacy/belum di-backfill" menurut
           // schema — sehingga pesan SYSTEM melompat ke awal riwayat percakapan,
           // dan kegagalan setelah reservasi meninggalkan lubang seq permanen.
           // Kalau transaksinya gagal, baris SYSTEM-nya memang tidak tertulis;
           // itu lebih benar daripada menulisnya dengan urutan bohong.
           // [docs/28 Tier 2 — B3] waktu kasar + expiresAt diturunkan darinya.
           const groupKeyAt = messageTimeBucket();
           await ctx.prisma.$transaction(async (tx) => {
               const seq = await reserveMessageSeq(tx as unknown as SeqPrismaClient, conversationId);
               await tx.message.create({
                 data: {
                   conversationId,
                   senderId: await senderIdForStorage({ isGroup: true, userId, senderPseudonym }),
                   type: 'SYSTEM',
                   seq,
                   createdAt: groupKeyAt,
                   // [docs/28 Tier 4] Device.id target disimpan TER-SEAL; server
                   // membukanya kembali saat relay/catch-up (openMessageForClient).
                   content: await sealSystemContentDeviceKeys(JSON.stringify({ type: 'GROUP_KEY', key: encryptedKey, senderDeviceKey, senderSigningKey, targetDeviceKey: targetDeviceId, ...(adminToken ? { adminToken: true } : {}) })),
                   expiresAt: new Date(groupKeyAt.getTime() + 7 * 24 * 60 * 60 * 1000)
                 }
               });
           }).catch((e: unknown) => console.warn('[KeySync] Failed to persist group key envelope:', e));

           await emitEventToUser(ctx, requesterId, 'session:new_key', emitPayload, targetDeviceId);
           break;
         }

        case 'metadata:updated': {
           // [T2 FIX #10 2026-09-29] senderPseudonym dari klien — tanpa ini baris
           // SYSTEM METADATA_UPDATED dipersist dengan userId (leak terlihat di
           // audit DB lokal 2026-09-29). [docs/28 Tier 4] nilainya kini ter-seal.
           const { conversationId, encryptedMetadata, targetRecipients, senderPseudonym } = data as { conversationId: string; encryptedMetadata: string; targetRecipients: string[]; senderPseudonym?: string };
           if (!conversationId || !encryptedMetadata || !Array.isArray(targetRecipients)) return;
           if (!await ctx.checkRateLimit(userId, 'metadata_updated', 60, 60)) return;

           // [docs/28 Tier 4] buang `senderId` (userId penulis) dari wrapper
           // metadata v2 — reader tidak memakainya, jadi dump tidak lagi
           // memuat identitas pembuat grup (pertahanan untuk klien lama).
           const safeMetadata = sanitizeGroupMetadataBlob(encryptedMetadata);

           // Persist to DB for offline delivery (like messages:distribute_keys)
           // [docs/28 Tier 2 — B1] pesan SYSTEM juga ikut urutan seq.
           // [R7 2026-10-15] Satu transaksi untuk reserve + create (lihat catatan
           // panjang di cabang GROUP_KEY di atas): jangan pernah menyimpan seq 0.
           // [docs/28 Tier 2 — B3] waktu kasar + expiresAt diturunkan darinya.
           // [docs/28 Tier 2 — B5] id eksplisit TIDAK lagi time-ordered
           // (`msg_sys_meta_<Date.now()>_…` membocorkan waktu) — pakai UUID acak.
           const metaAt = messageTimeBucket();
           await ctx.prisma.$transaction(async (tx) => {
               const seq = await reserveMessageSeq(tx as unknown as SeqPrismaClient, conversationId);
               await tx.message.create({
                 data: {
                   id: `sys_meta_${crypto.randomUUID()}`,
                   conversationId,
                   senderId: await senderIdForStorage({ isGroup: true, userId, senderPseudonym }),
                   type: 'SYSTEM',
                   seq,
                   createdAt: metaAt,
                   content: JSON.stringify({ type: 'METADATA_UPDATED', encryptedMetadata: safeMetadata }),
                   isViewOnce: false,
                   expiresAt: new Date(metaAt.getTime() + 7 * 24 * 60 * 60 * 1000)
                 }
               });
           });

           for (const targetId of targetRecipients) {
               if (typeof targetId === 'string') {
                   await emitEventToUser(ctx, targetId, 'conversation:updated', { id: conversationId, encryptedMetadata: safeMetadata });
               }
           }
           break;
         }

        case 'auth:request_linking_qr': {
         if (!await ctx.checkRateLimit(userId, 'linking_qr', 5, 60)) return;
         const sodium = await getSodium();
         const linkingToken = sodium.to_hex(sodium.randombytes_buf(32));

         // Simpan di Redis: linkingToken -> { userId, deviceId } TER-SEAL.
         // [docs/28 Tier 1.5 / D14] Redis = artefak setara dump; tokennya acak,
         // tetapi nilainya memuat identitas → simpan ciphertext (bisa dibuka
         // saat redeem, tak terbaca dari dump).
         await ctx.redisClient.setEx(
           `linking_token:${linkingToken}`,
           300,
           await sealAtRest(JSON.stringify({ userId, deviceId }))
         );

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
          // [T1] Grup: senderId sekarang pseudonym (bukan userId auth) — cabang
          // isSender tidak bisa dipakai untuk grup; deleteSecret-only (keputusan 26.7.2).
          // [docs/28 Tier 4] bandingkan dengan nilai yang sudah DIBUKA (jalur
          // fallback lama menyimpan userId ter-seal).
          const openedSenderId = await openSenderId(msg.senderId);
          const isSender = openedSenderId !== null && openedSenderId === userId;
          const hasValidSecret = typeof deleteSecret === 'string' && !!msg.deleteSecret && credentialTokenMatches(msg.deleteSecret, deleteSecret);
          if (!isSender && !hasValidSecret) {
            console.warn('[Security] Unauthorized unsend attempt by', sanitizeForLog(userId), 'for message', sanitizeForLog(messageId));
            return;
          }
          // [T1] deletedBy pada notifikasi = pseudonym bila ada (jangan bocorkan
          // akun pengirim unsend ke penerima).
          const deletedBy = openedSenderId ?? userId;

          await ctx.prisma.message.delete({ where: { id: messageId } });

         // Notify recipients about the unsend (Opaque Mailbox: explicit targetRecipients from client)
         const recipients = Array.isArray(targetRecipients) && targetRecipients.length > 0
           ? targetRecipients
           : (openedSenderId ? [openedSenderId] : []);
         for (const targetId of recipients) {
           if (typeof targetId === 'string' && targetId !== userId) {
             await emitEventToUser(ctx, targetId, 'message:deleted_remotely', { messageId, conversationId, deletedBy });
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
         const notifyTarget = targetRecipient || (await openSenderId(msg.senderId));
         if (notifyTarget && notifyTarget !== userId) {
           await emitEventToUser(ctx, notifyTarget, 'message:viewed', { messageId, conversationId });
         }
         await ctx.prisma.message.delete({ where: { id: messageId } }).catch(() => {});
         break;
       }

       case 'push:subscribe': {
         const { endpoint, keys } = data as PushSubscribePayload;
         if (!endpoint || !keys?.p256dh || !keys?.auth) return;
         // [docs/28 Tier 1.5 / D10] endpoint FCM/APNs = identifier perangkat →
         // disimpan TER-SEAL (deterministik) supaya uniqueness & upsert tetap
         // bekerja, tetapi dump tidak memuat endpoint aslinya.
         const endpointSealed = await sealAtRest(endpoint);
         await ctx.prisma.pushSubscription.upsert({
           where: { endpointSealed },
           update: { p256dh: keys.p256dh, auth: keys.auth, deviceId },
           create: { endpointSealed, p256dh: keys.p256dh, auth: keys.auth, deviceId }
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
         // [docs/28 Tier 1.5 / D14] member = userId TER-SEAL (harus bisa dipulihkan
         // untuk routing, tapi tidak boleh terbaca dari dump Redis).
         if (roomId) await ctx.pubClient.sAdd(`burner:room:${roomId}`, await sealIdentity(userId));
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
         const members = await openIdentityMembers(await ctx.pubClient.sMembers(`burner:room:${roomId}`));
         for (const memberId of members) {
            if (memberId !== userId) await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'burner:receive', data: { roomId, ciphertext } });
         }
         break;
       }
       case 'burner:destroy': {
         const { roomId } = data as { roomId: string };
         await ctx.redisClient.set(`burner:terminated:${roomId}`, "1", { EX: 86400 });
         const members = await openIdentityMembers(await ctx.pubClient.sMembers(`burner:room:${roomId}`));
         for (const memberId of members) {
            await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'burner:terminated', data: { roomId } });
         }
         await ctx.pubClient.del(`burner:room:${roomId}`);
         break;
       }

       // --- MIGRATION EVENTS ---
       case 'migration:prepare': {
         await ctx.redisClient.set(identityKey('is_migrating', userId), "1", { EX: 900 }); // 15 mins grace period
         if (msgId) await sendAck(ctx, userId, deviceId, msgId, { ok: true });
         break;
       }
       case 'migration:cancel': {
         await ctx.redisClient.del(identityKey('is_migrating', userId));
         break;
       }
       case 'migration:join': {
         if (data) await ctx.pubClient.sAdd(`migration:room:${data}`, await sealIdentity(userId));
         break;
       }
       case 'migration:start': {
         const { roomId } = data as { roomId: string };
         // [docs/28 Tier 1.5 / D14] owner & member = nilai ter-seal.
         await ctx.redisClient.set(`migration_owner:${roomId}`, await sealIdentity(userId), { EX: 3600 });
         const members = await openIdentityMembers(await ctx.pubClient.sMembers(`migration:room:${roomId}`));
         for (const memberId of members) {
            if (memberId !== userId) await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'migration:start', data });
         }
         break;
       }
       case 'migration:chunk': {
         const { roomId } = data as { roomId: string };
         const ownerId = await ctx.redisClient.get(`migration_owner:${roomId}`);
         if (!await identityMatches(ownerId, userId)) return;
         const members = await openIdentityMembers(await ctx.pubClient.sMembers(`migration:room:${roomId}`));
         for (const memberId of members) {
            if (memberId !== userId) await ctx.sendJsonToUser(memberId, TransportOpCode.KEY_SYNC, { event: 'migration:chunk', data });
         }
         break;
       }
       case 'migration:ack': {
         const { roomId } = data as { roomId: string };
         const ownerId = await ctx.redisClient.get(`migration_owner:${roomId}`);

         // Clear migration grace period flag as it's finished
         await ctx.redisClient.del(identityKey('is_migrating', userId));

         // [docs/28 Tier 1.5 / D14] nilai tersimpan = ter-seal → dipetakan balik.
         const ownerUserId = ownerId ? await openIdentity(ownerId) : null;
         if (ownerUserId) await ctx.sendJsonToUser(ownerUserId, TransportOpCode.KEY_SYNC, { event: 'migration:ack', data });
         break;
       }

       case 'message:mark_read':
       case 'message:mark_as_read': {
         const { conversationId, messageId, targetRecipient, readerPseudonym } = data as { conversationId: string, messageId: string, targetRecipient?: string, readerPseudonym?: string };
         await handleMessageStatusUpdate(ctx, userId, conversationId, messageId, 'READ', targetRecipient, readerPseudonym);
         break;
       }

       case 'message:ack_delivered': {
         const { conversationId, messageId, targetRecipient, readerPseudonym } = data as { conversationId: string, messageId: string, targetRecipient?: string, readerPseudonym?: string };
         await handleMessageStatusUpdate(ctx, userId, conversationId, messageId, 'DELIVERED', targetRecipient, readerPseudonym);
         break;
       }

       case 'messages:mark_as_read':
       case 'messages:mark_read':
       case 'messages:mark_delivered': {
         const { conversationId, messageIds, targets, readerPseudonym } = data as { conversationId: string, messageIds: string[], targets?: Record<string, string>, readerPseudonym?: string };
         const status = (event === 'messages:mark_read' || event === 'messages:mark_as_read') ? 'READ' : 'DELIVERED';
         if (!conversationId || !Array.isArray(messageIds)) return;

         // [PERF N+1] Batch path — lihat handleMessageStatusBatchUpdate.
         // `targets` (Opaque Mailbox): peta messageId → pengirim hasil dekripsi
         // klien, karena DB 1:1 sealed-sender menyimpan senderId null sehingga
         // server tidak tahu ke mana notifikasi harus dikirim.
         // [T3a] `readerPseudonym`: identitas pembaca untuk grup metadata v2.
         await handleMessageStatusBatchUpdate(ctx, userId, conversationId, messageIds, status, targets, readerPseudonym);
         break;
       }

       case 'message:deleted': {
         const { conversationId, id: messageId, targetRecipients } = data as { conversationId: string, id: string, targetRecipients?: string[] };
         if (!conversationId || !messageId) return;

       const message = await ctx.prisma.message.findUnique({ where: { id: messageId } });
       // [docs/28 Tier 4] buka senderId ter-seal sebelum otorisasi.
       const openedSenderId = await openSenderId(message?.senderId);
       if (!message || openedSenderId !== userId) return;

         await ctx.prisma.message.delete({ where: { id: messageId } });

         // Notify recipients about the deletion (Opaque Mailbox: explicit targetRecipients from client)
         const recipients = Array.isArray(targetRecipients) && targetRecipients.length > 0
           ? targetRecipients
           : (openedSenderId ? [openedSenderId] : []);
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
// Grace 24 jam juga berfungsi sebagai HEAL WINDOW (invariant 4, 2026-10-02):
// selama grace, ciphertext 1:1 yang gagal dekripsi di klien masih bisa
// di-fetch ulang untuk re-decrypt setelah kunci diperbaiki — kombinasi dengan
// client-side fix offline-loss (receipt READ hanya untuk pesan yang sukses
// didekripsi) menutup kelas kehilangan ciphertext permanen.
const READ_DELETE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 jam

async function handleMessageStatusUpdate(
  ctx: RealtimeContext,
  userId: string,
  conversationId: string,
  messageId: string,
  status: 'READ' | 'DELIVERED',
  targetRecipient?: string,
  readerPseudonym?: string
): Promise<void> {
  if (!conversationId || !messageId) return;

  try {
    // 1. Cek keberadaan pesan & info grup (karena pesan ephemeral/cepat dihapus)
    const msg = await ctx.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, conversation: { select: { isGroup: true } } }
    });
    if (!msg) return;
    // [docs/28 Tier 4] nilai ter-seal dibuka sebelum dibandingkan dengan userId.
    const openedSenderId = await openSenderId(msg.senderId);

    // [T3a + docs/28 Tier 1.1 — D2] Identitas pembaca yang DIPERSIST:
    //  - grup (metadata v2) → pseudonym klien (opaque, sudah bagian protokol grup),
    //  - 1:1 → TAG opaque turunan SERVER (HMAC pepper atas
    //    conversationId+userId), BUKAN userId asli dan BUKAN nilai dari klien
    //    (kalau klien bisa memilih, ia bisa memalsukan receipt atas nama user lain).
    // Sebelumnya jalur ini menyimpan userId asli sehingga dump DB masih
    // merekonstruksi edge 1:1 walau Message.senderId sudah NULL.
    const persistedReaderId = msg.conversation.isGroup && readerPseudonym
      ? readerPseudonym
      : conversationScopedTag(conversationId, userId);

    // Jangan update status jika pengirim sedang membaca pesan sendiri
    // (bandingkan dengan identitas PERSISTED — pseudonym adalah milik pengirim
    // di peta; userId auth adalah milik pembaca. Keduanya ≠ → bukan self-read).
    // Skip pesan sendiri: senderId bisa pseudonym (grup), nilai ter-seal tanpa
    // pseudonym, atau NULL (1:1 sealed sender — tetap direceipt).
    if (openedSenderId !== null && (openedSenderId === userId || openedSenderId === readerPseudonym)) return;

    // [FIX OFFLINE-LOSS] Deteksi apakah pesan sudah pernah di-READ sebelumnya,
    // agar receipt READ berulang tidak memperpanjang masa retensi (arm TTL hanya sekali).
    const existingStatus = await ctx.prisma.messageStatus.findUnique({
      where: { messageId_userId: { messageId, userId: persistedReaderId } },
      select: { status: true }
    });
    const wasAlreadyRead = existingStatus?.status === 'READ';

    await ctx.prisma.messageStatus.upsert({
      where: { messageId_userId: { messageId, userId: persistedReaderId } },
      // [docs/28 Tier 2 — B3] updatedAt di-set EKSPLISIT ke bucket kasar karena
      // `@updatedAt` dihapus (Prisma akan menimpa dengan waktu presisi).
      update: { status, updatedAt: messageTimeBucket() },
      create: { messageId, userId: persistedReaderId, status, updatedAt: messageTimeBucket() }
    });

    // Notify the original message sender about the status update
    // Opaque Mailbox: use explicit targetRecipient from client if available, fallback to msg.senderId
    const notifyTarget = targetRecipient || openedSenderId;
    if (notifyTarget && notifyTarget !== userId) {
      await emitEventToUser(ctx, notifyTarget, 'message:status_updated', {
        conversationId,
        messageId,
        userId: persistedReaderId,
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
  status: 'READ' | 'DELIVERED',
  targets?: Record<string, string>,
  readerPseudonym?: string
): Promise<void> {
  if (!conversationId || !Array.isArray(messageIds) || messageIds.length === 0) return;
  // Dedupe + batasi ukuran batch (client mengirim list per conversation; cap
  // melindungi server dari payload tak wajar — sisanya bisa direceipt ulang).
  const ids = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id))).slice(0, BATCH_RECEIPT_MAX);
  if (ids.length === 0) return;

  try {
    // 1. Satu query untuk semua pesan: keberadaan + sender + isGroup
    const rows = await ctx.prisma.message.findMany({
      where: { id: { in: ids } },
      select: { id: true, senderId: true, conversation: { select: { isGroup: true } } }
    });
    if (rows.length === 0) return;
    // [docs/28 Tier 4] buka senderId ter-seal sebelum dibandingkan/dirutekan.
    const messages = await Promise.all(
      rows.map(async (m) => ({ ...m, senderId: await openSenderId(m.senderId) }))
    );

    // [T3a + docs/28 Tier 1.1 — D2] Paritas dengan jalur per-pesan: pseudonym
    // klien hanya untuk grup; 1:1 memakai tag opaque turunan server.
    const isGroupBatch = messages[0]!.conversation.isGroup;
    const persistedReaderId = isGroupBatch && readerPseudonym
      ? readerPseudonym
      : conversationScopedTag(conversationId, userId);

    const msgById = new Map(messages.map((m) => [m.id, m]));

    // 2. Satu query untuk semua status existing milik user ini
    const existingStatuses = await ctx.prisma.messageStatus.findMany({
      where: { messageId: { in: messages.map((m) => m.id) }, userId: persistedReaderId },
      select: { messageId: true, status: true }
    });
    const wasReadSet = new Set(
      existingStatuses.filter((s) => s.status === 'READ').map((s) => s.messageId)
    );

    // 3. Upsert paralel — skip pesan sendiri (pengirim tidak me-receipt dirinya)
    await Promise.all(messages
      // Paritas dengan jalur per-pesan: skip berdasarkan identitas PENGIRIM
      // (userId/pseudonym), bukan tag pembaca.
      .filter((m) => m.senderId === null || (m.senderId !== userId && m.senderId !== readerPseudonym))
      .map((m) => ctx.prisma.messageStatus.upsert({
        where: { messageId_userId: { messageId: m.id, userId: persistedReaderId } },
        // [docs/28 Tier 2 — B3] updatedAt coarse (bucket) — eksplisit.
        update: { status, updatedAt: messageTimeBucket() },
        create: { messageId: m.id, userId: persistedReaderId, status, updatedAt: messageTimeBucket() }
      }).catch(() => {}) // P2003: pesan dihapus race — abaikan per-item
      ));

    // 4. Broadcast status ke pengirim — paralel (senderId bisa null pada pesan
    //    1:1 sealed-sender → fallback ke target Opaque Mailbox dari klien;
    //    pesan tanpa keduanya tidak punya penerima notifikasi, dilewati).
    await Promise.all(messages
      .filter((m) => {
        if (m.senderId !== null && m.senderId !== userId) return true;
        if (m.senderId === null) {
          const t = targets?.[m.id];
          return typeof t === 'string' && t !== userId;
        }
        return false;
      })
      .map((m) => {
        const notifyTarget = m.senderId ?? targets?.[m.id];
        return emitEventToUser(ctx, notifyTarget as string, 'message:status_updated', {
          conversationId,
          messageId: m.id,
          userId: persistedReaderId, // [T3a] pseudonym untuk grup v2
          status
        }).catch(() => {});
      }));

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
