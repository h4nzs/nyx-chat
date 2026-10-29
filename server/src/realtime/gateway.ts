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
// [AUDIT 2026-10-24] Gerbang token (blacklist JTI + ban) dipakai bersama REST.
import { evaluateTokenGate, type TokenGateDb } from '../utils/authGate.js';
// [AUDIT 2026-10-24] Satu allowlist origin untuk REST dan WSS.
import { isAllowedOrigin as isOriginAllowed } from '../utils/allowedOrigin.js';
import { env } from '../config.js';
import { TransportOpCode } from '@nyx/shared';
import type { AuthPayload } from '../types/auth.js';
import {
  negotiateWssCapabilities,
  parseAnnouncedCapabilities,
  recordWssCapabilities,
} from '../utils/transportCapability.js';
import { measureWssIngress } from '../utils/transportLatency.js';
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
  handleWebRtcRelay,
  type RealtimeContext,
} from '../network/realtimeHandlers.js';

// [AUDIT 2026-10-24] Allowlist origin dipakai bersama REST
// (`utils/allowedOrigin.ts`) — tidak ada salinan kedua di sini.

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

/**
 * Daftar otoritatif event KEY_SYNC yang diteruskan gateway WSS ke
 * handleKeySync. [PARITY] `handleKeySync` (realtimeHandlers.ts) menangani
 * superset dari daftar ini (mis. event batch `messages:mark_*`, `message:deleted`
 * yang datang dari jalur WT) — gap yang sengaja
 * didokumentasikan di gatewayParity.test.ts. Client WSS mengirim event-event itu
 * melalui jalur tetap lain (ACK di atas), jadi daftar ini adalah "event tambahan
 * yang hilang di WSS" SEBELUM parity fix — uji regresinya agar tidak menyusut.
 *
 * Diekspor agar test bisa membandingkan dengan daftar case `handleKeySync`
 * tanpa perlu mem-parsing source atau mem-bangun server socket.io sungguhan.
 */
export const WSS_KEYS_SYNC_EVENTS = [
  'session:request_key',
  'session:fulfill_response',
  'group:request_key',
  'group:fulfilled_key',
  'messages:distribute_keys',
  'message:mark_as_read',
  'message:mark_read',
  'messages:mark_as_read',
  'messages:mark_read',
  'messages:mark_delivered',
  'message:unsend',
  'message:view_once_opened',
  'metadata:updated',
  'push:subscribe',
  'push:unsubscribe',
  'auth:request_linking_qr',
  'burner:join',
  'burner:send',
  'burner:reply',
  'burner:destroy',
] as const;

/**
 * [D6 2026-10-27] Jalur inbound **tetap** (bukan KEY_SYNC), satu sumber
 * kebenaran registrasi. Sebelumnya daftar ini hanya hidup sebagai empat
 * pemanggilan `guardedOn('…')` literal, sehingga test paritas harus memindai
 * teks sumber untuk membuktikannya — dan refactor yang setara (mis. memindahkan
 * handler ke tabel) memerahkan test tanpa ada perilaku yang berubah.
 */
export const WSS_FIXED_EVENTS = [
  'message:send',
  'message:ack_delivered',
  'presence:update',
  'webrtc:secure_signal',
] as const;

export type WssInboundKind = 'chat' | 'ack' | 'presence' | 'webrtc' | 'keysync';

export interface WssInboundEntry {
  event: string;
  kind: WssInboundKind;
}

/**
 * Tabel registrasi inbound gateway WSS — dipakai `attachWssGateway` **dan** dibaca
 * test sebagai perilaku (bukan regex atas sumber). Setiap event hanya boleh
 * muncul sekali: registrasi ganda berarti handler berjalan dua kali untuk satu
 * payload (ACK dobel, pesan dobel).
 */
export function wssInboundTable(): WssInboundEntry[] {
  return [
    { event: 'message:send', kind: 'chat' },
    { event: 'message:ack_delivered', kind: 'ack' },
    { event: 'presence:update', kind: 'presence' },
    { event: 'webrtc:secure_signal', kind: 'webrtc' },
    ...WSS_KEYS_SYNC_EVENTS.map((event): WssInboundEntry => ({ event, kind: 'keysync' })),
  ];
}

