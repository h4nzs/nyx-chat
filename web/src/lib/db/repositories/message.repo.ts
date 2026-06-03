import { dbRequest } from './base';
import { encryptField, decryptField } from '../encryption';
import type { Message } from '@store/conversation';
import type { MessageId, ConversationId, UserId } from '@nyx/shared';

export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  content: Uint8Array | null;
  repliedToId: string | null;
  repliedTo: Uint8Array | null;
  createdAt: string;
  status: string;
  senderName: Uint8Array | null;
  senderUsername: Uint8Array | null;
  senderAvatarUrl: Uint8Array | null;
  isViewOnce: boolean;
  isDeletedLocal: boolean;
  fileMeta: Uint8Array | null;
  expiresAt: string | null;
}

export class MessageRepository {
  static async insertMessage(m: Message): Promise<void> {
    const record = await this.mapMessageToRecord(m);
    await dbRequest('insert', 'messages', record);
  }

  static async upsertMessages(messages: Message[]): Promise<void> {
      const records = [];
      for (const m of messages) {
          records.push(await this.mapMessageToRecord(m));
      }
      await dbRequest('bulk_insert', 'messages', records);
  }

  private static async mapMessageToRecord(m: Message): Promise<MessageRecord> {
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      content: m.content ? await encryptField(m.content) : null,
      repliedToId: m.repliedToId || null,
      repliedTo: m.repliedTo ? await encryptField(JSON.stringify(m.repliedTo)) : null,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(m.createdAt).toISOString(),
      status: m.status?.toLowerCase() || 'sent',
      senderName: m.sender?.name ? await encryptField(m.sender.name) : null,
      senderUsername: m.sender?.username ? await encryptField(m.sender.username) : null,
      senderAvatarUrl: m.sender?.avatarUrl ? await encryptField(m.sender.avatarUrl) : null,
      isViewOnce: !!m.isViewOnce,
      isDeletedLocal: !!m.isDeletedLocal,
      fileMeta: (m.fileUrl || m.isBlindAttachment) ? await encryptField(JSON.stringify({
        fileUrl: m.fileUrl,
        fileKey: m.fileKey,
        fileName: m.fileName,
        fileType: m.fileType,
        fileSize: m.fileSize,
        duration: m.duration,
        isBlindAttachment: m.isBlindAttachment
      })) : null,
      expiresAt: m.expiresAt || null
    };
  }

  static async getMessages(conversationId: string, limit: number = 50, beforeDate?: string): Promise<Message[]> {
    const records: MessageRecord[] = await dbRequest('query_messages', 'messages', { conversationId, limit, beforeDate });
    
    const messages: Message[] = [];
    for (const r of records) {
      messages.push(await this.mapRecordToMessage(r));
    }
    return messages;
  }

  static async getMessage(id: string): Promise<Message | null> {
    const record: MessageRecord | null = await dbRequest('get', 'messages', id);
    if (!record) return null;
    return this.mapRecordToMessage(record);
  }

  static async searchMessagesDecrypted(query: string, conversationId: string, limit: number = 20): Promise<Message[]> {
    const results: Message[] = [];
    let beforeDate: string | undefined = undefined;
    const CHUNK_SIZE = 100;
    const normalizedQuery = query.toLowerCase();

    // Iterate in chunks until we find enough matches or exhaust history
    while (results.length < limit) {
      const chunk: MessageRecord[] = await dbRequest('query_messages', 'messages', { 
        conversationId, 
        limit: CHUNK_SIZE, 
        beforeDate 
      });

      if (chunk.length === 0) break;

      for (const record of chunk) {
        if (record.isViewOnce || record.isDeletedLocal || !record.content) continue;

        try {
            const decryptedContent = await decryptField(record.content);
            if (typeof decryptedContent === 'string' && decryptedContent.toLowerCase().includes(normalizedQuery)) {
              results.push(await this.mapRecordToMessage(record));
              if (results.length >= limit) break;
            }
        } catch (err) {
            console.error('[MessageRepository] Failed to decrypt message for search:', err);
        }
      }

      // Update beforeDate for next chunk
      beforeDate = chunk[chunk.length - 1].createdAt;
      if (chunk.length < CHUNK_SIZE) break;
    }

    return results;
  }

  private static async mapRecordToMessage(r: MessageRecord): Promise<Message> {
    const decryptedContent = r.content ? await decryptField(r.content) : null;
    const decryptedRepliedTo = r.repliedTo ? await decryptField(r.repliedTo) : null;
    const decryptedFileMeta = r.fileMeta ? await decryptField(r.fileMeta) : null;

    let repliedToObj = null;
    if (decryptedRepliedTo && typeof decryptedRepliedTo === 'string') {
        try { repliedToObj = JSON.parse(decryptedRepliedTo); } catch {}
    }

    let fileMetaObj: any = {};
    if (decryptedFileMeta && typeof decryptedFileMeta === 'string') {
        try { fileMetaObj = JSON.parse(decryptedFileMeta); } catch {}
    }

    return {
      id: r.id as MessageId,
      conversationId: r.conversationId as ConversationId,
      content: typeof decryptedContent === 'string' ? decryptedContent : null,
      senderId: r.senderId as UserId,
      sender: {
          id: r.senderId as UserId,
          name: r.senderName ? (await decryptField(r.senderName) as string) : 'Unknown',
          username: r.senderUsername ? (await decryptField(r.senderUsername) as string) : undefined,
          avatarUrl: r.senderAvatarUrl ? (await decryptField(r.senderAvatarUrl) as string) : undefined,
      },
      repliedToId: r.repliedToId as MessageId | undefined,
      repliedTo: repliedToObj,
      createdAt: r.createdAt,
      status: (r.status.toUpperCase() as 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED') || 'SENT',
      isViewOnce: r.isViewOnce,
      isDeletedLocal: r.isDeletedLocal,
      expiresAt: r.expiresAt || undefined,
      ...fileMetaObj
    };
  }

  static async deleteMessage(id: string): Promise<void> {
      await dbRequest('delete', 'messages', id);
  }

  static async clearMessages(conversationId: string): Promise<void> {
      await dbRequest('delete_by_conversation', 'messages', conversationId);
  }
}
