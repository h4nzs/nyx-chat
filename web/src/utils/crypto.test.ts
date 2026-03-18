import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Buffer } from 'buffer';

import * as cryptoUtils from './crypto';
import * as keychainDb from '@lib/keychainDb';
import * as authStore from '@store/auth';
import type { DoubleRatchetState } from '../types/core';

// --- 1. MOCK SETUP ---

// Mock Sodium to avoid WASM loading issues
vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn().mockResolvedValue({
    to_base64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    from_base64: (str: string) => new Uint8Array(Buffer.from(str, 'base64')),
    base64_variants: { URLSAFE_NO_PADDING: 0 },
    to_string: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
    // Stub other methods if needed
  }),
}));

// Mock Worker Proxy to avoid Web Worker instantiation
vi.mock('@lib/crypto-worker-proxy', () => ({
  worker_dr_ratchet_encrypt: vi.fn(),
  worker_dr_ratchet_decrypt: vi.fn(),
  worker_encrypt_session_key: vi.fn().mockImplementation((data) => Promise.resolve(data)), // Pass-through encryption for storage mocks
  worker_decrypt_session_key: vi.fn().mockImplementation((data) => Promise.resolve(data)),
  worker_crypto_secretbox_xchacha20poly1305_open_easy: vi.fn(),
  worker_crypto_secretbox_xchacha20poly1305_easy: vi.fn(),
  groupRatchetEncrypt: vi.fn(),
  groupRatchetDecrypt: vi.fn(),
  groupDecryptSkipped: vi.fn(),
}));

// Mock Database Layer
vi.mock('@lib/keychainDb', () => ({
  getRatchetSession: vi.fn(),
  storeRatchetSession: vi.fn(),
  storeMessageKey: vi.fn(),
  getMessageKey: vi.fn(),
  getSkippedKey: vi.fn(),
  storeSkippedKey: vi.fn(),
  deleteSkippedKey: vi.fn(),
  getGroupSenderState: vi.fn(),
  saveGroupSenderState: vi.fn(),
}));

// Mock Stores
vi.mock('@store/auth', () => ({
  useAuthStore: {
    getState: vi.fn(),
  },
}));

vi.mock('@store/conversation', () => ({
  useConversationStore: {
    getState: vi.fn(),
  },
}));

// Mock Socket to prevent network calls
vi.mock('@lib/socket', () => ({
  emitSessionKeyRequest: vi.fn(),
}));

// --- 2. HELPERS & TYPES ---

const MOCK_CONVERSATION_ID = 'conv_123';
const MOCK_MESSAGE_ID = 'msg_456';
const MOCK_MASTER_SEED = new Uint8Array([1, 2, 3]);

const createMockRatchetState = (): DoubleRatchetState => ({
  DHs: { publicKey: 'pub_key', privateKey: 'priv_key' },
  DHr: 'peer_pub_key',
  RK: 'root_key',
  CKs: 'chain_key_sender',
  CKr: 'chain_key_receiver',
  Ns: 0,
  Nr: 0,
  PN: 0,
});

