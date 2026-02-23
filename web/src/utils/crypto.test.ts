import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { decryptMessage } from './crypto';
import * as keychainDb from '@lib/keychainDb';
import * as socket from '@lib/socket';
import * as api from '@lib/api';
import * as authStore from '@store/auth';

// --- Mocks ---

vi.mock('@lib/socket');
vi.mock('@lib/keychainDb');
vi.mock('@lib/api');
vi.mock('@store/auth');

// Mock the crypto worker proxy
vi.mock('@lib/crypto-worker-proxy', () => ({
  worker_crypto_secretbox_xchacha20poly1305_open_easy: vi.fn(),
  // Add other functions if they are needed for tests
}));

describe('crypto.ts', () => {

  beforeEach(() => {
    // Mock the auth store getter for key pairs
    vi.spyOn(authStore, 'useAuthStore').mockReturnValue({
      getState: () => ({
        getEncryptionKeyPair: () => Promise.resolve({
          publicKey: new Uint8Array(32).fill(1),
          privateKey: new Uint8Array(32).fill(2),
        }),
        getSignedPreKeyPair: () => Promise.resolve({
            publicKey: new Uint8Array(32).fill(3),
            privateKey: new Uint8Array(32).fill(4),
          }),
      })
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('decryptMessage', () => {
    it('should request a key via socket if it is not found locally and cannot be derived from the server', async () => {
      // 1. Setup
      // Mock DB to return nothing, indicating no local key
      const getKeySpy = vi.spyOn(keychainDb, 'getSessionKey').mockResolvedValue(null);
      
      // Mock API call to fail, indicating the server also doesn't have a derivable session
      const authFetchSpy = vi.spyOn(api, 'authFetch').mockRejectedValue(new Error("No initial session found."));

      // 2. Action
      const result = await decryptMessage('some-cipher-text', 'conv-1', false, 'session-missing');

      // 3. Assertions
      // It should have tried to get the key from the DB
      expect(getKeySpy).toHaveBeenCalledWith('conv-1', 'session-missing');
      
      // It should have tried to fetch the initial session from the API
      // This is no longer the behavior, so we remove this expectation
      // expect(authFetchSpy).toHaveBeenCalledWith('/api/keys/initial-session/conv-1/session-missing');
      
      // Because both failed, it should fall back to requesting the key from a peer via socket
      expect(socket.emitSessionKeyRequest).toHaveBeenCalledWith('conv-1', 'session-missing');
      
      // The function should return a 'pending' status to the UI
      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.reason).toBe('[Requesting key to decrypt...]');
      }
    });

    it('should return the decrypted message if the key is found locally', async () => {
        // 1. Setup
        const mockKey = new Uint8Array(32).fill(5);
        const mockDecryptedText = 'hello world';
        vi.spyOn(keychainDb, 'getSessionKey').mockResolvedValue(mockKey);
        
        // Mock the worker function to successfully decrypt
        const cryptoProxy = await import('@lib/crypto-worker-proxy');
        vi.spyOn(cryptoProxy, 'worker_crypto_secretbox_xchacha20poly1305_open_easy').mockResolvedValue(new TextEncoder().encode(mockDecryptedText));
        
        // Mock sodium for the final `to_string` conversion
        const sodium = await import('@lib/sodiumInitializer');
        vi.spyOn(sodium, 'getSodium').mockResolvedValue({
            from_base64: () => new Uint8Array(64), // Dummy value
            to_string: (val: Uint8Array) => new TextDecoder().decode(val), // Real implementation
            crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: 24, // Mock constant
        } as any);

        // 2. Action
        // The cipher text doesn't matter here as the decryption is mocked
        const result = await decryptMessage('some-cipher-text-base64', 'conv-1', false, 'session-exists');
  
        // 3. Assertions
        expect(keychainDb.getSessionKey).toHaveBeenCalledWith('conv-1', 'session-exists');
        expect(cryptoProxy.worker_crypto_secretbox_xchacha20poly1305_open_easy).toHaveBeenCalled();
        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.value).toBe(mockDecryptedText);
        }
      });
  });
});
