import { EventEmitter } from 'eventemitter3';
import { initSodium } from './crypto/sodium.js';
import { INyxStorage } from './storage/types.js';
import { IndexedDBStorage } from './storage/indexeddb.js';
import { NyxApiClient } from './network/api.js';
import { NyxSocketClient } from './network/socket.js';
import { NyxSessionManager } from './core/sessionManager.js';
import { NyxKeyManager } from './core/keyManager.js';
import { NyxAttachmentManager } from './core/attachmentManager.js';
import { NyxQueueManager } from './core/queueManager.js';

export interface NyxClientConfig {
  apiKey: string;
  tenantId?: string;
  environment?: 'development' | 'production';
  baseURL?: string;
  storage?: INyxStorage;
}

export default class NyxClient extends EventEmitter {
  private config: NyxClientConfig;
  private storage: INyxStorage;
  public api: NyxApiClient;
  public socket: NyxSocketClient;
  private sessionManager: NyxSessionManager;
  public keyManager: NyxKeyManager;
  public attachmentManager: NyxAttachmentManager;
  public queueManager: NyxQueueManager;

  constructor(config: NyxClientConfig) {
    super();
    this.config = {
      baseURL: 'https://api.nyx-app.my.id',
      ...config
    };
    this.storage = config.storage || new IndexedDBStorage(config.tenantId || 'default');
    this.api = new NyxApiClient(this.config.baseURL!, this.config.apiKey);
    this.socket = new NyxSocketClient();
    this.sessionManager = new NyxSessionManager(this.storage, this.api, this.socket);
    this.keyManager = new NyxKeyManager(this.storage, this.api);
    this.attachmentManager = new NyxAttachmentManager(this.api);
    this.queueManager = new NyxQueueManager(this.storage, this.api, this.socket);
    
    // Bubble up socket events to the client
    this.socket.on('connect', async () => {
      this.emit('connect');
      // Flush queue when connection is restored
      this.queueManager.flushQueue().catch(console.error);
    });
    this.socket.on('disconnect', (reason: unknown) => this.emit('disconnect', reason));
    this.socket.on('connect_error', (error: unknown) => this.emit('connect_error', error));
  }

  async initialize(): Promise<void> {
    await initSodium();
    console.log("NYX Engine Crypto Core Initialized");
    console.log("NYX Engine Storage Initialized");
    console.log("NYX Engine SDK Initialized");
  }

  async connectUser(jwtToken: string): Promise<void> {
    this.api.setToken(jwtToken);
    
    // We await connection explicitly here or rely on the event
    // The prompt says: "Setelah koneksi soket berhasil, panggil otomatis await this.keyManager.registerDevice()"
    // But socket.connect() is synchronous and autoConnect is true.
    // Let's hook into the connect event once, or just do it after calling connect if we return a promise wrapper.
    
    return new Promise((resolve) => {
      this.socket.once('connect', async () => {
        try {
          await this.keyManager.registerDevice();
          console.log("NYX Engine Device Registered");
          resolve();
        } catch (error) {
          console.error("Device registration failed:", error);
          this.emit('error', error);
          resolve(); // Still resolve so the app doesn't hang, but emit error
        }
      });
      
      this.socket.connect(this.config.baseURL!, jwtToken);

      // Listen for incoming messages and process them through the session manager
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.socket.on('message', async (payload: any) => {
        try {
          const decrypted = await this.sessionManager.processIncomingMessage(payload);
          this.emit('message.decrypted', decrypted);
        } catch (e) {
          console.error(e);
        }
      });
    });
  }

  public async createChat(recipientId: string): Promise<void> {
    const initData = await this.sessionManager.initializeSession(recipientId);
    this.emit('chat.created', { recipientId, initData });
  }

  public async sendMessage(conversationId: string, text: string): Promise<void> {
    const payload = await this.sessionManager.sendMessage(conversationId, text);
    
    if (this.socket.connected) {
      this.socket.emitEvent('message:send', payload);
    } else {
      await this.queueManager.enqueueMessage(conversationId, payload);
    }
  }

  public async sendMedia(conversationId: string, file: Blob, mimeType: string, caption?: string): Promise<void> {
    const mediaMetadata = await this.attachmentManager.uploadSecureMedia(file, mimeType);
    
    const payloadObj = {
      type: 'media',
      caption,
      media: mediaMetadata
    };
    
    const payload = await this.sessionManager.sendMessage(conversationId, JSON.stringify(payloadObj));
    
    if (this.socket.connected) {
      this.socket.emitEvent('message:send', payload);
    } else {
      await this.queueManager.enqueueMessage(conversationId, payload);
    }
  }
}
