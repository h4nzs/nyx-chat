import { EventEmitter } from 'eventemitter3';
import { TransportOpCode } from '@nyx/shared';
import type { MainToTransportWorker, TransportWorkerToMain, BinaryPayload } from '@nyx/shared';
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
  private pendingAcks = new Map<string, { resolve: (val: unknown) => void, reject: (err: unknown) => void, timeoutId: ReturnType<typeof setTimeout> }>();

  private offlineQueue: MainToTransportWorker[] = [];

  constructor() {
    super();
    this.worker = new Worker(new URL('../workers/transport.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handleWorkerMessage.bind(this);
    
    // [+] FLUSH ANTRIAN SAAT KONEK
    this.on('connect', () => {
      while (this.offlineQueue.length > 0) {
        const msg = this.offlineQueue.shift();
        if (msg) {
           const transferables = ('payload' in msg && msg.payload instanceof Uint8Array) ? [msg.payload.buffer] : [];
           this.worker.postMessage(msg, transferables);
        }
      }
    });
  }

  public async connect(url: string, token: string, certificateHash?: string): Promise<void> {
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
  }

  public disconnect(): void {
    this.worker.postMessage({ type: 'DISCONNECT' } satisfies MainToTransportWorker);
  }

  private handleWorkerMessage(event: MessageEvent<TransportWorkerToMain>): void {
    const data = event.data;
    switch (data.type) {
      case 'CONNECTED':
        this.connected = true;
        this.emit('connect');
        break;
      case 'DISCONNECTED':
        this.connected = false;
        this.emit('disconnect', data.reason);
        break;
      case 'ERROR':
        console.error("Transport Worker Error:", data.error);
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
           const json = JSON.parse(new TextDecoder().decode(payload));
           // [+] AMBIL DARI OBJECT USER
           const userJson = localStorage.getItem('user');
           const currentDeviceId = userJson ? JSON.parse(userJson).deviceId : localStorage.getItem('deviceId');
           
           if (json.reason === 'Account deleted' || json.deviceId === currentDeviceId) {
               this.emit('auth:banned', json);
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
       const json = JSON.parse(new TextDecoder().decode(payload));
       if (json && json.msgId && this.pendingAcks.has(json.msgId)) {
          const p = this.pendingAcks.get(json.msgId)!;
          clearTimeout(p.timeoutId);
          p.resolve(json.data);
          this.pendingAcks.delete(json.msgId);
       }
     } catch (e) {}
  }

  public sendStream(opCode: TransportOpCode, payload: BinaryPayload): void {
    const message: MainToTransportWorker = { type: 'SEND_STREAM', opCode, payload };
    // [+] CEK KONEKSI
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public sendDatagram(opCode: TransportOpCode, payload: BinaryPayload): void {
    const message: MainToTransportWorker = { type: 'SEND_DATAGRAM', opCode, payload };
    // [+] CEK KONEKSI
    if (!this.connected) {
      this.offlineQueue.push(message);
    } else {
      this.worker.postMessage(message, [payload.buffer]);
    }
  }

  public startHandshake(payload: BinaryPayload): void {
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
    const msgId = Math.random().toString(36).substring(7);
    
    if (callback) {
       this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(err, null),
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
        const msgId = Math.random().toString(36).substring(7);
        this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(new Error('timeout'), null),
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

export function emitGroupKeyFulfillment(payload: { requesterId: string; conversationId: string; encryptedKey: string; targetDeviceId?: string; senderDeviceKey?: string; }) {
  transportClient.sendEvent('group:fulfilled_key', payload);
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
