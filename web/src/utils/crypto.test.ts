import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as sodium from 'libsodium-wrappers';
import {
  fulfillKeyRequest,
  storeReceivedSessionKey,
  getMyKeyPair,
  decryptMessage,
  encryptMessage,
} from './crypto';
import * as keychainDb from '@lib/keychainDb';
import * as socket from '@lib/socket';
import * as keyManagement from '@utils/keyManagement';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { decryptMessage } from './crypto';
import * as keychainDb from '@lib/keychainDb';

// --- Mocks ---

// Use vi.hoisted to ensure mocks are created before any imports
const { mockEmitSessionKeyRequest } = vi.hoisted(() => {
  return { mockEmitSessionKeyRequest: vi.fn() };
});

vi.mock('@lib/socket', () => ({
  emitSessionKeyRequest: mockEmitSessionKeyRequest,
}));

vi.mock('@lib/keychainDb', () => ({
  getKeyFromDb: vi.fn(),
}));

// --- Test Suite ---

describe('E2EE Key Synchronization', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('decryptMessage (Trigger)', () => {
    it('should request a key if it is not found locally', async () => {
      // 1. Setup
      // Mock DB to return nothing
      vi.spyOn(keychainDb, 'getKeyFromDb').mockResolvedValue(null);

      // 2. Action
      const result = await decryptMessage('some-cipher-text', 'conv-1', 'session-missing');

      // 3. Assertions
      expect(keychainDb.getKeyFromDb).toHaveBeenCalledWith('conv-1', 'session-missing');
      expect(mockEmitSessionKeyRequest).toHaveBeenCalledWith('conv-1', 'session-missing');
      expect(result).toBe('[Requesting key to decrypt...]');
    });
  });
});
