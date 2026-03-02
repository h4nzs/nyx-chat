import Dexie, { Table } from 'dexie';
import type { Message } from '@store/conversation';

export interface DecryptedMessageRecord {
  id: string;
  conversationId: string;
  content: string; // The decrypted content
  createdAt: string | Date;
  senderId: string;
  isViewOnce?: boolean;
}

export class NyxShadowVault extends Dexie {
  messages!: Table<DecryptedMessageRecord, string>;

  constructor() {
    super('nyx_shadow_vault');
    this.version(1).stores({
      messages: 'id, conversationId, createdAt' 
      // conversationId is indexed for fast lookups per chat
    });
  }

  // Utility to safely upsert messages
  async upsertMessages(messages: Message[]) {
    const records: DecryptedMessageRecord[] = messages
      .filter(m => m.content && m.content !== 'waiting_for_key' && !m.content.startsWith('[')) // Only save properly decrypted text
      .map(m => ({
        id: m.id,
        conversationId: m.conversationId,
        content: m.content || '',
        createdAt: m.createdAt,
        senderId: m.senderId,
        isViewOnce: m.isViewOnce
      }));

    if (records.length > 0) {
      await this.messages.bulkPut(records).catch(err => console.error("Shadow Vault Error:", err));
    }
  }
}

export const shadowVault = new NyxShadowVault();