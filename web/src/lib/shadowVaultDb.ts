import { db, DecryptedMessageRecord } from './db';
import { Dexie } from 'dexie';
import type { Message } from '@store/conversation';
import { getSodium } from '@lib/sodiumInitializer';
import { getMyEncryptionKeyPair } from '@utils/crypto';
import { asMessageId, asConversationId, asUserId } from '@nyx/shared';
import type { StoryId } from '@nyx/shared';

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
  return sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING);
};

export const decryptVaultText = async (encryptedBase64: string): Promise<string | null> => {
  try {
    const sodium = await getSodium();
    const key = await getVaultKey();
    const combined = sodium.from_base64(encryptedBase64, sodium.base64_variants.URLSAFE_NO_PADDING);
    const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    
    const nonce = combined.slice(0, nonceBytes);
    const cipherText = combined.slice(nonceBytes);

    const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, cipherText, null, nonce, key
    );
    return new TextDecoder().decode(decrypted);
  } catch (_e) {
    return null; // Silent fail for corrupted/old data
  }
};
// ------------------------------------

class NyxShadowVaultProxy {
  get messages() {
    return db.messages;
  }

  get storyKeys() {
    return db.storyKeys;
  }

  async exportDatabase(): Promise<string> {
    try {
      const messages = await db.messages.toArray();
      return JSON.stringify({ messages });
    } catch (e) {
      console.error("Export DB failed:", e);
      return "{}";
    }
  }

  async importDatabase(jsonString: string): Promise<void> {
    try {
      const data = JSON.parse(jsonString);
      if (data.messages && Array.isArray(data.messages)) {
        await db.messages.bulkPut(data.messages);
        console.log(`[ShadowVault] Successfully imported ${data.messages.length} messages.`);
      }
    } catch (e) {
      console.error("Import DB failed:", e);
    }
  }

  async upsertMessages(messages: Message[]) {
    // Filter messages: Allow if it has content OR it is a tombstone
    const validMessages = messages.filter(m => (m.content && m.content !== 'waiting_for_key' && !m.content.startsWith('[')) || m.isDeletedLocal || m.fileUrl || m.isBlindAttachment);
    if (validMessages.length === 0) return;

    try {
      const records: DecryptedMessageRecord[] = [];
      for (const m of validMessages) {
        const existing = await db.messages.get(m.id);
        
        let encryptedContent: string | null = null;
        let encryptedRepliedTo: string | undefined = undefined;
        let encryptedSenderName: string | undefined = undefined;
        let encryptedSenderUsername: string | undefined = undefined;
        let encryptedSenderAvatarUrl: string | undefined = undefined;
        let encryptedFileMeta: string | undefined = undefined;

        if (m.content && !m.isDeletedLocal) {
            encryptedContent = await encryptVaultText(m.content);
        }
        
        if (m.repliedTo) {
             const repliedToStr = JSON.stringify(m.repliedTo);
             encryptedRepliedTo = await encryptVaultText(repliedToStr);
        } else if (existing?.repliedTo) {
             encryptedRepliedTo = existing.repliedTo;
        }

        const mSender = m.sender as { name?: string; username?: string; avatarUrl?: string } | undefined;
        const hasValidName = mSender?.name && mSender.name !== 'Unknown' && mSender.name !== 'Encrypted User';
        
        if (hasValidName) {
            encryptedSenderName = (await encryptVaultText(mSender.name as string)) || undefined;
            if (mSender.username) {
                encryptedSenderUsername = await encryptVaultText(mSender.username);
            }
            if (mSender.avatarUrl) {
                encryptedSenderAvatarUrl = await encryptVaultText(mSender.avatarUrl);
            }
        } else if (existing?.senderName) {
            encryptedSenderName = existing.senderName;
            encryptedSenderUsername = existing.senderUsername;
            encryptedSenderAvatarUrl = existing.senderAvatarUrl;
        } else if (mSender?.avatarUrl) {
            encryptedSenderAvatarUrl = await encryptVaultText(mSender.avatarUrl);
        }

        if (m.fileUrl || m.isBlindAttachment) {
            encryptedFileMeta = await encryptVaultText(JSON.stringify({
                fileUrl: m.fileUrl,
                fileKey: m.fileKey,
                fileName: m.fileName,
                fileType: m.fileType,
                fileSize: m.fileSize,
                duration: m.duration,
                isBlindAttachment: m.isBlindAttachment
            }));
        }
        
        records.push({
          id: m.id,
          conversationId: m.conversationId,
          content: encryptedContent, 
          repliedToId: m.repliedToId || existing?.repliedToId,
          repliedTo: encryptedRepliedTo,
          createdAt: m.createdAt,
          senderId: m.senderId,
          senderName: encryptedSenderName,
          senderUsername: encryptedSenderUsername,
          senderAvatarUrl: encryptedSenderAvatarUrl,
          isViewOnce: m.isViewOnce,
          isDeletedLocal: m.isDeletedLocal,
          fileMeta: encryptedFileMeta || existing?.fileMeta,
          expiresAt: m.expiresAt || existing?.expiresAt
        });
      }
      await db.messages.bulkPut(records);
    } catch (err) {
      console.error("Iron Vault Encryption Error:", err);
    }
  }

