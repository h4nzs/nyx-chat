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
import { deviceInstallationTag, pepperedIdentifier } from '../utils/atRestSecrets.js';
// [docs/28 Tier 1.5 / D14] Redis tidak lagi memuat userId asli: key memakai tag,
// member SET yang perlu di-routing memakai nilai ter-seal.
import { identityKey, identityTag, sealIdentity } from '../utils/redisIdentity.js';
import { notifyPresenceWatchers, clearPresenceSubscriptions } from '../utils/presenceSubscriptions.js';
import type { MessageSendPayload, ServerToClientEvents, ClientToServerEvents, RawServerMessage, KeyRequestPayload, KeyFulfillmentPayload, GroupKeyRequestPayload, DistributeKeysPayload, PushSubscribePayload } from '@nyx/shared';
import { handleChatMessage, handleKeySync, handlePresence, handleWebRtcRelay, type RealtimeContext } from './realtimeHandlers.js';
// [docs/30 WS-G] Metrik event-only: label hanya enum pendek (opcode/reason),
// tidak pernah userId/deviceId — penjaganya ada di utils/metrics.ts.
import { incCounter, RELAY_OPS, SECURITY_BLOCKS } from '../utils/metrics.js';
// [AUDIT 2026-10-24] Penegakan ban di jalur WebTransport (tanpa requireAuth).
import { isUserBanned, type TokenGateDb } from '../utils/authGate.js';
// [AUDIT 2026-10-24] Index room per-user (pengganti SCAN keyspace saat disconnect).
import { leaveAllRooms, type RoomRedisClient } from '../utils/roomMembership.js';
// [docs/30 §30.9 WS-E(2)] Relay panggilan dialamatkan lewat token relay buram,
// bukan userId — payload relay & `nyx:downstream` tidak lagi memuat identitas.
// (Logika relay-nya kini di realtimeHandlers.handleWebRtcRelay, dipakai kedua jalur.)

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

      await handleUpstreamMessage(data.user_id, data.device_id, opCode, data.payload);
    } catch (error) {
      incCounter(RELAY_OPS, { op: relayOpLabel(channel), result: 'error' });
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
  const isMigrating = await redisClient.exists(identityKey('is_migrating', userId)).catch(() => 0);
  if (isMigrating) {
    activeDeviceCache.set(userId, { deviceId: '', expiresAt: now + 30000 });
    return true;
  }
  const active = await redisClient.get(identityKey('active_device', userId)).catch(() => null);
  activeDeviceCache.set(userId, { deviceId: active ?? '', expiresAt: now + 60000 });
  return !active || active === deviceId;
}

/** Label opcode yang aman untuk metrik (`0x1`, `0x63`) — nilai terbatas. */
function relayOpLabel(opCode: number | string): string {
  const numeric = typeof opCode === 'number' ? opCode : Number.parseInt(String(opCode).split(':').pop() || '0', 10);
  return `0x${Number.isFinite(numeric) ? numeric.toString(16) : 'unknown'}`;
}

