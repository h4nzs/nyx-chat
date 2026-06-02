import { dbRequest } from './base';
import { encryptField, decryptField } from '../encryption';
import type { Message } from '@store/conversation';
import type { MessageId, ConversationId, UserId } from '@nyx/shared';

export interface MessageRecord {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: Uint8Array | null;
  replied_to_id: string | null;
  replied_to: Uint8Array | null;
  created_at: string;
  status: string;
  sender_name: Uint8Array | null;
  sender_username: Uint8Array | null;
  sender_avatar_url: Uint8Array | null;
  is_view_once: boolean;
  is_deleted_local: boolean;
  file_meta: Uint8Array | null;
  expires_at: string | null;
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
      conversation_id: m.conversationId,
      sender_id: m.senderId,
      content: m.content ? await encryptField(m.content) : null,
      replied_to_id: m.repliedToId || null,
      replied_to: m.repliedTo ? await encryptField(JSON.stringify(m.repliedTo)) : null,
      created_at: typeof m.createdAt === 'string' ? m.createdAt : new Date(m.createdAt).toISOString(),
      status: m.status?.toLowerCase() || 'sent',
      sender_name: m.sender?.name ? await encryptField(m.sender.name) : null,
      sender_username: m.sender?.username ? await encryptField(m.sender.username) : null,
      sender_avatar_url: m.sender?.avatarUrl ? await encryptField(m.sender.avatarUrl) : null,
      is_view_once: !!m.isViewOnce,
      is_deleted_local: !!m.isDeletedLocal,
      file_meta: (m.fileUrl || m.isBlindAttachment) ? await encryptField(JSON.stringify({
        fileUrl: m.fileUrl,
        fileKey: m.fileKey,
        fileName: m.fileName,
        fileType: m.fileType,
        fileSize: m.fileSize,
        duration: m.duration,
        isBlindAttachment: m.isBlindAttachment
      })) : null,
      expires_at: m.expiresAt || null
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
        if (record.is_view_once || record.is_deleted_local || !record.content) continue;

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
      beforeDate = chunk[chunk.length - 1].created_at;
      if (chunk.length < CHUNK_SIZE) break;
    }

    return results;
  }

  private static async mapRecordToMessage(r: MessageRecord): Promise<Message> {
    const decryptedContent = r.content ? await decryptField(r.content) : null;
    const decryptedRepliedTo = r.replied_to ? await decryptField(r.replied_to) : null;
    const decryptedFileMeta = r.file_meta ? await decryptField(r.file_meta) : null;

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
      conversationId: r.conversation_id as ConversationId,
      content: typeof decryptedContent === 'string' ? decryptedContent : null,
      senderId: r.sender_id as UserId,
      sender: {
          id: r.sender_id as UserId,
          name: r.sender_name ? (await decryptField(r.sender_name) as string) : 'Unknown',
          username: r.sender_username ? (await decryptField(r.sender_username) as string) : undefined,
          avatarUrl: r.sender_avatar_url ? (await decryptField(r.sender_avatar_url) as string) : undefined,
      },
      repliedToId: r.replied_to_id as MessageId | undefined,
      repliedTo: repliedToObj,
      createdAt: r.created_at,
      status: (r.status.toUpperCase() as 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED') || 'SENT',
      isViewOnce: r.is_view_once,
      isDeletedLocal: r.is_deleted_local,
      expiresAt: r.expires_at || undefined,
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