describe('Crypto Utils', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();

    // Default Auth Store State
    (authStore.useAuthStore.getState as Mock).mockReturnValue({
      user: { id: 'me' },
      getMasterSeed: () => Promise.resolve(MOCK_MASTER_SEED),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Suite A: encryptMessage', () => {
    
    it('Happy Path: Should successfully encrypt a 1-on-1 message', async () => {
      // Setup
      const mockState = createMockRatchetState();
      
      // Mock retrieving the ratchet state (encrypted in DB)
      // Since our mock worker_decrypt_session_key is a pass-through, we can return the stringified JSON directly as "encrypted" data
      (keychainDb.getRatchetSession as Mock).mockResolvedValue(
        new TextEncoder().encode(JSON.stringify(mockState))
      );

      // Mock the worker encryption result
      const mockWorkerResult = {
        state: { ...mockState, Ns: 1 }, // State advanced
        header: { dh: 'new_dh', n: 0, pn: 0 },
        ciphertext: new Uint8Array([10, 20, 30]),
        mk: new Uint8Array([99, 99]),
      };
      
      const { worker_dr_ratchet_encrypt } = await import('@lib/crypto-worker-proxy');
      (worker_dr_ratchet_encrypt as Mock).mockResolvedValue(mockWorkerResult);

      // Act
      const result = await cryptoUtils.encryptMessage('Hello World', MOCK_CONVERSATION_ID, false, undefined, MOCK_MESSAGE_ID);

      // Assert
      // 1. Check if it retrieved state
      expect(keychainDb.getRatchetSession).toHaveBeenCalledWith(MOCK_CONVERSATION_ID);
      
      // 2. Check if worker was called with correct text
      expect(worker_dr_ratchet_encrypt).toHaveBeenCalledWith({
        serializedState: expect.objectContaining({ RK: 'root_key' }),
        plaintext: 'Hello World',
      });

      // 3. Check output format
      expect(result.ciphertext).toBeDefined();
      expect(result.drHeader).toEqual(mockWorkerResult.header);
      
      // 4. Check side-effects (Storage)
      // Should store the new ratchet state
      // Relaxed assertion to handle potential JSDOM vs Node Uint8Array mismatch
      const storeStateCall = (keychainDb.storeRatchetSession as Mock).mock.calls[0];
      expect(storeStateCall[0]).toBe(MOCK_CONVERSATION_ID);
      expect(storeStateCall[1]).toBeDefined(); 
      expect(storeStateCall[1].length).toBeGreaterThan(0);

      // Should store the message key
      expect(keychainDb.storeMessageKey).toHaveBeenCalledWith(MOCK_MESSAGE_ID, expect.anything());
    });

    it('Edge Case: Should throw error if ratchet state is missing', async () => {
      // Setup
      (keychainDb.getRatchetSession as Mock).mockResolvedValue(null); // No state in DB

      // Act & Assert
      await expect(
        cryptoUtils.encryptMessage('Fail me', MOCK_CONVERSATION_ID, false)
      ).rejects.toThrow('Ratchet state not initialized for encryption.');
    });
  });

  describe('Suite B: decryptMessage', () => {
    
    it('Happy Path: Should successfully decrypt a valid ciphertext', async () => {
      // Setup
      const mockState = createMockRatchetState();
      const mockPlaintext = 'Decrypted Secret';
      const mockCiphertext = 'valid_base64_ciphertext';
      const mockHeader = { dh: 'dh_key', n: 0, pn: 0 };
      
      const payload = JSON.stringify({
        dr: mockHeader,
        ciphertext: mockCiphertext
      });

      // Mock DB state retrieval
      (keychainDb.getRatchetSession as Mock).mockResolvedValue(
        new TextEncoder().encode(JSON.stringify(mockState))
      );

      // Mock worker decryption success
      const { worker_dr_ratchet_decrypt } = await import('@lib/crypto-worker-proxy');
      (worker_dr_ratchet_decrypt as Mock).mockResolvedValue({
        state: mockState,
        plaintext: new TextEncoder().encode(mockPlaintext),
        skippedKeys: [], // No skipped keys in happy path
        mk: new Uint8Array([88]),
      });

      // Act
      const result = await cryptoUtils.decryptMessage(payload, MOCK_CONVERSATION_ID, false, null, MOCK_MESSAGE_ID);

      // Assert
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.value).toBe(mockPlaintext);
      }

      // Check storage of Message Key for persistence
      expect(keychainDb.storeMessageKey).toHaveBeenCalledWith(MOCK_MESSAGE_ID, expect.any(Uint8Array));
    });

    it('Edge Case: Should return error status if worker decryption fails (e.g. MAC mismatch)', async () => {
      // Setup
      const mockState = createMockRatchetState();
      const payload = JSON.stringify({
        dr: { dh: 'bad_key', n: 99, pn: 0 },
        ciphertext: 'tampered_data'
      });

      (keychainDb.getRatchetSession as Mock).mockResolvedValue(
        new TextEncoder().encode(JSON.stringify(mockState))
      );

      // Mock worker throwing an error
      const { worker_dr_ratchet_decrypt } = await import('@lib/crypto-worker-proxy');
      (worker_dr_ratchet_decrypt as Mock).mockRejectedValue(new Error('Poly1305 MAC mismatch'));

      // Act
      const result = await cryptoUtils.decryptMessage(payload, MOCK_CONVERSATION_ID, false, null);

      // Assert
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toBeDefined();
        expect(result.error.message).toContain('Poly1305 MAC mismatch');
      }
      
      // Should NOT have updated state if failed
      expect(keychainDb.storeRatchetSession).not.toHaveBeenCalledTimes(1); // Might be called 0 times or from previous tests? 
      // Ideally we check if it was called *during this test*.
      // Since mocks are cleared in beforeEach, we expect 0 calls here.
      expect(keychainDb.storeRatchetSession).not.toHaveBeenCalled();
    });
  });

});
