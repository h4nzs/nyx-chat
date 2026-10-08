import { createClient, type RedisClientType } from 'redis';
import { prisma } from '../lib/prisma.js';
import { redisClient } from '../lib/redis.js';
import { getSodium } from '../lib/sodium.js';
import { toRawServerMessage } from '../utils/mappers.js';
import { sendPushNotification } from '../utils/sendPushNotification.js';
import { sanitizeForLog } from '../utils/logger.js';
import { safeEqualStrings } from '../utils/validate.js';
import { TransportOpCode, MessageSendPayloadSchema } from '@nyx/shared';
import { createCheckRateLimit, DEVICE_CACHE_INVALIDATE_CHANNEL } from '../utils/redisResilience.js';
import { pepperedIdentifier } from '../utils/atRestSecrets.js';
import { collectPresencePeers, intersectOnline, type PresenceMembershipClient } from '../utils/presencePeers.js';
import type { MessageSendPayload, ServerToClientEvents, ClientToServerEvents, RawServerMessage, KeyRequestPayload, KeyFulfillmentPayload, GroupKeyRequestPayload, DistributeKeysPayload, PushSubscribePayload } from '@nyx/shared';
import { handleChatMessage, handleKeySync, handlePresence, type RealtimeContext } from './realtimeHandlers.js';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Lua atomic: INCR + EXPIRE dalam satu perintah — mencegah key hidup selamanya
// bila proses mati di antara dua perintah (race condition rate limit permanen).
// [ROBUSTNESS] FAIL-OPEN: Redis down → trafik realtime jalan tanpa limit
// socket (limit HTTP di app.ts berdiri sendiri), BUKAN seluruh realtime mati.
// Rejection yang dulu lepas dari handler socket kini tertangkap di sini.
// (Deklarasi SEBELUM realtimeCtx — shorthand property dievaluasi saat init.)
const checkRateLimit = createCheckRateLimit(redisClient);
export { checkRateLimit };

// Unified connection management
export const pubClient: RedisClientType = createClient({ url: redisUrl });
export const subClient: RedisClientType = pubClient.duplicate();

// Shared dependency-injection context for the MVP realtime handlers. Both the
// Rust-WebTransport upstream path (this file) and the socket.io gateway drive
// the SAME handler logic with these real bridge helpers, so outbound always
// rides `nyx:downstream` uniformly.
export const realtimeCtx: RealtimeContext = {
  sendToUser,
  sendToDevice,
  broadcastToUsers,
  sendJsonToUser,
  checkRateLimit,
  isActiveDeviceAllowed,
  prisma,
  redisClient,
  pubClient,
};

export async function initializeRedisBridge() {
  await Promise.all([pubClient.connect(), subClient.connect()]);
  console.log('🌐 Redis Bridge initialized and connected.');

  // [ROBUSTNESS] Channel invalidasi cache active-device (login/logout di satu
  // instance → cache lokal 60s dibuang di SEMUA instance).
  await subClient.subscribe(DEVICE_CACHE_INVALIDATE_CHANNEL, (message) => {
    try {
      const data = JSON.parse(message) as { userId?: string };
      if (typeof data.userId === 'string' && data.userId) {
        invalidateLocalActiveDeviceCache(data.userId);
      }
    } catch (e) {
      console.error('[RedisBridge] Invalid invalidation payload:', e);
    }
  });

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
export async function emitEventToUser(userId: string, event: string, data: unknown, deviceId?: string) {
  await sendJsonToUser(userId, TransportOpCode.KEY_SYNC, { event, data }, false, deviceId);
}

/**
 * Emits a named event to multiple users.
 */
export async function emitEventToUsers(userIds: string[], event: string, data: unknown) {
  await Promise.all(userIds.map(userId => emitEventToUser(userId, event, data)));
}

/**
 * Utility to send JSON payload (encoded to Base64) to a user.
 */
export async function sendJsonToUser(targetUserId: string, opCode: TransportOpCode, data: unknown, isDatagram = false, deviceId?: string) {
  const base64 = Buffer.from(JSON.stringify(data)).toString('base64');
  await sendToUser(targetUserId, opCode, base64, isDatagram, deviceId);
}

/**
 * Broadcasts a message to multiple users.
 */
export async function broadcastToUsers(userIds: string[], opCode: TransportOpCode, data: unknown) {
  await Promise.all(userIds.map(userId => sendJsonToUser(userId, opCode, data)));
}

// 🔒 Single active device check (per-opcode) dengan cache lokal 60 detik.
// Migration mode membolehkan device lama & baru bersamaan (sama seperti AUTH).
const activeDeviceCache = new Map<string, { deviceId: string; expiresAt: number }>();

/** [ROBUSTNESS] Hapus entri cache user (dipanggil oleh sinyal lintas-proses
 *  saat login/logout mengubah `active_device` di Redis). */
export function invalidateLocalActiveDeviceCache(userId: string): void {
  activeDeviceCache.delete(userId);
}

/** [ROBUSTNESS] Hapus seluruh cache (hook test). */
export function clearLocalActiveDeviceCache(): void {
  activeDeviceCache.clear();
}

export async function isActiveDeviceAllowed(userId: string, deviceId: string): Promise<boolean> {
  const now = Date.now();
  const cached = activeDeviceCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.deviceId === '' || cached.deviceId === deviceId;
  }
  const isMigrating = await redisClient.exists(`is_migrating:${userId}`).catch(() => 0);
  if (isMigrating) {
    activeDeviceCache.set(userId, { deviceId: '', expiresAt: now + 30000 });
    return true;
  }
  const active = await redisClient.get(`active_device:${userId}`).catch(() => null);
  activeDeviceCache.set(userId, { deviceId: active ?? '', expiresAt: now + 60000 });
  return !active || active === deviceId;
}

