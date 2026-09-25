// server/src/realtime/gateway.ts
//
// WebSocket (socket.io) fallback gateway.
//
// Clients on networks that block UDP/QUIC (and therefore cannot use the
// Rust-WebTransport path) can still get realtime delivery here. Inbound events
// are validated + guarded exactly like the WT path and then delegated to the
// SAME extracted handlers in realtimeHandlers.ts, using a RealtimeContext whose
// send* helpers are the REAL redisBridge ones — so every outbound envelope rides
// `nyx:downstream` identically and is fanned out by the Rust sidecar to any
// other connected devices of the same user.
//
// Outbound: a dedicated Redis subscriber listens on `nyx:downstream` and pushes
// envelopes ONLY to the sockets we hold locally for that user/device.
//
// Horizontal-scaling contract (see docs/10-deployment-ops.md §10.10):
// - Inbound is instance-agnostic: every event goes through the shared Redis
//   relay (rate limits and active-device checks are Redis-backed), so any
//   replica can process any socket's traffic.
// - Outbound is broadcast-and-filter: EVERY replica receives `nyx:downstream`
//   and delivers only to sockets it holds locally. Adding replicas requires no
//   socket.io Redis adapter as long as delivery keeps flowing through this
//   subscriber (never io.to(room).emit).
// - The ONLY multi-instance caveat is the polling transport (long-polling
//   requests must hit the same replica during handshake/upgrade). Either put a
//   sticky-session LB in front of the replicas, or ship the client with
//   VITE_WSS_TRANSPORTS=websocket so connections are a single upgraded TCP
//   stream that any LB can route independently.

import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { redisClient } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { verifyAuth } from '../middleware/auth.js';
import { env } from '../config.js';
import { TransportOpCode } from '@nyx/shared';
import type { AuthPayload } from '../types/auth.js';
import {
  sendToUser,
  sendToDevice,
  broadcastToUsers,
  sendJsonToUser,
  checkRateLimit,
  isActiveDeviceAllowed,
  pubClient,
} from '../network/redisBridge.js';
import {
  handleChatMessage,
  handleKeySync,
  handlePresence,
  handleAck,
  type RealtimeContext,
} from '../network/realtimeHandlers.js';

// --- CORS allowlist (mirrors app.ts isAllowedOrigin) ---
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true;
  const isProd = env.nodeEnv === 'production';
  const baseOrigins = Array.isArray(env.corsOrigin) ? env.corsOrigin : [env.corsOrigin];
  const allowedOrigins = [
    ...baseOrigins,
    'https://nyx-app.my.id',
    'https://www.nyx-app.my.id',
    'https://api.nyx-app.my.id',
    'https://app.nyx-app.my.id',
    'https://rt.nyx-app.my.id',
    'https://storage.nyx-app.my.id',
    ...(!isProd
      ? [
          'http://localhost:5173',
          'http://localhost:4173',
          'http://nyx-app.my.id',
          'http://www.nyx-app.my.id',
          'http://app.nyx-app.my.id',
          'http://api.nyx-app.my.id',
          'http://rt.nyx-app.my.id',
          'http://storage.nyx-app.my.id',
        ]
      : []),
  ];
  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin.includes('*')) {
      const escapedOrigin = escapeRegExp(allowedOrigin);
      const pattern = escapedOrigin.replace(/\\\*/g, '.*');
      const regex = new RegExp('^' + pattern + '$');
      return regex.test(origin);
    }
    return allowedOrigin === origin;
  });
}

// --- Manual cookie parser (no new dependency) ---
function parseAtCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const name = seg.slice(0, eq);
    if (name === 'at') {
      try {
        return decodeURIComponent(seg.slice(eq + 1));
      } catch {
        return seg.slice(eq + 1);
      }
    }
  }
  return null;
}

// Shared context — real bridge helpers so outbound rides nyx:downstream.
const wsCtx: RealtimeContext = {
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

// --- Multi-socket registry (multi-tab / multi-device) ---
// Keyed by `${userId}:${deviceId}` → Set<Socket>. A single account can have
// several live sockets (multiple browser tabs share the same JWT deviceId, or
// several distinct devices). Using a Set per key means a new connection NEVER
// evicts an existing one — every held socket receives downstream delivery.
export type SocketRegistry = Map<string, Set<Socket>>;

export function registerSocketInRegistry(registry: SocketRegistry, key: string, socket: Socket): void {
  let set = registry.get(key);
  if (!set) {
    set = new Set<Socket>();
    registry.set(key, set);
  }
  set.add(socket);
}

export function collectTargets(registry: SocketRegistry, userId: string, deviceId?: string | null): Socket[] {
  if (deviceId) {
    const set = registry.get(`${userId}:${deviceId}`);
    return set ? [...set] : [];
  }
  const prefix = `${userId}:`;
  const out: Socket[] = [];
  for (const [k, set] of registry) {
    if (k.startsWith(prefix)) out.push(...set);
  }
  return out;
}

export function removeSocketFromRegistry(registry: SocketRegistry, key: string, socket: Socket): void {
  const set = registry.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) registry.delete(key);
}