async function handleUpstreamMessage(userId: string, deviceId: string, opCode: number, base64Payload: string) {
  const buffer = Buffer.from(base64Payload, 'base64');
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
      incCounter(SECURITY_BLOCKS, { op: relayOpLabel(opCode), reason: 'device_inactive' });
      incCounter(RELAY_OPS, { op: relayOpLabel(opCode), result: 'blocked' });
      console.warn(`[Security] Blocked opcode ${opCode} from non-active device ${sanitizeForLog(deviceId)} (user ${sanitizeForLog(userId)})`);
      return;
    }

    // [AUDIT 2026-10-24] Jalur WT tidak pernah melewati `requireAuth`, jadi ban
    // dulu hanya terasa lewat KICK pada koneksi yang sedang hidup: akun yang
    // di-ban bisa reconnect dengan access token yang sama (≤15 menit) dan tetap
    // mengirim. Cek memakai cache Redis yang sama dengan REST (satu query DB
    // per user per 15 menit), jadi biayanya satu GET per frame.
    if ((await isUserBanned({ redis: redisClient, db: prisma as unknown as TokenGateDb }, userId)).banned) {
      incCounter(SECURITY_BLOCKS, { op: relayOpLabel(opCode), reason: 'banned' });
      incCounter(RELAY_OPS, { op: relayOpLabel(opCode), result: 'blocked' });
      console.warn(`[Security] Blocked opcode ${opCode} from banned user (user ${sanitizeForLog(userId)})`);
      return;
    }

    // Operasi lolos gate keamanan → diteruskan ke handler.
    incCounter(RELAY_OPS, { op: relayOpLabel(opCode), result: 'accepted' });
  }

  switch (opCode) {
    case TransportOpCode.CHAT_MESSAGE:
      await handleChatMessage(realtimeCtx, userId, deviceId, payload as unknown as MessageSendPayload, msgId);
      break;
    case TransportOpCode.WEBRTC_SIGNAL:
      await handleWebRtcRelay(realtimeCtx, userId, deviceId, payload as { to?: string, type?: string, payload?: string }, TransportOpCode.WEBRTC_SIGNAL);
      break;
    case TransportOpCode.WEBRTC_ICE:
      await handleWebRtcRelay(realtimeCtx, userId, deviceId, payload as { to?: string, type?: string, payload?: string }, TransportOpCode.WEBRTC_ICE);
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
        // [AUDIT 2026-10-24] Payload 0x00 di sini HANYA dipakai untuk `identity`
        // (fingerprint + installationId) pada Lapis 2. Verifikasi JWT sudah
        // terjadi SEBELUM frame sampai ke wadah Redis ini: sidecar Rust memeriksa
        // token pada bidi control stream, dan gateway WSS pada
        // `socket.handshake.auth` — `userId`/`deviceId` di sini sudah hasil
        // verifikasi itu. Dulu blok ini juga mem-parse field `token` (termasuk
        // fallback "klien lama" untuk payload string mentah) yang tidak pernah
        // dibaca siapa pun: 25 baris yang terlihat seperti autentikasi tapi bukan.
        // Jangan menambahkan verifikasi token di sini — satu-satunya sumber
        // kebenaran adalah gerbang transport di atas.
        let authData: { identity?: { fingerprint: string, installationId: string } } = {};
        try {
          const parsed = JSON.parse(payloadStr) as unknown;
          if (typeof parsed === 'object' && parsed !== null && 'identity' in parsed) {
            authData = parsed as { identity?: { fingerprint: string, installationId: string } };
          }
        } catch {
          // Klien lama mengirim token mentah (bukan JSON) → tanpa identity.
          // Perilakunya sama seperti sebelumnya: device dengan fingerprint
          // terdaftar akan di-KICK `HARDWARE_MISMATCH` di Lapis 2 bawah.
        }

        // 🛡️ LAPIS 1: SINGLE ACTIVE DEVICE CHECK
        const activeDeviceId = await redisClient.get(identityKey('active_device', userId));
        const isMigrating = await redisClient.exists(identityKey('is_migrating', userId));

        if (activeDeviceId && activeDeviceId !== deviceId && !isMigrating) {
          incCounter(SECURITY_BLOCKS, { op: relayOpLabel(opCode), reason: 'session_revoked' });
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
          // [docs/28 Tier 1.5] anchor perangkat tersimpan sebagai TAG.
          select: { fingerprint: true, installationTag: true }
        });

        if (device && device.fingerprint) {
           // 🛡️ PERBAIKAN: Cegah bypass dengan menghilangkan payload 'identity'
           if (!authData.identity) {
              incCounter(SECURITY_BLOCKS, { op: relayOpLabel(opCode), reason: 'identity_missing' });
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
           // Kita beri toleransi: Jika anchor instalasi cocok, kita izinkan meskipun fingerprint browser berubah sedikit
           // [docs/28 Tier 1.5] kolom = TAG → bandingkan nilai ter-tag.
           const isAnchorMatch = !!device.installationTag
             && !!authData.identity.installationId
             && device.installationTag === deviceInstallationTag(authData.identity.installationId);

           if (!isFingerprintMatch && !isAnchorMatch) {
              incCounter(SECURITY_BLOCKS, { op: relayOpLabel(opCode), reason: 'hardware_mismatch' });
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
      incCounter(RELAY_OPS, { op: relayOpLabel(opCode), result: 'unhandled' });
      console.warn(`⚠️ Unhandled OpCode: 0x${opCode.toString(16)} from user ${userId}`);
  }
  }

  async function handleDisconnect(userId: string) {
  // [docs/28 Tier 1.5 / D14] `online_users` menyimpan TAG (bukan userId asli).
  const wasOnline = await pubClient.sRem('online_users', identityTag(userId));

  // [docs/28 Tier 1.5] Presence lazy: sinyal 'leave' hanya dikirim ke klien yang
  // BENAR-BENAR berlangganan user ini (in-memory registry, tidak persist).
  try {
    if (wasOnline === 1) {
      await notifyPresenceWatchers(userId, (target) =>
        sendJsonToUser(target, TransportOpCode.PRESENCE, { type: 'leave', userId })
      );
    }
    clearPresenceSubscriptions(userId);
  } catch (e) {
    console.warn('[Presence] Gagal mengirim sinyal leave ke watcher:', e);
  }

  // Best-effort cleanup for burner/migration rooms
  try {
    // [AUDIT 2026-10-24] Dulu dua `SCAN` seluruh keyspace dijalankan pada SETIAP
    // disconnect — biayanya linear terhadap jumlah room dan muncul tepat saat
    // banyak koneksi putus bersamaan. Sekarang cukup set milik user ini
    // (`utils/roomMembership.ts`). Member tetap nilai TER-SEAL (docs/28 D14).
    const sealedMember = await sealIdentity(userId);
    await leaveAllRooms(pubClient as unknown as RoomRedisClient, {
      sealedMember,
      memberTag: identityTag(userId),
    });
  } catch (e) {
    console.error('[RedisBridge] Room cleanup error:', e);
  }
  }

/**
 * [PARITY 2026-10-18] Logika relay panggilan kini hidup di `realtimeHandlers.ts`
 * (`handleWebRtcRelay`) supaya gateway WSS memakai jalur yang SAMA — sebelumnya
 * jalur WSS tidak punya relay sama sekali, jadi sinyal panggilan hilang.
 * Memori/catatan: `to` = token relay buram, bukan userId (docs/30 §30.9).
 *
 * Dipakai jalur WT lewat `handleUpstreamMessage` (lihat switch opcode di atas).
 */


