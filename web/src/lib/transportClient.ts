import { EventEmitter } from 'eventemitter3';
import { io, type Socket } from 'socket.io-client';
import { TransportOpCode } from '@nyx/shared';
import type { MainToTransportWorker, TransportWorkerToMain, BinaryPayload } from '@nyx/shared';
import { decideTransportMode, OUTGOING_OPCODE_MAP } from './transportMode';
import { useAuthStore } from '../store/auth';

import type { 
  RawServerMessage, 
  Message, 
  Participant, 
  User, 
  Conversation,
  ConversationId,
  UserId
} from '@nyx/shared';

type TransportEvents = {
  // Connection
  'connect': [];
  'disconnect': [reason: string];
  
  // Messages
  'message:new': [payload: BinaryPayload];
  'message:updated': [data: Partial<RawServerMessage> & { id: string, conversationId: string }];
  'message:deleted': [data: { conversationId: string; id: string }];
  'message:status_updated': [data: { conversationId: string; messageId: string; userId: string; status: string }];
  
  // Conversations
  'conversation:new': [conversation: Conversation];
  'conversation:updated': [data: Partial<Conversation> & { id: string }];
  'conversation:deleted': [data: { id: string }];
  'conversation:participants_added': [data: { conversationId: string; participants: Participant[] }];
  'conversation:participant_removed': [data: { conversationId: string; userId: string }];
  'conversation:participant_updated': [data: { conversationId: string; userId: string; role: 'ADMIN' | 'MEMBER' | 'admin' | 'member' }];
  
  // Users
  'user:updated': [user: Partial<User>];
  
  // Presence & RTC
  'presence:update': [payload: BinaryPayload];
  'webrtc:signal': [payload: BinaryPayload];
  
  // Auth & Security
  'force_logout': [data: { jti: string }];
  'auth:banned': [data: { reason: string }];
  
  // Key Management
  'session:request_key_fulfillment': [data: unknown];
  'session:new_key': [data: { conversationId: string; sessionId?: string; encryptedKey: string; type?: 'GROUP_KEY' | 'SESSION_KEY'; senderId?: string; senderDeviceKey?: string }];
  'session:fulfill_request': [data: { conversationId: string; sessionId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string }];
  'group:fulfill_key_request': [data: { conversationId: string; requesterId: string; requesterPublicKey: string; requesterPqPublicKey: string; requesterDeviceId?: string }];
  'group:key_request_failed': [data: { conversationId: string; reason: string }];
  'session:request_key_failed': [data: { sessionId: string; targetId: string; reason: string }];
  'handshake:completed': [success: boolean, error?: string];
  
  // Burner Chats
  'burner:receive': [payload: { roomId?: string, ciphertext: string }];
  'burner:terminated': [payload: { roomId: string }];

  // Migration
  'migration:start': [payload: { roomId: string; totalChunks: number; sealedKey: string; }];
  'migration:chunk': [payload: { chunkIndex: number; chunk: string; }];
  'migration:ack': [payload: { roomId: string, success: boolean }];

  // Allow arbitrary events for backward compatibility
  [event: string]: unknown[];
};

export class NyxWebTransportClient extends EventEmitter<TransportEvents> {
  private worker: Worker;
  public connected: boolean = false;
  private pendingAcks = new Map<string, { resolve: (val: unknown) => void, reject: (err: unknown) => void, startedAt: number, timeoutId: ReturnType<typeof setTimeout> }>();

  private offlineQueue: MainToTransportWorker[] = [];

  // --- WebSocket fallback (state machine) ---
  // mode 'wt' adalah default; beralih ke 'wss' (sticky untuk sesi) jika WT
  // gagal berturut-turut mencapai ambang batas.
  private mode: 'wt' | 'wss' = 'wt';
  private wtFailCount = 0;
  private readonly WT_MAX_FAILS = 2;
  private readonly WT_TIMEOUT_MS = 8000;
  private wtConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wtConnecting = false;
  private lastConnectParams: { url: string; token: string; certificateHash?: string } = { url: '', token: '' };
  private socket: Socket | null = null;
  private wssOfflineQueue: { opCode: TransportOpCode; payload: BinaryPayload }[] = [];
  private silentNoopOpcodes = new Set<TransportOpCode>();

