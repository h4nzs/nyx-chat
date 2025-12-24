import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from './auth';
import { api } from '@lib/api';

// Mock the api module
vi.mock('@lib/api', () => ({
  api: vi.fn(),
  authFetch: vi.fn(),
}));

// Mock the crypto worker proxy module
vi.mock('@lib/crypto-worker-proxy', () => ({
  initializeCryptoWorker: vi.fn().mockResolvedValue(undefined),
  registerAndGenerateKeys: vi.fn().mockResolvedValue({
    encryptionPublicKeyB64: 'mock_enc_pub_key',
    signingPublicKeyB64: 'mock_sign_pub_key',
    encryptedPrivateKeys: 'mock_encrypted_keys',
    phrase: 'mock phrase',
  }),
  retrievePrivateKeys: vi.fn().mockResolvedValue({
    success: true,
    keys: {
      encryption: new Uint8Array(32).fill(1),
      signing: new Uint8Array(64).fill(2),
      signedPreKey: new Uint8Array(32).fill(3),
      masterSeed: new Uint8Array(32).fill(4),
    },
  }),
}));

// Mock other dependencies
vi.mock('@lib/socket', () => ({
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
}));
vi.mock('@lib/sodiumInitializer', () => ({
  getSodium: vi.fn().mockResolvedValue({
    to_base64: (data: any) => `b64_${data}`,
    crypto_sign_detached: () => 'mock_signature',
    crypto_scalarmult_base: (key: any) => `pub_${key}`,
  }),
}));


describe('useAuthStore', () => {
  beforeEach(() => {
    // Reset the store and mocks before each test
    useAuthStore.setState({ user: null, isBootstrapping: true }, true);
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('should set user on successful login', async () => {
    const mockUser = { id: '1', name: 'Test User', email: 'test@test.com', username: 'testuser' };
    vi.mocked(api).mockResolvedValue({ user: mockUser });
    vi.mocked(api.authFetch).mockResolvedValue({}); // Mock the bundle upload

    // Check initial state
    expect(useAuthStore.getState().user).toBeNull();

    // Perform login
    await useAuthStore.getState().login('test@test.com', 'password');

    // Check final state
    expect(useAuthStore.getState().user).toEqual(mockUser);
    expect(localStorage.getItem('user')).toEqual(JSON.stringify(mockUser));
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/auth/login', expect.any(Object));
  });

  it('should set user to null on logout', async () => {
    const mockUser = { id: '1', name: 'Test User', email: 'test@test.com', username: 'testuser' };
    useAuthStore.setState({ user: mockUser });

    // Check initial state
    expect(useAuthStore.getState().user).not.toBeNull();

    // Perform logout
    await useAuthStore.getState().logout();

    // Check final state
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/auth/logout', expect.any(Object));
  });
});
