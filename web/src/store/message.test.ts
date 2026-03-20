import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { decryptMessageObject } from './message';
import * as authStore from '@store/auth';
import * as conversationStore from '@store/conversation';
import * as cryptoUtils from '@utils/crypto';
import type { RawServerMessage, Message } from './conversation';
import { asUserId, asMessageId, asConversationId } from '../types/brands';

// --- MOCK SETUP ---
// ... (previous mocks remain unchanged)

// --- HELPERS ---

const MOCK_USER_ID = asUserId('user_me');
const MOCK_PEER_ID = asUserId('user_peer');
const MOCK_CONV_ID = asConversationId('conv_1');

const createRawMessage = (overrides: Partial<RawServerMessage> = {}): RawServerMessage => ({
  id: asMessageId('msg_123'),
  conversationId: MOCK_CONV_ID,
  senderId: MOCK_PEER_ID,
  createdAt: new Date().toISOString(),
  ciphertext: 'mock_ciphertext_valid_base64_longer_than_20_chars==',
  content: null, // Raw content usually null if encrypted
  ...overrides,
});

describe('Message Store Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup Default Store States
    (authStore.useAuthStore.getState as Mock).mockReturnValue({
      user: { id: MOCK_USER_ID },
    });

    (conversationStore.useConversationStore.getState as Mock).mockReturnValue({
      conversations: [{ id: MOCK_CONV_ID, isGroup: false, participants: [] }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('decryptMessageObject', () => {
    
    it('Happy Path 1: Should strictly transform Incoming 1-on-1 Message', async () => {
      // Setup
      const rawMsg = createRawMessage();
      const mockDecryptedText = 'Hello World';

      (cryptoUtils.decryptMessage as Mock).mockResolvedValue({
        status: 'success',
        value: mockDecryptedText,
      });

      // Act
      const result = await decryptMessageObject(rawMsg);

      // Assert
      expect(result.content).toBe(mockDecryptedText);
      expect(result.id).toBe(rawMsg.id);
      expect((result as unknown as Record<string, unknown>).ciphertext).toBeUndefined(); // Ensure raw props are stripped
      expect(cryptoUtils.decryptMessage).toHaveBeenCalledWith(
        rawMsg.ciphertext,
        rawMsg.conversationId,
        false, // isGroup
        expect.any(String) as unknown as string,
        rawMsg.id
      );
    });

    it('Happy Path 2: Should decrypt Self-Message using local key', async () => {
      // Setup
      const rawMsg = createRawMessage({ senderId: MOCK_USER_ID, ciphertext: 'my_ciphertext' });
      
      // Mock key retrieval success
      (cryptoUtils.retrieveMessageKeySecurely as Mock).mockResolvedValue(new Uint8Array([1, 2, 3]));
      
      // Mock worker proxy directly via import inside the function
      // Since we mocked the module at top level, we can just spy on it via import
      const workerProxy = await import('@lib/crypto-worker-proxy');
      const sodiumLib = await import('@lib/sodiumInitializer');
      
      // Mock sodium behavior specific for this test
      const mockSodium = {
        from_base64: () => new Uint8Array(40), // 24 nonce + 16 cipher
        to_string: () => 'Self Decrypted Content',
        base64_variants: { URLSAFE_NO_PADDING: 0 },
      };
      (sodiumLib.getSodium as Mock).mockResolvedValue(mockSodium);
      (workerProxy.worker_crypto_secretbox_xchacha20poly1305_open_easy as Mock).mockResolvedValue(new Uint8Array([1]));

      // Act
      const result = await decryptMessageObject(rawMsg);

      // Assert
      expect(result.content).toBe('Self Decrypted Content');
      expect(result.senderId).toBe(MOCK_USER_ID);
      // Ensure we didn't call the ratchet decrypt
      expect(cryptoUtils.decryptMessage).not.toHaveBeenCalled(); 
    });

    it('Immutability Check: Should NOT mutate the input object', async () => {
      // Setup
      const rawMsg = createRawMessage();
      Object.freeze(rawMsg); // Freeze deep if possible, but shallow freeze is enough for assignment check

      (cryptoUtils.decryptMessage as Mock).mockResolvedValue({
        status: 'success',
        value: 'Immutable Test',
      });

      // Act
      const result = await decryptMessageObject(rawMsg);

      // Assert
      expect(result).not.toBe(rawMsg); // Must be a new reference
      expect(result.content).toBe('Immutable Test');
      expect(rawMsg.content).toBeNull(); // Original should remain untouched
    });

    it('Edge Case: Should handle decryption failure/pending gracefully', async () => {
      // Setup
      const rawMsg = createRawMessage();
      
      (cryptoUtils.decryptMessage as Mock).mockResolvedValue({
        status: 'pending',
        reason: 'waiting_for_key',
      });

      // Act
      const result = await decryptMessageObject(rawMsg);

      // Assert
      expect(result.content).toBe('waiting_for_key');
      expect(result.type).toBeUndefined(); // Shouldn't be SYSTEM unless it's a fatal error
    });

    it('Edge Case: Should handle Blind Attachment (JSON payload)', async () => {
        // Setup
        const rawMsg = createRawMessage();
        const blindPayload = JSON.stringify({
            type: 'file',
            url: 'blob:http://localhost/xyz',
            name: 'secret.pdf',
            size: 1024,
            mimeType: 'application/pdf'
        });
  
        (cryptoUtils.decryptMessage as Mock).mockResolvedValue({
          status: 'success',
          value: blindPayload,
        });
  
        // Act
        const result = await decryptMessageObject(rawMsg);
  
        // Assert
        expect(result.isBlindAttachment).toBe(true);
        expect(result.fileUrl).toBe('blob:http://localhost/xyz');
        expect(result.fileName).toBe('secret.pdf');
        expect(result.content).toBeNull(); // Content should be consumed/cleared for attachments
      });
  });
});