/**
 * Pemetaan envelope `nyx:downstream` → event socket.io + payload yang dikirim.
 *
 * Murni supaya bisa diuji tanpa socket: bug aslinya (WEBRTC_SIGNAL/ICE jatuh ke
 * cabang default lalu dikirim sebagai `message:new`) hanya terlihat dari
 * pemetaan ini, dan test berbasis teks sumber tidak bisa membedakan "cabang ada"
 * dari "cabang benar".
 */
export function wssDownstreamRoute(
  opCode: number,
  json: Record<string, unknown>
): { event: string; payload: unknown } {
  switch (opCode) {
    case TransportOpCode.CHAT_MESSAGE:
      return { event: 'message:new', payload: json };
    case TransportOpCode.PRESENCE:
      return { event: 'presence:update', payload: json };
    case TransportOpCode.KICK:
      return { event: 'force_logout', payload: json };
    case TransportOpCode.ACK:
      // sendAck publishes { msgId, data } on opcode 0x06 (no `event` field) —
      // the client resolves pendingAcks from this event.
      return { event: 'message:ack_delivered', payload: json };
    case TransportOpCode.WEBRTC_SIGNAL:
    case TransportOpCode.WEBRTC_ICE:
      // [PARITY 2026-10-18] Envelope relay = `{ from, type, payload }` (TIDAK
      // punya field `event`), jadi cabang default dulu meng-emit-nya sebagai
      // `message:new` → klien mencoba mem-parse sinyal panggilan sebagai pesan
      // chat dan membuangnya. Sekarang dipetakan ke event yang sama dengan jalur
      // WT (`webrtc:signal` di klien, `transportClient.handleIncomingWss`).
      return { event: 'webrtc:secure_signal', payload: json };
    default:
      // KEY_SYNC and other opcodes carry { event, data } — passthrough.
      return {
        event: typeof json.event === 'string' && json.event.length > 0 ? json.event : 'message:new',
        payload: json.data,
      };
  }
}

/**
 * [D6] Pembungkus handler async socket.io — diekstrak supaya bisa diuji tanpa
 * server socket.io. Rejection yang lepas dari handler (error Redis/DB di
 * checkRateLimit / isActiveDeviceAllowed / handle*) tidak boleh menjadi
 * `unhandledRejection` (node ≥15 membunuh PROSES untuk satu klien yang
 * memicu error infra). Error diteruskan ke `onError`, yang mencatat, membalas
 * callback klien bila ada, lalu memutus koneksi bermasalah itu saja.
 */
export function makeGuardedOn (
  socket: Pick<Socket, 'on' | 'disconnect'>,
  onError: (event: string, err: unknown, maybeCb: unknown) => void
): (event: string, handler: (...args: unknown[]) => Promise<void>) => void {
  return (event, handler) => {
    socket.on(event, (...args: unknown[]) => {
      const maybeCb = args[args.length - 1];
      void (async () => {
        await measureWssIngress(() => handler(...args));
      })().catch((err) => {
        onError(event, err, maybeCb);
      });
    });
  };
}

/**
 * Reaksi standar gateway saat handler gagal: catat, balas callback klien bila
 * ada (supaya UI tidak menggantung sampai timeout), lalu putus koneksi yang
 * bermasalah — hanya itu, bukan seluruh proses.
 */
export function createHandlerFailureReporter (
  socket: Pick<Socket, 'disconnect'>,
  userId: string
): (event: string, err: unknown, maybeCb: unknown) => void {
  return (event, err, maybeCb) => {
    console.error(`[WS-Gateway] Handler ${event} gagal untuk user ${userId}:`, err);
    if (typeof maybeCb === 'function') {
      try {
        (maybeCb as (payload: unknown) => void)({ ok: false, error: 'INTERNAL_ERROR' });
      } catch {
        // klien mungkin sudah pergi
      }
    }
    socket.disconnect(true);
  };
}