  constructor() {
    super();
    this.worker = new Worker(new URL('../workers/transport.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handleWorkerMessage.bind(this);
    
    // [+] FLUSH ANTRIAN SAAT KONEK
    this.on('connect', () => {
      if (this.mode === 'wss') {
        while (this.wssOfflineQueue.length > 0) {
          const m = this.wssOfflineQueue.shift();
          if (m) this.routeOutgoingWss(m.opCode, m.payload);
        }
      } else {
        while (this.offlineQueue.length > 0) {
          const msg = this.offlineQueue.shift();
          if (msg) {
             const transferables = ('payload' in msg && msg.payload instanceof Uint8Array) ? [msg.payload.buffer] : [];
             this.worker.postMessage(msg, transferables);
          }
        }
      }
    });
  }

  public async connect(url: string, token: string, certificateHash?: string): Promise<void> {
    if (this.mode === 'wss') {
      this.connectWss();
      return;
    }
    await this.connectWt(url, token, certificateHash);
  }

  /**
   * WebTransport (primary) connect path. Mirrors the original behavior exactly,
   * plus a per-attempt timeout so a blocked UDP/QUIC network fails fast and
   * triggers the WebSocket fallback.
   */
  private async connectWt(url: string, token: string, certificateHash?: string): Promise<void> {
    this.lastConnectParams = { url, token, certificateHash };
    const rawUrl = url || import.meta.env.VITE_TRANSPORT_URL || import.meta.env.VITE_API_URL?.replace('http', 'https') || 'https://api.nyx-app.my.id/transport';
    
    // 1. Get Temporary Transport Ticket for better browser compatibility (Brave/Safari fallback)
    let finalUrlWithTicket = rawUrl;
    try {
      const { api } = await import('./api');
      const { ticket } = await api<{ ticket: string }>('/api/auth/transport-ticket');
      
      const urlObj = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      urlObj.searchParams.set('ticket', ticket);
      finalUrlWithTicket = urlObj.toString();
    } catch (e) {
      console.warn("[Transport] Could not fetch connection ticket, falling back to pure Token Auth:", e);
    }

    // Ensure URL has https:// scheme as required by WebTransport
    let finalUrl = finalUrlWithTicket;
    if (!finalUrl.startsWith('https://') && !finalUrl.startsWith('http://')) {
       finalUrl = 'https://' + finalUrl;
    } else if (finalUrl.startsWith('http://')) {
       finalUrl = finalUrl.replace('http://', 'https://');
    }

    const hash = certificateHash || (import.meta.env.PROD ? undefined : import.meta.env.VITE_TRANSPORT_CERT_HASH);
    
    // 2. Get Device Identity for Hardware Binding (Lapis 2 Security)
    let deviceIdentity: string | undefined = undefined;
    try {
      const { getFullDeviceIdentity } = await import('../utils/fingerprint');
      const identity = await getFullDeviceIdentity();
      deviceIdentity = JSON.stringify(identity);
    } catch (e) {
      console.warn("[Transport] Could not generate device identity:", e);
    }

    this.worker.postMessage({ type: 'CONNECT', url: finalUrl, token, certificateHash: hash, deviceIdentity } satisfies MainToTransportWorker);

    // [+] TIMEOUT: jika WT tidak CONNECT dalam WT_TIMEOUT_MS, anggap gagal.
    this.wtConnecting = true;
    this.clearWtTimer();
    this.wtConnectTimer = setTimeout(() => {
      this.handleWtFailure();
    }, this.WT_TIMEOUT_MS);
  }

  /**
   * WebSocket (socket.io) fallback connect path. Establishes the socket.io
   * connection against the same API origin and re-emits the SAME TransportEvents
   * so everything upstream (socketListeners) is unchanged.
   */
  private connectWss(): void {
    // Pindahkan SEMUA pesan yang mengantri di worker WT ke antrean WSS SEBELUM
    // guard early-return, agar tidak ada pesan user yang terbuang saat transisi
    // mode (termasuk saat connectWss dipanggil ulang dengan socket yang sudah ada).
    this.drainWtQueueToWss();

    if (this.socket) return; // sudah terkoneksi / sedang menyambung

    const origin = this.resolveApiOrigin();
    // Transports dapat dikunci via env (mis. VITE_WSS_TRANSPORTS=websocket)
    // saat berjalan di belakang LB tanpa sticky-session: koneksi websocket
    // murni adalah satu stream TCP yang bisa dirutekan ke replika mana pun,
    // sedangkan polling fallback butuh affinity antar-replika.
    const rawTransports = String(
      import.meta.env.VITE_WSS_TRANSPORTS ?? 'websocket,polling'
    )
      .split(',')
      .map((t) => t.trim())
      .filter((t): t is 'websocket' | 'polling' => t === 'websocket' || t === 'polling');
    const socket = io(origin, {
      withCredentials: true,
      transports: rawTransports.length > 0 ? rawTransports : ['websocket', 'polling'],
      path: '/socket.io',
      reconnection: true,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      this.emit('connect');
    });

    socket.on('disconnect', (reason: string) => {
      this.connected = false;
      this.emit('disconnect', reason);
    });

    // Tangkap semua event masuk dan teruskan ke TransportEvents.
    socket.onAny((eventName: string, ...args: any[]) => {
      if (eventName === 'connect' || eventName === 'disconnect') return;
      this.handleIncomingWss(eventName, args[0]);
    });
  }

  public disconnect(): void {
    this.clearWtTimer();
    this.wtConnecting = false;
    if (this.mode === 'wss' && this.socket) {
      this.socket.disconnect();
      this.socket = null;
      return;
    }
    this.worker.postMessage({ type: 'DISCONNECT' } satisfies MainToTransportWorker);
  }

  private handleWorkerMessage(event: MessageEvent<TransportWorkerToMain>): void {
    const data = event.data;
    switch (data.type) {
      case 'CONNECTED':
        this.clearWtTimer();
        this.wtConnecting = false;
        this.wtFailCount = 0;
        this.connected = true;
        this.emit('connect');
        break;
      case 'DISCONNECTED':
        this.connected = false;
        this.emit('disconnect', data.reason);
        // Jika terputus saat masih dalam upaya konek WT, hitung sebagai kegagalan.
        if (this.mode === 'wt' && this.wtConnecting) {
          this.handleWtFailure();
        }
        break;
      case 'ERROR':
        console.error("Transport Worker Error:", data.error);
        // Hitung sebagai kegagalan WT hanya saat sedang mencoba menyambung.
        if (this.mode === 'wt' && this.wtConnecting) {
          this.handleWtFailure();
        }
        break;
      case 'DATA_RECEIVED':
        this.routeOpCode(data.opCode, data.payload);
        break;
      case 'HANDSHAKE_COMPLETED':
        this.emit('handshake:completed', data.success, data.error);
        break;
    }
  }

  private routeOpCode(opCode: TransportOpCode, payload: BinaryPayload): void {
    switch (opCode) {
      case TransportOpCode.CHAT_MESSAGE:
        this.emit('message:new', payload);
        break;
      case TransportOpCode.WEBRTC_SIGNAL:
      case TransportOpCode.WEBRTC_ICE:
        this.emit('webrtc:signal', payload);
        break;
      case TransportOpCode.PRESENCE:
        this.emit('presence:update', payload);
        break;
      case TransportOpCode.ACK:
        this.handleAck(payload);
        break;
      case TransportOpCode.KICK:
        try {
           const parsedJson = JSON.parse(new TextDecoder().decode(payload)) as unknown;
           const json = typeof parsedJson === 'object' && parsedJson !== null ? parsedJson as Record<string, unknown> : {};
           // [+] AMBIL DARI OBJECT USER
           const userJson = localStorage.getItem('user');
           const parsedUser = userJson ? (JSON.parse(userJson) as unknown) : null;
           const currentDeviceId = (typeof parsedUser === 'object' && parsedUser !== null && 'deviceId' in parsedUser) ? (parsedUser as Record<string, unknown>).deviceId : localStorage.getItem('deviceId');
           
           if (json.reason === 'Account deleted' || json.deviceId === currentDeviceId) {
               this.emit('auth:banned', { reason: typeof json.reason === 'string' ? json.reason : 'Unknown reason' });
               this.disconnect();
           } else {
               console.log("Ignored kick for different device ID:", json.deviceId);
           }
        } catch (e) {
           this.emit('auth:banned', { reason: 'Kicked by server' });
           this.disconnect();
        }
        break;
      default:
        // Handle generic events
        try {
           const json = JSON.parse(new TextDecoder().decode(payload));
           if (json && json.event) {
              this.emit(json.event, json.data);
           }
        } catch (e) {}
        break;
    }
  }

  private handleAck(payload: BinaryPayload) {
     try {
       const parsedJson = JSON.parse(new TextDecoder().decode(payload)) as unknown;
       const json = typeof parsedJson === 'object' && parsedJson !== null ? parsedJson as Record<string, unknown> : null;
       if (json && json.msgId && typeof json.msgId === 'string' && this.pendingAcks.has(json.msgId)) {
          const p = this.pendingAcks.get(json.msgId)!;
          clearTimeout(p.timeoutId);
          if (import.meta.env.DEV) {
            const duration = performance.now() - p.startedAt;
            console.debug(`[perf:transport] ack ${json.msgId}: ${duration.toFixed(1)}ms`);
          }
          p.resolve(json.data);
          this.pendingAcks.delete(json.msgId);
       }
     } catch (e) {}
  }

  // --- WebSocket fallback helpers ---

  private clearWtTimer(): void {
    if (this.wtConnectTimer !== null) {
      clearTimeout(this.wtConnectTimer);
      this.wtConnectTimer = null;
    }
  }

  /**
   * Dipanggil ketika upaya konek WT gagal (timeout / ERROR / DISCONNECTED
   * saat menyambung). Menggunakan decideTransportMode untuk menentukan:
   * coba ulang WT, atau beralih ke WebSocket (sticky untuk sesi).
   */
  private handleWtFailure(): void {
    this.clearWtTimer();
    this.wtConnecting = false;
    this.wtFailCount += 1;

    const decision = decideTransportMode({
      currentMode: this.mode,
      wtFailCount: this.wtFailCount,
      wtMaxFails: this.WT_MAX_FAILS,
    });

    if (decision.shouldSwitchToWss) {
      console.info(`[Transport] WebTransport gagal ${this.wtFailCount}x berturut-turut, beralih ke WebSocket fallback.`);
      this.mode = 'wss';
      this.connectWss();
    } else if (decision.shouldRetryWt) {
      console.info(`[Transport] Percobaan WebTransport ke-${this.wtFailCount} gagal, mencoba ulang...`);
      void this.connectWt(this.lastConnectParams.url, this.lastConnectParams.token, this.lastConnectParams.certificateHash);
    }
  }

  private resolveApiOrigin(): string {
    const envUrl = (import.meta.env.VITE_API_URL as string | undefined) || '';
    const cleaned = envUrl.replace(/\/api\/?$/, '').replace(/\/$/, '');
    return cleaned || 'https://api.nyx-app.my.id';
  }

  private drainWtQueueToWss(): void {
    while (this.offlineQueue.length > 0) {
      const msg = this.offlineQueue.shift();
      if (!msg || !('payload' in msg) || !(msg.payload instanceof Uint8Array)) continue;
      if (msg.type === 'SEND_STREAM' || msg.type === 'SEND_DATAGRAM') {
        this.wssOfflineQueue.push({ opCode: msg.opCode, payload: msg.payload });
      }
      // START_HANDSHAKE (PQ handshake) adalah fitur WT-only; bukan pesan user dan
      // akan dibangun ulang saat sesi WT berikutnya, jadi sengaja dibuang saat
      // transisi WT→WSS.
    }
  }

  /**
   * Map event socket.io server -> TransportEvents (byte-equivalent dengan WT).
   *
   * Gateway server meng-emit:
   *   'message:new'     -> CHAT_MESSAGE  (di-re-encode ke Uint8Array, sama spt WT)
   *   'presence:update' -> PRESENCE      (di-re-encode ke Uint8Array, sama spt WT)
   *   'message:ack_delivered' -> ACK     (konfirmasi terkirim, resolve pendingAcks)
   *   'force_logout'    -> force_logout  (passthrough json.data)
   *   <json.event>      -> passthrough   (message:updated, conversation:*,
   *                                       user:updated, session:*, group:*,
   *                                       burner:*, migration:*, dll.)
   */
  private handleIncomingWss(eventName: string, data: unknown): void {
    if (eventName === 'message:new') {
      this.routeOpCode(TransportOpCode.CHAT_MESSAGE, this.encodeJson(data));
    } else if (eventName === 'presence:update') {
      this.routeOpCode(TransportOpCode.PRESENCE, this.encodeJson(data));
    } else if (eventName === 'message:ack_delivered') {
      // Opcode ACK server (konfirmasi pesan terkirim) -> resolve pendingAcks.
      this.handleAck(this.encodeJson(data));
    } else {
      // Passthrough: mencerminkan default branch routeOpCode (this.emit(json.event, json.data)).
      this.emit(eventName, data);
    }
  }

  private encodeJson(data: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(data ?? null));
  }

  private decodeJson(payload: BinaryPayload): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
  }