async function handleUpstreamMessage(userId: string, deviceId: string, opCode: number, base64Payload: string, _msgIdFromWrapper?: string) {  const buffer = Buffer.from(base64Payload, 'base64');
  const payloadStr = buffer.toString('utf-8');
  let payload: Record<string, unknown>;

  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>;
  } catch (e) {
    payload = { raw: payloadStr };
  }

  const msgId = typeof payload?.msgId === 'string' ? payload.msgId : undefined;

  // 🔒 SINGLE ACTIVE DEVICE — dicek untuk SETIAP opcode data (bukan hanya auth).
  // Device yang di-kick (login di perangkat lain) tidak boleh terus mengirim pesan
  // sampai melakukan re-auth. Cache lokal 60 detik untuk hindari Redis GET beruntun.
  if (opCode !== 0x00 && opCode !== 99) {
    const allowed = await isActiveDeviceAllowed(userId, deviceId);
    if (!allowed) {
      console.warn(`[Security] Blocked opcode ${opCode} from non-active device ${sanitizeForLog(deviceId)} (user ${sanitizeForLog(userId)})`);
      return;
    }
  }

  switch (opCode) {
    case TransportOpCode.CHAT_MESSAGE:
      await handleChatMessage(realtimeCtx, userId, deviceId, payload as unknown as MessageSendPayload, msgId);
      break;
    case TransportOpCode.WEBRTC_SIGNAL:
      await handleWebRtcRelay(userId, payload as { to: string, type: string, payload: string }, TransportOpCode.WEBRTC_SIGNAL);
      break;
    case TransportOpCode.WEBRTC_ICE:
      await handleWebRtcRelay(userId, payload as { to: string, type: string, payload: string }, TransportOpCode.WEBRTC_ICE);
      break;
    case TransportOpCode.PRESENCE:
      await handlePresence(realtimeCtx, userId, payload as { event: 'active' | 'away' | 'typing:start' | 'typing:stop', conversationId?: string });
      break;
    case TransportOpCode.KEY_SYNC:
      await handleKeySync(realtimeCtx, userId, deviceId, payload as { event: string, msgId: string, data: Record<string, unknown> }, msgId);
      break;
    case 99: // DISCONNECT
      await handleDisconnect(userId);
      break;
    case 0x00: // AUTH (Lapis 1 & 2 Security: Session & Hardware Binding)
      try {
        // Payload OpCode 0x00 sekarang adalah JSON string: { token: string, identity: { fingerprint, installationId } }
        let authData: { token: string, identity?: { fingerprint: string, installationId: string } };
        try {
           const parsed = JSON.parse(payloadStr) as unknown;
           if (typeof parsed === 'object' && parsed !== null && 'token' in parsed) {
             authData = parsed as { token: string, identity?: { fingerprint: string, installationId: string } };
           } else {
             authData = { token: payloadStr };
           }
        } catch (e) {
           // Fallback untuk klien lama yang hanya mengirim token sebagai string mentah
           authData = { token: payloadStr };
        }

        // 🛡️ LAPIS 1: SINGLE ACTIVE DEVICE CHECK
        const activeDeviceId = await redisClient.get(`active_device:${userId}`);
        const isMigrating = await redisClient.exists(`is_migrating:${userId}`);

        if (activeDeviceId && activeDeviceId !== deviceId && !isMigrating) {
          console.warn(`[Security-L1] Revoked device ${deviceId} (User ${userId}) tried to connect. Kicking...`);
          const kickPayload = Buffer.from(JSON.stringify({
            reason: 'SESSION_REVOKED',
            deviceId,
            message: 'You have been logged in from another device.'
          })).toString('base64');
          await sendToDevice(userId, deviceId, TransportOpCode.KICK, kickPayload);
          return;
        }

        // 🛡️ LAPIS 2: HARDWARE BINDING (FINGERPRINT CHECK)
        const device = await prisma.device.findUnique({
          where: { id: deviceId },
          select: { fingerprint: true, installationId: true }
        });

        if (device && device.fingerprint) {
           // 🛡️ PERBAIKAN: Cegah bypass dengan menghilangkan payload 'identity'
           if (!authData.identity) {
              console.warn(`[Security-L2] Missing identity payload from device ${deviceId} (User ${userId}). Kicking...`);
              const kickPayload = Buffer.from(JSON.stringify({
                reason: 'HARDWARE_MISMATCH',
                deviceId,
                message: 'Security Alert: Incomplete device identity. Please login again.'
              })).toString('base64');
              await sendToDevice(userId, deviceId, TransportOpCode.KICK, kickPayload);
              return;
           }

           // [docs/28 Tier 0 — D7] fingerprint tersimpan dalam bentuk ter-index
           // (HMAC pepper), jadi bandingkan dengan nilai ter-index juga.
           const isFingerprintMatch = device.fingerprint === pepperedIdentifier(authData.identity.fingerprint);
           // Kita beri toleransi: Jika installationId (Anchor) cocok, kita izinkan meskipun fingerprint browser berubah sedikit
           const isAnchorMatch = device.installationId && device.installationId === authData.identity.installationId;

           if (!isFingerprintMatch && !isAnchorMatch) {
              console.warn(`[Security-L2] Hardware mismatch for device ${deviceId} (User ${userId}). Possible session cloning. Kicking...`);
              const kickPayload = Buffer.from(JSON.stringify({
                reason: 'HARDWARE_MISMATCH',
                deviceId,
                message: 'Security Alert: Device identity mismatch. Please login again.'
              })).toString('base64');
              await sendToDevice(userId, deviceId, TransportOpCode.KICK, kickPayload);
              return;
           }
        }
      } catch (err) {
        console.error('[Security] Failed to verify session binding:', err);
      }
      break;
    default:
      console.warn(`⚠️ Unhandled OpCode: 0x${opCode.toString(16)} from user ${userId}`);
  }
  }

  async function handleDisconnect(userId: string) {
  const wasOnline = await pubClient.sRem('online_users', userId);

  // [docs/28 Tier 0.7 — D14] Cleanup presence: sinyal 'leave' hanya ke PEER yang
  // sedang online (dulu broadcast ke seluruh roster online_users). Query peer
  // dibungkus try/catch — kegagalan DB tidak boleh menggagalkan penanganan
  // disconnect (koneksi tetap dibersihkan).
  try {
    if (wasOnline === 1) {
      const onlineUsers = new Set(await pubClient.sMembers('online_users'));
      const peers = await collectPresencePeers(prisma as unknown as PresenceMembershipClient, userId);
      await broadcastToUsers(intersectOnline(peers, onlineUsers), TransportOpCode.PRESENCE, { event: 'leave', userId });
    }
  } catch (e) {
    console.warn('[Presence] Gagal mengirim sinyal leave ke peer:', e);
  }

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

async function handleWebRtcRelay(fromUserId: string, payload: { to: string, type: string, payload: string }, opCode: TransportOpCode) {
  if (!payload.to) return;
  const relayPayload = { from: fromUserId, type: payload.type, payload: payload.payload };
  await sendJsonToUser(payload.to, opCode, relayPayload, opCode === TransportOpCode.WEBRTC_ICE);
}