// Module-level refs so the process can drain cleanly on shutdown (pm2 reload,
// rolling deploys) without leaving half-open sockets or a live Redis sub.
let ioRef: Server | null = null;
let downstreamSubRef: typeof redisClient | null = null;

export function attachWssGateway(httpServer: HttpServer): void {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin || '')) callback(null, true);
        else {
          console.warn(`[WS-Gateway] Blocked by CORS: ${origin}`);
          callback(null, false);
        }
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Local socket registry keyed by `${userId}:${deviceId}` → Set<Socket>.
  // Multi-tab safe: a new connection never evicts an existing one.
  const sockets: SocketRegistry = new Map();
  ioRef = io;

  // --- Auth middleware: cookie-based (HttpOnly `at`), fallback to handshake.auth.token ---
  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const token =
      parseAtCookie(cookieHeader) ||
      (typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined);
    const payload = verifyAuth(token);
    if (!payload) {
      socket.disconnect(true);
      return next(new Error('unauthorized'));
    }
    socket.data.user = payload;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as AuthPayload;
    const userId = user.id;
    const deviceId = user.deviceId || socket.id;
    const key = `${userId}:${deviceId}`;
    registerSocketInRegistry(sockets, key, socket);

    socket.on('disconnect', () => {
      removeSocketFromRegistry(sockets, key, socket);
    });

    // --- Inbound: CHAT_MESSAGE ---
    socket.on('message:send', async (payload: unknown) => {
      if (!await checkRateLimit(userId, 'chat_message', 30, 60)) return;
      if (!await isActiveDeviceAllowed(userId, deviceId)) return;
      // Paritas dengan jalur WT: client menempelkan msgId (UUID) pada payload
      // message:send untuk korelasi ACK. Tanpa ini, callback pendingAcks di
      // transportClient hanya bisa resolve lewat timeout 15s — pesan tetap
      // terkirim, tapi watchdog 20s/UX "FAILED palsu" bisa terpicu.
      const msgId =
        typeof payload === 'object' && payload !== null && 'msgId' in payload
          ? (payload as { msgId?: unknown }).msgId
          : undefined;
      await handleChatMessage(
        wsCtx,
        userId,
        deviceId,
        payload,
        typeof msgId === 'string' ? msgId : undefined
      );
    });

    // --- Inbound: ACK (delivery receipt) ---
    socket.on('message:ack_delivered', async (payload: unknown) => {
      if (!await checkRateLimit(userId, 'message_ack_delivered', 60, 60)) return;
      if (!await isActiveDeviceAllowed(userId, deviceId)) return;
      await handleAck(wsCtx, userId, deviceId, payload as { conversationId: string; messageId: string; targetRecipient?: string });
    });

    // --- Inbound: PRESENCE ---
    socket.on('presence:update', async (payload: unknown) => {
      if (!await checkRateLimit(userId, 'presence_update', 30, 60)) return;
      if (!await isActiveDeviceAllowed(userId, deviceId)) return;
      await handlePresence(wsCtx, userId, payload as { event: string; conversationId?: string });
    });

    // --- Inbound: KEY_SYNC sub-events (rate limits enforced inside handleKeySync) ---
    // [PARITY FIX] Semua event KEY_SYNC diteruskan ke handleKeySync agar fallback
    // WSS setara dengan jalur WebTransport (redisBridge.ts mengirim SEMUA payload
    // KEY_SYNC ke handleKeySync). Sebelumnya hanya 5 event yang didaftarkan —
    // mark_as_read, unsend, view_once_opened, metadata:updated, push:*, burner:*,
    // migration:*, dan session:request_missing jatuh ke pintu kosong di mode WSS.
    //
    // msgId (arg ke-2, opsional) dipakai untuk korelasi ACK pendingAcks di client
    // (paritas dengan jalur WT, di mana msgId ada di dalam payload KEY_SYNC).
    const keySyncHandler =
      (event: string) =>
      async (data: unknown, msgId?: unknown) => {
        if (!await isActiveDeviceAllowed(userId, deviceId)) return;
        await handleKeySync(wsCtx, userId, deviceId, { event, msgId: typeof msgId === 'string' ? msgId : '', data });
      };

    socket.on('session:request_key', keySyncHandler('session:request_key'));
    socket.on('session:fulfill_response', keySyncHandler('session:fulfill_response'));
    socket.on('session:request_missing', keySyncHandler('session:request_missing'));
    socket.on('group:request_key', keySyncHandler('group:request_key'));
    socket.on('group:fulfilled_key', keySyncHandler('group:fulfilled_key'));
    socket.on('messages:distribute_keys', keySyncHandler('messages:distribute_keys'));
    socket.on('message:mark_as_read', keySyncHandler('message:mark_as_read'));
    socket.on('message:mark_read', keySyncHandler('message:mark_read'));
    socket.on('message:unsend', keySyncHandler('message:unsend'));
    socket.on('message:view_once_opened', keySyncHandler('message:view_once_opened'));
    socket.on('metadata:updated', keySyncHandler('metadata:updated'));
    socket.on('push:subscribe', keySyncHandler('push:subscribe'));
    socket.on('push:unsubscribe', keySyncHandler('push:unsubscribe'));
    socket.on('auth:request_linking_qr', keySyncHandler('auth:request_linking_qr'));
    socket.on('burner:join', keySyncHandler('burner:join'));
    socket.on('burner:send', keySyncHandler('burner:send'));
    socket.on('burner:reply', keySyncHandler('burner:reply'));
    socket.on('burner:destroy', keySyncHandler('burner:destroy'));
    socket.on('migration:prepare', keySyncHandler('migration:prepare'));
    socket.on('migration:cancel', keySyncHandler('migration:cancel'));
    socket.on('migration:join', keySyncHandler('migration:join'));
    socket.on('migration:start', keySyncHandler('migration:start'));
    socket.on('migration:chunk', keySyncHandler('migration:chunk'));
    socket.on('migration:ack', keySyncHandler('migration:ack'));
  });

  // --- Outbound: subscribe to nyx:downstream and push to local sockets only ---
  const downstreamSub = redisClient.duplicate();
  downstreamSubRef = downstreamSub;
  downstreamSub
    .connect()
    .then(() => downstreamSub.subscribe('nyx:downstream', (message: string) => {
      try {
        const env = JSON.parse(message) as {
          user_id: string;
          device_id?: string | null;
          op_code: number;
          payload: string;
        };
        const { user_id, device_id, op_code, payload } = env;
        const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as Record<string, unknown>;

        const deliver = (sock: Socket) => {
          switch (op_code) {
            case TransportOpCode.CHAT_MESSAGE:
              sock.emit('message:new', json);
              break;
            case TransportOpCode.PRESENCE:
              sock.emit('presence:update', json);
              break;
            case TransportOpCode.KICK:
              sock.emit('force_logout', json);
              break;
            case TransportOpCode.ACK:
              // sendAck publishes { msgId, data } on opcode 0x06 (no `event`
              // field) — the client resolves pendingAcks from this event.
              sock.emit('message:ack_delivered', json);
              break;
            default:
              // KEY_SYNC and other opcodes carry { event, data } — passthrough.
              sock.emit((json.event as string) ?? 'message:new', json.data);
          }
        };

        const targets = device_id
          ? collectTargets(sockets, user_id, device_id)
          : collectTargets(sockets, user_id);
        for (const sock of targets) deliver(sock);
      } catch (err) {
        console.error('[WS-Gateway] Failed to process downstream message:', err);
      }
    }))
    .catch((err) => console.error('[WS-Gateway] Failed to subscribe to nyx:downstream:', err));

  console.log('🔌 WebSocket fallback gateway attached at /socket.io');
}

/**
 * Graceful shutdown for rolling deploys / pm2 reload: stop consuming
 * `nyx:downstream`, drop every client socket, then close the engine. Safe to
 * call multiple times or when the gateway was never attached.
 */
export async function closeWssGateway(): Promise<void> {
  if (downstreamSubRef) {
    try {
      await downstreamSubRef.unsubscribe('nyx:downstream');
      await downstreamSubRef.quit();
    } catch {
      // Connection may already be gone — nothing to drain.
    }
    downstreamSubRef = null;
  }
  if (ioRef) {
    ioRef.disconnectSockets(true);
    ioRef.close();
    ioRef = null;
    console.log('[WS-Gateway] Closed — all fallback sockets drained.');
  }
}
