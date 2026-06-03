import { dbRequest } from './base';
import { encryptField, decryptField } from '../encryption';
import type { Message } from '@store/conversation';

export interface QueueItem {
  tempId: number;
  conversationId: string;
  data: Partial<Message>;
  timestamp: number;
  attempt: number;
}

export class OfflineQueueRepository {
  static async add(item: QueueItem): Promise<void> {
    const encryptedData = await encryptField(JSON.stringify(item.data));
    const record = {
      tempId: item.tempId,
      conversationId: item.conversationId,
      data: encryptedData,
      timestamp: item.timestamp,
      attempt: item.attempt
    };
    await dbRequest('insert', 'offlineQueue', record);
  }

  static async list(): Promise<QueueItem[]> {
    const records = await dbRequest('list', 'offlineQueue', null);
    const results: QueueItem[] = [];
    
    for (const r of records) {
        try {
            const decryptedData = await decryptField(r.data);
            results.push({
              tempId: r.tempId,
              conversationId: r.conversationId,
              data: JSON.parse(decryptedData as string),
              timestamp: r.timestamp,
              attempt: r.attempt
            });
        } catch (err) {
            console.error('[OfflineQueueRepository] Failed to decrypt queue item:', err);
        }
    }
    return results;
  }

  static async delete(tempId: number): Promise<void> {
    await dbRequest('delete', 'offlineQueue', tempId);
  }

  static async clear(): Promise<void> {
      await dbRequest('clear_table', 'offlineQueue', null);
  }
}
