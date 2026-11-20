import { Message } from '@store/conversation';
import { deleteAppRow, getAppRow, listAppRows, putAppRow } from './storage/appStorage';

export interface QueueItem {
  tempId: number;
  conversationId: string;
  data: Partial<Message>;
  timestamp: number;
  attempt: number;
}

export async function addToQueue(conversationId: string, data: Partial<Message>, tempId: number): Promise<void> {
  await putAppRow('offlineQueue', tempId, {
    tempId,
    conversationId,
    data,
    timestamp: Date.now(),
    attempt: 0,
  });
}

export async function getQueueItems(): Promise<QueueItem[]> {
  const rows = await listAppRows<QueueItem>('offlineQueue');
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

export async function removeFromQueue(tempId: number): Promise<void> {
  await deleteAppRow('offlineQueue', tempId);
}

export async function clearQueue(): Promise<void> {
  for (const item of await listAppRows<QueueItem>('offlineQueue')) {
    await deleteAppRow('offlineQueue', item.tempId);
  }
}

export async function updateQueueAttempt(tempId: number, attempt: number): Promise<void> {
  const item = await getAppRow<QueueItem>('offlineQueue', tempId);
  if (item) {
    item.attempt = attempt;
    await putAppRow('offlineQueue', tempId, item);
  }
}
