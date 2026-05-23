import type { INyxStorage } from '../storage/types.js';
import type { NyxApiClient } from '../network/api.js';
import type { NyxSocketClient } from '../network/socket.js';
import type { DoubleRatchetHeader } from '../crypto/types.js';

export interface QueuedMessage {
  id: string;
  conversationId: string;
  encryptedPayload: {
    conversationId: string;
    header: DoubleRatchetHeader;
    ciphertext: string;
  };
  timestamp: number;
  retryCount: number;
}

export class NyxQueueManager {
  private storage: INyxStorage;
  private api: NyxApiClient;
  private socket: NyxSocketClient;
  private maxRetries = 5;
  private isFlushing = false;

  constructor(storage: INyxStorage, api: NyxApiClient, socket: NyxSocketClient) {
    this.storage = storage;
    this.api = api;
    this.socket = socket;
  }

  public async enqueueMessage(conversationId: string, encryptedPayload: any): Promise<void> {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
    
    const message: QueuedMessage = {
      id,
      conversationId,
      encryptedPayload,
      timestamp: Date.now(),
      retryCount: 0
    };

    await this.storage.set('offline_outbox', id, message);
  }

  public async flushQueue(): Promise<void> {
    if (this.isFlushing || !this.socket.connected) {
      return;
    }

    this.isFlushing = true;

    try {
      if (!this.storage.getAll) {
        console.warn('Storage implementation does not support getAll. Cannot flush queue.');
        return;
      }

      const messages = await this.storage.getAll<QueuedMessage>('offline_outbox');
      if (!messages || messages.length === 0) {
        return;
      }

      // Urutkan berdasarkan timestamp (FIFO)
      messages.sort((a, b) => a.timestamp - b.timestamp);

      for (const msg of messages) {
        try {
          // Hanya proses jika socket connect
          if (!this.socket.connected) {
            break;
          }

          // Kirim via socket (bisa diadaptasi ke api jika ada rute khusus, tp di sini via socket)
          this.socket.emitEvent('message:send', msg.encryptedPayload);
          
          // Jika sukses emit (asumsi emit berhasil, karena kita tidak menunggu ack dari backend di socket.io by default di sini kecuali emitWithAck.
          // Untuk simple resiliency sesuai instruksi, kita anggap emit sukses = terkirim)
          await this.storage.remove('offline_outbox', msg.id);
        } catch (err) {
          console.error(`Failed to send queued message ${msg.id}`, err);
          msg.retryCount++;
          
          if (msg.retryCount > this.maxRetries) {
            // Bisa dihapus atau dibiarkan, sesuai kebutuhan. Instruksi: biarkan di store untuk dicoba lagi nanti
            // (Jadi kita update retryCount nya saja)
            await this.storage.set('offline_outbox', msg.id, msg);
          } else {
            await this.storage.set('offline_outbox', msg.id, msg);
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }
}