  /**
   * Terjemahkan {opCode, payload} keluar ke event socket.io sesuai tabel
   * OUTGOING_OPCODE_MAP. Payload keluar adalah JSON (sudah diserialisasi oleh
   * bridge/sidecar), jadi kita decode lalu emit objek aslinya.
   */
  private routeOutgoingWss(opCode: TransportOpCode, payload: BinaryPayload): void {
    if (!this.socket) return;
    const mapping = OUTGOING_OPCODE_MAP[opCode];
    switch (mapping.kind) {
      case 'fixed':
        this.socket.emit(mapping.event, this.decodeJson(payload));
        break;
      case 'derived': {
        const json = this.decodeJson(payload) as { event?: string; data?: unknown; msgId?: string } | null;
        if (json && typeof json.event === 'string') {
          // Paritas ACK dengan jalur WT: msgId diteruskan sebagai arg ke-2 agar
          // gateway WSS bisa mengirim ACK yang meng-resolve pendingAcks (dipakai
          // mis. emitGroupKeyDistribution dengan callback).
          this.socket.emit(json.event, json.data, typeof json.msgId === 'string' ? json.msgId : undefined);
        }
        break;
      }
      case 'noop':
        if (!this.silentNoopOpcodes.has(opCode)) {
          this.silentNoopOpcodes.add(opCode);
          console.info(`[Transport] WebSocket fallback: opCode 0x${opCode.toString(16)} tidak didukung, diabaikan.`);
        }
        break;
    }
  }

