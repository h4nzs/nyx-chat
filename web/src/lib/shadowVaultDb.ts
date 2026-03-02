import Dexie, { Table } from 'dexie';
import type { Message } from '@store/conversation';
import { getSodium } from '@lib/sodiumInitializer';
import { getMyEncryptionKeyPair } from '@utils/crypto';

export interface DecryptedMessageRecord {
  id: string;
  conversationId: string;
  content: string; // ENCRYPTED Base64 string at rest
  createdAt: string | Date;
  senderId: string;
  isViewOnce?: boolean;
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
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NONCEBYTES);
  
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
    const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NONCEBYTES;
    
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
    this.version(1).stores({
      messages: 'id, conversationId, createdAt'
    });
  }

  async upsertMessages(messages: Message[]) {
    const validMessages = messages.filter(m => m.content && m.content !== 'waiting_for_key' && !m.content.startsWith('['));
    if (validMessages.length === 0) return;

    try {
      const records: DecryptedMessageRecord[] = [];
      for (const m of validMessages) {
        const encryptedContent = await encryptVaultText(m.content!);
        records.push({
          id: m.id,
          conversationId: m.conversationId,
          content: encryptedContent, // Iron Vault: Stored as cipher
          createdAt: m.createdAt,
          senderId: m.senderId,
          isViewOnce: m.isViewOnce
        });
      }
      await this.messages.bulkPut(records);
    } catch (err) {
      console.error("Iron Vault Encryption Error:", err);
    }
  }
}

export const shadowVault = new NyxShadowVault();