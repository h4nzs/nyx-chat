import { db } from './db';
import { Message } from '@store/conversation';

export interface QueueItem {
  tempId: number;
  conversationId: string;
  data: Partial<Message>;
  timestamp: number;
  attempt: number;
}

export async function addToQueue(conversationId: string, data: Partial<Message>, tempId: number): Promise<void> {
  await db.offlineQueue.put({
    tempId,
    conversationId,
    data,
    timestamp: Date.now(),
    attempt: 0,
  });
}

export async function getQueueItems(): Promise<QueueItem[]> {
  // Get all items sorted by timestamp (oldest first)
  return await db.offlineQueue.orderBy('timestamp').toArray();
}

export async function removeFromQueue(tempId: number): Promise<void> {
  await db.offlineQueue.delete(tempId);
}

export async function clearQueue(): Promise<void> {
  await db.offlineQueue.clear();
}

export async function updateQueueAttempt(tempId: number, attempt: number): Promise<void> {
  const item = await db.offlineQueue.get(tempId);
  if (item) {
    item.attempt = attempt;
    await db.offlineQueue.put(item);
  }
}