  async getMessagesByConversation(conversationId: string, limit: number = 50, beforeDate?: string): Promise<Message[]> {
    try {
      // FIX 1: Jalankan query IndexedDB utama terlebih dahulu agar tidak berebut transaksi dengan sweep
      const minDate = Dexie.minKey;
      const maxDate = beforeDate || Dexie.maxKey;
      
      const now = Date.now();

      const validRecords = await db.messages
        .where('[conversationId+createdAt]')
        .between([conversationId, minDate], [conversationId, maxDate])
        .reverse()
        .filter(r => {
          if (!r.expiresAt) return true;
          return new Date(r.expiresAt).getTime() > now;
        })
        .limit(limit)
        .toArray();

      // Eksekusi pembersihan kadaluarsa tanpa memblokir thread
      queueMicrotask(async () => {
        try {
          const expired = await db.messages
            .where('conversationId')
            .equals(conversationId)
            .filter(r => {
              const expiresAt = r.expiresAt;
              return !!expiresAt && new Date(expiresAt).getTime() <= now;
            })
            .primaryKeys();
          
          if (expired.length > 0) {
            await db.messages.bulkDelete(expired);
          }
        } catch (e) {
            console.error("Failed to clean expired messages:", e);
        }
      });

      return this.parseRecordsToMessages(validRecords.reverse());
    } catch (e: unknown) {
      console.error("Vault Query Error:", e);
      return [];
    }
  }

  private async parseRecordsToMessages(records: DecryptedMessageRecord[]): Promise<Message[]> {
     const messages: Message[] = [];
      for (const r of records) {
        // FIX 2: Hapus Zod parsing yang ketat di sini, karena record dari DB lokal sudah kita anggap valid bentuknya.
        // Zod parsing bisa memblokir pesan yang valid jika schema shared-nya sangat ketat.
        
        let plainText = null;
        let decryptedRepliedTo: Message | undefined = undefined;
        let decryptedSenderName: string | undefined = undefined;
        let decryptedSenderUsername: string | undefined = undefined;
        let decryptedSenderAvatarUrl: string | undefined = undefined;
        let decryptedFileMeta: Partial<Message> | undefined = undefined;

        if (r.content && !r.isDeletedLocal) plainText = await decryptVaultText(r.content);
        if (r.repliedTo) {
            const rawRepliedTo = await decryptVaultText(r.repliedTo);
            if (rawRepliedTo) { 
                try { decryptedRepliedTo = JSON.parse(rawRepliedTo); } catch {} 
            }
        }
        if (r.senderName) decryptedSenderName = await decryptVaultText(r.senderName) || undefined;
        if (r.senderUsername) decryptedSenderUsername = await decryptVaultText(r.senderUsername) || undefined;
        if (r.senderAvatarUrl) decryptedSenderAvatarUrl = await decryptVaultText(r.senderAvatarUrl) || undefined;

        if (r.fileMeta) {
            const rawMeta = await decryptVaultText(r.fileMeta);
            if (rawMeta) { 
                try { decryptedFileMeta = JSON.parse(rawMeta); } catch {} 
            }
        }

        // FIX 3: Object construction yang konsisten dan strongly typed
        const msg: Message = {
          id: asMessageId(r.id),
          conversationId: asConversationId(r.conversationId),
          content: plainText,
          repliedToId: r.repliedToId ? asMessageId(r.repliedToId) : undefined,
          repliedTo: decryptedRepliedTo,
          createdAt: r.createdAt as string,
          senderId: asUserId(r.senderId),
          sender: {
              id: asUserId(r.senderId),
              name: decryptedSenderName || 'Unknown',
              username: decryptedSenderUsername,
              avatarUrl: decryptedSenderAvatarUrl
          },
          status: (() => {
              const raw = r.status?.toUpperCase();
              if (raw === 'SENDING' || raw === 'SENT' || raw === 'FAILED') {
                  return raw as 'SENDING' | 'SENT' | 'FAILED';
              }
              return 'SENT';
          })(),
          isViewOnce: r.isViewOnce,
          isDeletedLocal: r.isDeletedLocal,
          expiresAt: r.expiresAt as string | undefined,
          // Merge file properties cleanly
          fileUrl: decryptedFileMeta?.fileUrl,
          fileKey: decryptedFileMeta?.fileKey,
          fileName: decryptedFileMeta?.fileName,
          fileType: decryptedFileMeta?.fileType,
          fileSize: decryptedFileMeta?.fileSize,
          duration: decryptedFileMeta?.duration,
          isBlindAttachment: decryptedFileMeta?.isBlindAttachment
        };

        messages.push(msg);
      }
      return messages;
  }

  async getMessage(id: string): Promise<Message | null> {
    try {
      const r = await db.messages.get(id);
      if (!r) return null;
      
      const parsedArray = await this.parseRecordsToMessages([r]);
      return parsedArray.length > 0 ? parsedArray[0] : null;
    } catch (_e) {
      return null;
    }
  }

  async deleteMessage(id: string) {
    try {
      await db.messages.delete(id);
    } catch (e) {
      console.error("Failed to delete message from vault", e);
    }
  }

  async deleteConversationMessages(conversationId: string) {
    try {
      await db.messages.where('conversationId').equals(conversationId).delete();
    } catch (e) {
      console.error("Failed to delete conversation messages from vault", e);
    }
  }
}

export const shadowVault = new NyxShadowVaultProxy();

export async function saveStoryKey(storyId: string, base64Key: string): Promise<void> {
  await db.storyKeys.put({ storyId: storyId as StoryId, key: base64Key });
}

export async function getStoryKey(storyId: string): Promise<string | null> {
  const record = await db.storyKeys.get(storyId);
  return record ? record.key : null;
}