  public sendStream(opCode: TransportOpCode, payload: BinaryPayload): void {
    if (this.mode === 'wss') {
      if (!this.connected || !this.socket) {
        this.wssOfflineQueue.push({ opCode, payload });
      } else {
        this.routeOutgoingWss(opCode, payload);
      }
      return;
    }
    const message: MainToTransportWorker = { type: 'SEND_STREAM', opCode, payload };
    // [+] CEK KONEKSI
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public sendDatagram(opCode: TransportOpCode, payload: BinaryPayload): void {
    if (this.mode === 'wss') {
      if (!this.connected || !this.socket) {
        this.wssOfflineQueue.push({ opCode, payload });
      } else {
        this.routeOutgoingWss(opCode, payload);
      }
      return;
    }
    const message: MainToTransportWorker = { type: 'SEND_DATAGRAM', opCode, payload };
    // [+] CEK KONEKSI
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public startHandshake(payload: BinaryPayload): void {
    if (this.mode === 'wss') {
      // PQ handshake adalah fitur WT; tidak didukung di fallback WebSocket.
      return;
    }
    const message: MainToTransportWorker = { type: 'START_HANDSHAKE', payload };
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public sendJsonStream(opCode: TransportOpCode, payload: unknown): void {
    const buffer = new TextEncoder().encode(JSON.stringify(payload));
    this.sendStream(opCode, buffer);
  }

  public sendJsonDatagram(opCode: TransportOpCode, payload: unknown): void {
    const buffer = new TextEncoder().encode(JSON.stringify(payload));
    this.sendDatagram(opCode, buffer);
  }
  
  private routeAndSend(event: string, data: unknown, msgId?: string): void {
    if (event === 'message:send') {
        this.sendJsonStream(TransportOpCode.CHAT_MESSAGE, { ...(data as Record<string, unknown> || {}), msgId });
        } else if (event.startsWith('user:') || event.startsWith('typing:')) {
        this.sendJsonStream(TransportOpCode.PRESENCE, { event, ...(data as Record<string, unknown> || {}) });
    } else {
        this.sendJsonStream(TransportOpCode.KEY_SYNC, { event, msgId, data });
    }
  }

  public sendEvent(event: string, data?: unknown, callback?: Function): void {
    const msgId = crypto.randomUUID();
    
    if (callback) {
       this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(err, null),
          startedAt: performance.now(),
          timeoutId: setTimeout(() => {
             this.pendingAcks.delete(msgId);
             callback(new Error('timeout'), null);
          }, 30000)
       });
    }
    
    this.routeAndSend(event, data, msgId);
  }

  public timeout(ms: number) {
    return {
      emit: (event: string, data: unknown, callback: Function) => {
        const msgId = crypto.randomUUID();
        this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(new Error('timeout'), null),
          startedAt: performance.now(),
          timeoutId: setTimeout(() => {
             this.pendingAcks.delete(msgId);
             callback(new Error('timeout'), null);
          }, ms)
        });
        this.routeAndSend(event, data, msgId);
      }
    };
  }
}

