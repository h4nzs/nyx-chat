import { EventEmitter } from 'eventemitter3';
import { TransportOpCode } from '@nyx/shared';
import type { MainToTransportWorker, TransportWorkerToMain, BinaryPayload } from '@nyx/shared';
import { useAuthStore } from '../store/auth';

type TransportEvents = {
  'connect': [];
  'disconnect': [reason: string];
  'message:new': [payload: BinaryPayload];
  'webrtc:signal': [payload: BinaryPayload];
  'presence:update': [payload: BinaryPayload];
  // Allow arbitrary events for backward compatibility
  [event: string]: any[];
};

export class NyxWebTransportClient extends EventEmitter<TransportEvents> {
  private worker: Worker;
  public connected: boolean = false;
  private pendingAcks = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void, timeoutId: any }>();

  constructor() {
    super();
    this.worker = new Worker(new URL('../workers/transport.worker.ts', import.meta.url), {
      type: 'module'
    });

    this.worker.onmessage = this.handleWorkerMessage.bind(this);
  }

  public connect(url: string, token: string, certificateHash?: string): void {
    const defaultUrl = import.meta.env.VITE_TRANSPORT_URL || import.meta.env.VITE_API_URL?.replace('http', 'https') || 'https://api.nyx-app.my.id/transport';
    const hash = certificateHash || import.meta.env.VITE_TRANSPORT_CERT_HASH;
    this.worker.postMessage({ type: 'CONNECT', url: url || defaultUrl, token, certificateHash: hash } satisfies MainToTransportWorker);
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
    this.worker.postMessage(message, [payload.buffer]);
  }

  public sendDatagram(opCode: TransportOpCode, payload: BinaryPayload): void {
    const message: MainToTransportWorker = { type: 'SEND_DATAGRAM', opCode, payload };
    this.worker.postMessage(message, [payload.buffer]);
  }

  public sendJsonStream(opCode: TransportOpCode, payload: any): void {
    const buffer = new TextEncoder().encode(JSON.stringify(payload));
    this.sendStream(opCode, buffer);
  }

  public sendJsonDatagram(opCode: TransportOpCode, payload: any): void {
    const buffer = new TextEncoder().encode(JSON.stringify(payload));
    this.sendDatagram(opCode, buffer);
  }
  
  public sendEvent(event: string, data?: any, callback?: Function): void {
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
    
    this.sendJsonStream(TransportOpCode.KEY_SYNC, { event, msgId, data });
  }

  public timeout(ms: number) {
    return {
      emit: (event: string, data: any, callback: Function) => {
        const msgId = Math.random().toString(36).substring(7);
        this.pendingAcks.set(msgId, {
          resolve: (val) => callback(null, val),
          reject: (err) => callback(new Error('timeout'), null),
          timeoutId: setTimeout(() => {
             this.pendingAcks.delete(msgId);
             callback(new Error('timeout'), null);
          }, ms)
        });
        this.sendJsonStream(TransportOpCode.KEY_SYNC, { event, msgId, data });
      }
    };
  }
}

export const transportClient = new NyxWebTransportClient();

export function connectSocket() {
  if (transportClient.connected) return;
  const token = useAuthStore.getState().accessToken || '';
  const certHash = import.meta.env.VITE_TRANSPORT_CERT_HASH;
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
    transportClient.sendEvent('messages:distribute_keys', { conversationId, keys }, (err: any, res?: { ok: boolean }) => {
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