export function attachWssGateway(httpServer: HttpServer): void {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin || '', { corsOrigin: env.corsOrigin, isProd: env.nodeEnv === 'production' })) callback(null, true);
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

    // [AUDIT 2026-10-24] Verify tanda tangan saja tidak cukup: token yang sudah
    // di-revoke (`revoked_jti`) atau akun yang sudah di-ban sebelumnya lolos di
    // sini, jadi ban/revokasi hanya memutus koneksi yang sedang hidup (KICK) —
    // klien reconnect dengan cookie `at` yang sama dan diterima lagi sampai
    // tokennya kedaluwarsa. Cek per KONEKSI (bukan per pesan), sama seperti REST.
    void evaluateTokenGate(payload, { redis: redisClient, db: prisma as unknown as TokenGateDb })
      .then((gate) => {
        if (!gate.ok) {
          console.warn(`[WS-Gateway] Koneksi ditolak: ${gate.error}`);
          socket.disconnect(true);
          return next(new Error('unauthorized'));
        }
        socket.data.user = payload;
        // [docs/29 §5.6 / docs/33 §33.7] Kapabilitas klien WSS dibaca dari handshake
        // dan TIDAK pernah menggagalkan koneksi: bentuk cacat = legacy (`[]`).
        // Nilai mentah disimpan apa adanya karena validasi/irisan terjadi di
        // `utils/transportCapability.ts` (satu tempat, bisa diuji tanpa socket).
        socket.data.announcedCapabilities = parseAnnouncedCapabilities(
          socket.handshake.auth?.capabilities
        );
        next();
      })
      .catch((err) => {
        // Gerbang yang error tak terduga tidak boleh meloloskan sesi: tolak.
        console.error('[WS-Gateway] Gagal memeriksa status token:', err);
        socket.disconnect(true);
        next(new Error('unauthorized'));
      });
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as AuthPayload;
    const userId = user.id;
    const deviceId = user.deviceId || socket.id;
    const key = `${userId}:${deviceId}`;
    registerSocketInRegistry(sockets, key, socket);

    // [docs/29 §5.6 · docs/33 §33.7] Balasan kapabilitas jalur WSS — pasangan
    // dari HELLO bidi sidecar. Hanya dikirim bila klien mengiklankan sesuatu:
    // klien lama tidak punya listener untuk event ini (mengirimnya berarti
    // menambah perilaku baru yang tidak diminta ke klien yang sudah rilis).
    //
    // Kenapa ini bukan kosmetik: hasilnya dipakai klien untuk memutuskan versi
    // ratchet (`resolveOutboundRatchetVersion`). Tanpa balasan ini, klien di
    // jalur WSS selalu dianggap legacy → jalur v2 (braid SPQR) tidak pernah
    // dipakai walau kedua peer sudah saling menyatakan mampu in-band.
    const announced = socket.data.announcedCapabilities ?? [];
    if (announced.length > 0) {
      const agreed = negotiateWssCapabilities(announced);
      socket.emit('capabilities', agreed);
      recordWssCapabilities(agreed);
    }

    socket.on('disconnect', () => {
      removeSocketFromRegistry(sockets, key, socket);
    });

    // [ROBUSTNESS] Pembungkus handler async socket.io: rejection yang lepas
    // dari handler (error Redis/DB di checkRateLimit / isActiveDeviceAllowed /
    // handle*) tidak lagi menjadi unhandledRejection → node ≥15 membunuh
    // PROSES untuk satu klien yang men-trigger error infra. Error di-log +
    // koneksi klien bermasalah diputus — sisanya user & instance tetap hidup.
    // [docs/10 §10.12] Setiap event masuk diukur durasinya
    // (`nyx_wss_ingress_seconds`) — pembanding jalur cepat
    // (`nyx_transport_ingress_seconds` di sidecar). Tanpa angka ini, "jalur
    // WebTransport melambat" hanya bisa dibandingkan dengan ambang mutlak yang
    // berbeda-beda per host; dengan keduanya, pertanyaannya jadi faktual:
    // apakah jalur cepat masih lebih cepat daripada jalur cadangannya?
    const guardedOn = makeGuardedOn(socket, createHandlerFailureReporter(socket, userId));

    // --- Inbound: CHAT_MESSAGE ---
    // [PARITY 2026-10-18] Rate limit TIDAK lagi di sini: bucket `chat_message`
    // (dan `message_ack_delivered` / `presence_update`) hidup di
    // `realtimeHandlers` supaya klien WebTransport — yang tidak pernah lewat
    // gateway ini — mendapat batas yang sama. Memasangnya di dua tempat akan
    // menghitung ganda bucket yang sama (limit efektif jadi separuh).
    const chatHandler = async (payload: unknown) => {
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
    };

    // --- Inbound: ACK (delivery receipt) --- (limit ada di handleAck)
    const ackHandler = async (payload: unknown) => {
      if (!await isActiveDeviceAllowed(userId, deviceId)) return;
      await handleAck(wsCtx, userId, deviceId, payload as { conversationId: string; messageId: string; targetRecipient?: string });
    };

    // --- Inbound: PRESENCE --- (limit ada di handlePresence)
    const presenceHandler = async (payload: unknown) => {
      if (!await isActiveDeviceAllowed(userId, deviceId)) return;
      await handlePresence(wsCtx, userId, payload as { event: string; conversationId?: string });
    };

    // --- Inbound: WEBRTC signaling (paritas dengan opcode 0x03/0x04 jalur WT) ---
    // [PARITY 2026-10-18] Sebelumnya event ini tidak terdaftar sama sekali di
    // gateway, sedangkan klien WT mengirimnya sebagai opcode WEBRTC_SIGNAL/ICE —
    // jadi di jaringan yang memblokir QUIC (justru alasan fallback ada) sinyal
    // panggilan keluar hilang tanpa jejak. Payload = `{ to, type, payload }`
    // dengan `to` adalah TOKEN relay buram (bukan userId); validasi token +
    // keputusan drop fail-closed ada di `handleWebRtcRelay`.
    const webRtcHandler = async (payload: unknown) => {
      if (!await isActiveDeviceAllowed(userId, deviceId)) return;
      await handleWebRtcRelay(
        wsCtx,
        userId,
        deviceId,
        (payload ?? {}) as { to?: string; type?: string; payload?: string },
        TransportOpCode.WEBRTC_SIGNAL
      );
    };

    // --- Inbound: KEY_SYNC sub-events (rate limits enforced inside handleKeySync) ---
    // [PARITY FIX] Semua event KEY_SYNC diteruskan ke handleKeySync agar fallback
    // WSS setara dengan jalur WebTransport (redisBridge.ts mengirim SEMUA payload
    // KEY_SYNC ke handleKeySync). Sebelumnya hanya 5 event yang didaftarkan —
    // mark_as_read, unsend, view_once_opened, metadata:updated, push:*, burner:*,
    // dan session:request_missing jatuh ke pintu kosong di mode WSS.
    //
    // msgId (arg ke-2, opsional) dipakai untuk korelasi ACK pendingAcks di client
    // (paritas dengan jalur WT, di mana msgId ada di dalam payload KEY_SYNC).
    const keySyncHandler =
      (event: string) =>
      async (data: unknown, msgId?: unknown) => {
        if (!await isActiveDeviceAllowed(userId, deviceId)) return;
        await handleKeySync(wsCtx, userId, deviceId, { event, msgId: typeof msgId === 'string' ? msgId : '', data });
      };

    // [ROBUSTNESS] Semua event lewat guard yang sama — satu loop atas
    // `wssInboundTable()`, satu sumber kebenaran untuk nama event + jenis
    // dispatch. Nama event socket.io === nama `event` di payload handleKeySync,
    // dan msgId (arg ke-2, opsional dari client) diteruskan untuk korelasi ACK.
    // Tabel diuji sebagai perilaku (gatewayParity.test.ts), bukan sebagai teks.
    for (const entry of wssInboundTable()) {
      switch (entry.kind) {
        case 'chat':
          guardedOn(entry.event, chatHandler);
          break;
        case 'ack':
          guardedOn(entry.event, ackHandler);
          break;
        case 'presence':
          guardedOn(entry.event, presenceHandler);
          break;
        case 'webrtc':
          guardedOn(entry.event, webRtcHandler);
          break;
        case 'keysync':
          guardedOn(entry.event, keySyncHandler(entry.event));
          break;
      }
    }
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

        // Pemetaan opcode → event + payload hidup di `wssDownstreamRoute()`
        // (murni, diuji perilaku). Loop ini hanya mengirim hasilnya.
        const deliver = (sock: Socket) => {
          const route = wssDownstreamRoute(op_code, json);
          sock.emit(route.event, route.payload);
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