export const transportClient = new NyxWebTransportClient();

export function connectSocket() {
  if (transportClient.connected) return;
  const token = useAuthStore.getState().accessToken || '';
  const certHash = import.meta.env.PROD ? undefined : import.meta.env.VITE_TRANSPORT_CERT_HASH;
  transportClient.connect('', token, certHash);
}

export function disconnectSocket() {
  if (transportClient.connected) {
    transportClient.disconnect();
  }
}

export function emitSessionKeyRequest(conversationId: string, sessionId: string, targetId?: string) {
  const meId = useAuthStore.getState().user?.id;
  transportClient.sendEvent('session:request_key', { 
      conversationId, 
      sessionId, 
      targetId,
      requesterId: meId
  });
}

export function emitSessionKeyFulfillment(payload: { requesterId: string; conversationId: string; sessionId: string; encryptedKey: string; }) {
  transportClient.sendEvent('session:fulfill_response', payload);
}

export function emitGroupKeyDistribution(conversationId: string, keys: { userId: string; key: string, targetDeviceId?: string, targetDeviceKey?: string, senderDeviceKey?: string }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!transportClient.connected) return reject(new Error('Socket not connected'));
    transportClient.sendEvent('messages:distribute_keys', { conversationId, keys }, (err: unknown, res?: { ok: boolean }) => {
      if (err || !res?.ok) return reject(new Error('Failed to distribute keys'));
      resolve();
    });
  });
}

