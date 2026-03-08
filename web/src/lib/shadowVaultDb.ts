import Dexie, { Table } from 'dexie';
import type { Message } from '@store/conversation';
import { getSodium } from '@lib/sodiumInitializer';
import { getMyEncryptionKeyPair } from '@utils/crypto';

export interface DecryptedMessageRecord {
  id: string;
  conversationId: string;
  content: string | null; // ENCRYPTED Base64 string at rest
  repliedToId?: string;
  repliedTo?: string; // Encrypted JSON string of the replied message
  createdAt: string | Date;
  senderId: string;
  isViewOnce?: boolean;
  isDeletedLocal?: boolean;
}

// --- CRYPTO ENGINE FOR IRON VAULT ---
const getVaultKey = async () => {
  const sodium = await getSodium();
  const { privateKey } = await getMyEncryptionKeyPair();
  if (!privateKey) throw new Error("Vault locked: Identity key not found in memory.");
  // Derive a deterministic 32-byte symmetric key from the user's private key
  return sodium.crypto_generichash(32, privateKey);
};

export const encryptVaultText = async (text: string): Promise<string> => {
  const sodium = await getSodium();
  const key = await getVaultKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  
  const cipherText = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    text, null, null, nonce, key
  );
  
  const combined = new Uint8Array(nonce.length + cipherText.length);
  combined.set(nonce);
  combined.set(cipherText, nonce.length);
  return sodium.to_base64(combined);
};

export const decryptVaultText = async (encryptedBase64: string): Promise<string | null> => {
  try {
    const sodium = await getSodium();
    const key = await getVaultKey();
    const combined = sodium.from_base64(encryptedBase64);
    const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    
    const nonce = combined.slice(0, nonceBytes);
    const cipherText = combined.slice(nonceBytes);

    const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, cipherText, null, nonce, key
    );
    return sodium.to_string(decrypted);
  } catch (e) {
    return null; // Silent fail for corrupted/old data
  }
};
// ------------------------------------

export class NyxShadowVault extends Dexie {
  messages!: Table<DecryptedMessageRecord, string>;

  constructor() {
    super('nyx_shadow_vault');
    this.version(2).stores({
      messages: 'id, conversationId, createdAt'
    });
  }

  async upsertMessages(messages: Message[]) {
    // Filter messages: Allow if it has content OR it is a tombstone
    const validMessages = messages.filter(m => (m.content && m.content !== 'waiting_for_key' && !m.content.startsWith('[')) || m.isDeletedLocal);
    if (validMessages.length === 0) return;

    try {
      const records: DecryptedMessageRecord[] = [];
      for (const m of validMessages) {
        let encryptedContent: string | null = null;
        let encryptedRepliedTo: string | undefined = undefined;

        if (m.content && !m.isDeletedLocal) {
            encryptedContent = await encryptVaultText(m.content);
        }
        
        if (m.repliedTo) {
             const repliedToStr = JSON.stringify(m.repliedTo);
             encryptedRepliedTo = await encryptVaultText(repliedToStr);
        }
        
        records.push({
          id: m.id,
          conversationId: m.conversationId,
          content: encryptedContent, // Iron Vault: Stored as cipher
          repliedToId: m.repliedToId,
          repliedTo: encryptedRepliedTo,
          createdAt: m.createdAt,
          senderId: m.senderId,
          isViewOnce: m.isViewOnce,
          isDeletedLocal: m.isDeletedLocal
        });
      }
      await this.messages.bulkPut(records);
    } catch (err) {
      console.error("Iron Vault Encryption Error:", err);
    }
  }

  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    try {
      const records = await this.messages.where('conversationId').equals(conversationId).toArray();
      const messages: Message[] = [];
      for (const r of records) {
        let plainText = null;
        let decryptedRepliedTo = undefined;

        if (r.content && !r.isDeletedLocal) {
          plainText = await decryptVaultText(r.content);
        }

        if (r.repliedTo) {
            const rawRepliedTo = await decryptVaultText(r.repliedTo);
            if (rawRepliedTo) {
                try {
                    decryptedRepliedTo = JSON.parse(rawRepliedTo);
                } catch {}
            }
        }

        messages.push({
          id: r.id,
          conversationId: r.conversationId,
          content: plainText,
          repliedToId: r.repliedToId,
          repliedTo: decryptedRepliedTo,
          createdAt: r.createdAt as string,
          senderId: r.senderId,
          isViewOnce: r.isViewOnce,
          isDeletedLocal: r.isDeletedLocal
        });
      }
      return messages;
    } catch (e) {
      console.error("Vault Query Error:", e);
      return [];
    }
  }

  async getMessage(id: string): Promise<Message | null> {
    try {
      const r = await this.messages.get(id);
      if (!r) return null;
      let plainText = null;
      let decryptedRepliedTo = undefined;

      if (r.content && !r.isDeletedLocal) {
        plainText = await decryptVaultText(r.content);
      }

      if (r.repliedTo) {
          const rawRepliedTo = await decryptVaultText(r.repliedTo);
          if (rawRepliedTo) {
              try {
                  decryptedRepliedTo = JSON.parse(rawRepliedTo);
              } catch {}
          }
      }

      return {
        id: r.id,
        conversationId: r.conversationId,
        content: plainText,
        repliedToId: r.repliedToId,
        repliedTo: decryptedRepliedTo,
        createdAt: r.createdAt as string,
        senderId: r.senderId,
        isViewOnce: r.isViewOnce,
        isDeletedLocal: r.isDeletedLocal
      };
    } catch (e) {
      return null;
    }
  }

  async deleteMessage(id: string) {
    try {
      await this.messages.delete(id);
    } catch (e) {
      console.error("Failed to delete message from vault", e);
    }
  }

  async deleteConversationMessages(conversationId: string) {
    try {
      await this.messages.where('conversationId').equals(conversationId).delete();
    } catch (e) {
      console.error("Failed to delete conversation messages from vault", e);
    }
  }
}

export const shadowVault = new NyxShadowVault();