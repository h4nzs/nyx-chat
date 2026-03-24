import { db, DecryptedMessageRecord } from './db';
import type { Message } from '@store/conversation';
import { getSodium } from '@lib/sodiumInitializer';
import { getMyEncryptionKeyPair } from '@utils/crypto';
import { asMessageId, asConversationId, asUserId } from '@nyx/shared';
import type { StoryId } from '@nyx/shared';
import { ShadowVaultMessageSchema } from '@nyx/shared';

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

  async upsertMessages(messages: Message[]) {
    // Filter messages: Allow if it has content OR it is a tombstone
    const validMessages = messages.filter(m => (m.content && m.content !== 'waiting_for_key' && !m.content.startsWith('[')) || m.isDeletedLocal);
    if (validMessages.length === 0) return;

    try {
      const records: DecryptedMessageRecord[] = [];
      for (const m of validMessages) {
        // [FIX] PERSISTENCE: Check if we already have a record with better profile data
        const existing = await db.messages.get(m.id);
        
        let encryptedContent: string | null = null;
        let encryptedRepliedTo: string | undefined = undefined;
        let encryptedSenderName: string | undefined = undefined;
        let encryptedSenderUsername: string | undefined = undefined;
        let encryptedSenderAvatarUrl: string | undefined = undefined;

        if (m.content && !m.isDeletedLocal) {
            encryptedContent = await encryptVaultText(m.content);
        }
        
        if (m.repliedTo) {
             const repliedToStr = JSON.stringify(m.repliedTo);
             encryptedRepliedTo = await encryptVaultText(repliedToStr);
        } else if (existing?.repliedTo) {
             encryptedRepliedTo = existing.repliedTo;
        }

        // Fix: Persist sender info if it was hydrated, otherwise fallback to existing
        const mSender = m.sender as { name?: string; username?: string; avatarUrl?: string };
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
            // Keep the real name we already have in the vault!
            encryptedSenderName = existing.senderName;
            encryptedSenderUsername = existing.senderUsername;
            encryptedSenderAvatarUrl = existing.senderAvatarUrl;
        } else if (mSender?.avatarUrl) {
            encryptedSenderAvatarUrl = await encryptVaultText(mSender.avatarUrl);
        }
        
        records.push({
          id: m.id,
          conversationId: m.conversationId,
          content: encryptedContent, // Iron Vault: Stored as cipher
          repliedToId: m.repliedToId || existing?.repliedToId,
          repliedTo: encryptedRepliedTo,
          createdAt: m.createdAt,
          senderId: m.senderId,
          senderName: encryptedSenderName,
          senderUsername: encryptedSenderUsername,
          senderAvatarUrl: encryptedSenderAvatarUrl,
          isViewOnce: m.isViewOnce,
          isDeletedLocal: m.isDeletedLocal
        });
      }
      await db.messages.bulkPut(records);
    } catch (err) {
      console.error("Iron Vault Encryption Error:", err);
    }
  }

  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    try {
      const records = await db.messages.where('conversationId').equals(conversationId).toArray();
      const messages: Message[] = [];
      for (const rawRecord of records) {
        const parsed = ShadowVaultMessageSchema.safeParse(rawRecord);
        if (!parsed.success) {
            console.warn("[ShadowVault Shield] Skipping corrupted local message record:", rawRecord.id, parsed.error.format());
            continue;
        }
        
        const r = parsed.data;
        let plainText = null;
        let decryptedRepliedTo = undefined;
        let decryptedSenderName = undefined;
        let decryptedSenderUsername = undefined;
        let decryptedSenderAvatarUrl = undefined;

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

        if (r.senderName) {
            decryptedSenderName = await decryptVaultText(r.senderName) || undefined;
        }
        if (r.senderUsername) {
            decryptedSenderUsername = await decryptVaultText(r.senderUsername) || undefined;
        }
        if (r.senderAvatarUrl) {
            decryptedSenderAvatarUrl = await decryptVaultText(r.senderAvatarUrl) || undefined;
        }

        messages.push({
          id: asMessageId(r.id),
          conversationId: asConversationId(r.conversationId),
          content: plainText,
          repliedToId: r.repliedToId ? asMessageId(r.repliedToId) : undefined,
          repliedTo: decryptedRepliedTo,
          createdAt: r.createdAt as string,
          senderId: asUserId(r.senderId),
          sender: {
              id: r.senderId,
              name: decryptedSenderName,
              username: decryptedSenderUsername,
              avatarUrl: decryptedSenderAvatarUrl
          } as unknown as Message['sender'],
          isViewOnce: r.isViewOnce,
          isDeletedLocal: r.isDeletedLocal
        });
      }
      return messages;
    } catch (e: unknown) {
      console.error("Vault Query Error:", e);
      return [];
    }
  }

  async getMessage(id: string): Promise<Message | null> {
    try {
      const r = await db.messages.get(id);
      if (!r) return null;
      let plainText = null;
      let decryptedRepliedTo = undefined;
      let decryptedSenderName = undefined;
      let decryptedSenderUsername = undefined;
      let decryptedSenderAvatarUrl = undefined;

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

      if (r.senderName) {
          decryptedSenderName = await decryptVaultText(r.senderName) || undefined;
      }
      if (r.senderUsername) {
          decryptedSenderUsername = await decryptVaultText(r.senderUsername) || undefined;
      }
      if (r.senderAvatarUrl) {
          decryptedSenderAvatarUrl = await decryptVaultText(r.senderAvatarUrl) || undefined;
      }

      return {
        id: asMessageId(r.id),
        conversationId: asConversationId(r.conversationId),
        content: plainText,
        repliedToId: r.repliedToId ? asMessageId(r.repliedToId) : undefined,
        repliedTo: decryptedRepliedTo,
        createdAt: r.createdAt as string,
        senderId: asUserId(r.senderId),
        sender: {
            id: r.senderId,
            name: decryptedSenderName,
            username: decryptedSenderUsername,
            avatarUrl: decryptedSenderAvatarUrl
        } as unknown as Message['sender'],
        isViewOnce: r.isViewOnce,
        isDeletedLocal: r.isDeletedLocal
      };
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