export async function emitGroupKeyRequest(conversationId: string, targetSenderId?: string, targetDeviceKey?: string) {
  const { useAuthStore } = await import('../store/auth');
  const state = useAuthStore.getState();
  const myId = state.user?.id;
  
  const { getEncryptionKeyPair } = state;
  const { publicKey } = await getEncryptionKeyPair();
  const { getSodiumLib } = await import('../utils/crypto');
  const sodium = await getSodiumLib();
  const myPublicKeyB64 = sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  
  transportClient.sendEvent('group:request_key', { 
      conversationId, 
      targetSenderId, 
      targetDeviceKey,
      requesterId: myId,
      requesterDeviceId: myPublicKeyB64,
      requesterPublicKey: myPublicKeyB64
  });
}

export function emitGroupKeyFulfillment(payload: { requesterId: string; conversationId: string; encryptedKey: string; targetDeviceId?: string; senderDeviceKey?: string; drHeader?: any; }) {
  transportClient.sendEvent('group:fulfilled_key', payload);
}

export function emitMetadataUpdated(conversationId: string, encryptedMetadata: string, targetRecipients: string[]): void {
  transportClient.sendEvent('metadata:updated', { conversationId, encryptedMetadata, targetRecipients });
}

export const fireGhostSync = (conversationId: string, baseDelay: number = 1000) => {
    const randomDelay = Math.floor(Math.random() * 2500) + baseDelay;
    setTimeout(async () => {
        try {
            const messageStore = (await import('../store/message')).useMessageStore.getState();
            await messageStore.sendMessage(conversationId, {
                content: JSON.stringify({ type: 'GHOST_SYNC', ts: Date.now() }),
                isSilent: true
            });
            console.log(`[Ghost Sync] Fired for group ${conversationId}`);
        } catch (e) {
            console.error('[Ghost Sync] Failed to send', e);
        }
    }, randomDelay);
};
