import { setLSK } from './encryption';
import { getWorker } from './repositories/base';

export class DatabaseManager {
  private static instance: DatabaseManager;
  private isReady = false;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  async initialize(lsk: Uint8Array): Promise<void> {
    setLSK(lsk);
    
    // Ensure worker is started
    const worker = getWorker();
    
    return new Promise((resolve) => {
      const checkReady = (e: MessageEvent) => {
        if (e.data.type === 'READY') {
          worker.removeEventListener('message', checkReady);
          this.isReady = true;
          resolve();
        }
      };
      worker.addEventListener('message', checkReady);
      
      // If worker already initialized (re-init with new LSK)
      if (this.isReady) resolve();
    });
  }

  getReadyStatus(): boolean {
    return this.isReady;
  }
}

export * from './repositories/message.repo';
export * from './repositories/keychain.repo';
export * from './repositories/kv.repo';
export * from './repositories/offlineQueue.repo';
export * from './repositories/story.repo';
export * from './encryption';
