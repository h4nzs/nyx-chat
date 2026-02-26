import { createWithEqualityFn } from "zustand/traditional";
import { authFetch, api, apiUpload } from "@lib/api";
import { disconnectSocket, connectSocket } from "@lib/socket";
import { clearAuthCookies } from "@lib/tokenStorage";
import { useModalStore } from "./modal";
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";
import { getEncryptedKeys, saveEncryptedKeys, clearKeys, hasStoredKeys, getDeviceAutoUnlockKey, saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady, getDeviceAutoUnlockReady } from "@lib/keyStorage";
import type { RetrievedKeys } from "@lib/crypto-worker-proxy"; 
import { checkAndRefillOneTimePreKeys, resetOneTimePreKeys } from "@utils/crypto"; 

/**
 * Retrieves the persisted signed pre-key, signs it with the identity signing key,
 * and uploads the bundle to the server.
 * Also checks and refills One-Time Pre-Keys (OTPK).
 */
export async function setupAndUploadPreKeyBundle() {
  try {
    const { getSodium } = await import('@lib/sodiumInitializer');
    
    const { getSigningPrivateKey, getEncryptionKeyPair, getSignedPreKeyPair } = useAuthStore.getState();

    const sodium = await getSodium();
    const signingPrivateKey = await getSigningPrivateKey();
    const { publicKey: identityKey } = await getEncryptionKeyPair();
    const { publicKey: signedPreKey } = await getSignedPreKeyPair();

    const identityKeyB64 = sodium.to_base64(identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const signingPublicKey = signingPrivateKey.slice(32);

    const signature = sodium.crypto_sign_detached(signedPreKey, signingPrivateKey);

    const bundle = {
      identityKey: identityKeyB64,
      signingKey: sodium.to_base64(signingPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      signedPreKey: {
        key: sodium.to_base64(signedPreKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        signature: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING),
      },
    };
    await authFetch("/api/keys/prekey-bundle", {
      method: "POST",
      body: JSON.stringify(bundle),
    });

    await checkAndRefillOneTimePreKeys();

  } catch (e) {
    console.error("Failed to set up and upload pre-key bundle:", e);
  }
}

export type User = {
  id: string;
  encryptedProfile?: string | null;
  role?: string;
  isVerified?: boolean; // Trust Tier (WebAuthn)
  hasCompletedOnboarding?: boolean;
};

type State = {
  user: User | null;
  accessToken: string | null;
  isLoading: boolean;
  isBootstrapping: boolean;
  isInitializingCrypto: boolean;
  sendReadReceipts: boolean;
  hasRestoredKeys: boolean;
  blockedUserIds: string[];
};

type RegisterResponse = {
  phrase: string;
  userId: string;
};

type Actions = {
  bootstrap: () => Promise<void>;
  tryAutoUnlock: () => Promise<boolean>;
  login: (usernameHash: string, password: string, restoredNotSynced?: boolean) => Promise<void>;
  registerAndGeneratePhrase: (data: { 
    encryptedProfile: string; 
    usernameHash: string; // Blind Index
    password: string; 
    turnstileToken?: string; 
  }) => Promise<RegisterResponse>;
  
  logout: () => Promise<void>;
  getEncryptionKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getSigningPrivateKey: () => Promise<Uint8Array>;
  getSignedPreKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getMasterSeed: () => Promise<Uint8Array | undefined>;
  setUser: (user: User) => void;
  setAccessToken: (token: string | null) => void;
  updateProfile: (data: { encryptedProfile: string }) => Promise<void>;
  updateAvatar: (avatar: File) => Promise<string>;
  setReadReceipts: (value: boolean) => void;
  setHasRestoredKeys: (hasKeys: boolean) => void;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  loadBlockedUsers: () => Promise<void>;
  setDecryptedKeys: (keys: RetrievedKeys) => void;
};

let privateKeysCache: RetrievedKeys | null = null;

export const useAuthStore = createWithEqualityFn<State & Actions>((set, get) => {
  const savedUser = localStorage.getItem("user");
  const savedReadReceipts = localStorage.getItem('sendReadReceipts');

  const retrieveAndCacheKeys = async (): Promise<RetrievedKeys> => {
    if (privateKeysCache) return privateKeysCache;

    const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');

    let autoUnlockKey: string | undefined | null = null;
    let encryptedKeys: string | undefined | null = null;

    try {
      autoUnlockKey = await getDeviceAutoUnlockKey();
      encryptedKeys = await getEncryptedKeys();
    } catch (e) {
      console.error("Failed to read keys/auto-unlock info:", e);
    }

    if (autoUnlockKey && encryptedKeys) {
      try {
        const result = await retrievePrivateKeys(encryptedKeys, autoUnlockKey);
        if (result.success) {
          privateKeysCache = result.keys;
          return result.keys;
        }
      } catch (e) {}
    }

    const promptForPassword = async (retrieveFn: typeof retrievePrivateKeys): Promise<RetrievedKeys> => {
      return new Promise((resolve, reject) => {
        let unsubscribe: () => void;
        const cleanup = () => { if (unsubscribe) unsubscribe(); };

        unsubscribe = useModalStore.subscribe((state) => {
          if (!state.isPasswordPromptOpen) {
            cleanup();
            setTimeout(() => {
               reject(new Error("Password prompt closed without input."));
            }, 100);
          }
        });

        useModalStore.getState().showPasswordPrompt(async (password) => {
          cleanup();
          if (!password) { reject(new Error("Password not provided.")); return; }

          try {
            const keysInner = await getEncryptedKeys();
            if (!keysInner) { reject(new Error("Encrypted private keys not found.")); return; }

            const result = await retrieveFn(keysInner, password);
            if (!result.success) {
              const reason = result.reason === 'incorrect_password' ? "Incorrect password." : `Failed to retrieve keys: ${result.reason}`;
              reject(new Error(reason));
              return;
            }

            privateKeysCache = result.keys;
            resolve(result.keys);
          } catch (e) { reject(e); }
        });
      });
    };

    return promptForPassword(retrievePrivateKeys);
  };

  return {
    user: savedUser ? JSON.parse(savedUser) : null,
    accessToken: null,
    isLoading: false,
    isBootstrapping: true,
    isInitializingCrypto: false,
    sendReadReceipts: savedReadReceipts ? JSON.parse(savedReadReceipts) : true,
    hasRestoredKeys: false,
    blockedUserIds: [],

    setHasRestoredKeys: async (hasKeys) => set({ hasRestoredKeys: await hasStoredKeys() }),
    setAccessToken: (token) => set({ accessToken: token }),
    setReadReceipts: (value) => {
      set({ sendReadReceipts: value });
      localStorage.setItem('sendReadReceipts', JSON.stringify(value));
    },

    tryAutoUnlock: async () => {
      const autoUnlockKey = await getDeviceAutoUnlockKey();
      const encryptedKeys = await getEncryptedKeys();

      if (autoUnlockKey && encryptedKeys) {
        set({ isInitializingCrypto: true });
        try {
          const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
          const result = await retrievePrivateKeys(encryptedKeys, autoUnlockKey);
          if (result.success) {
            privateKeysCache = result.keys;
            set({ hasRestoredKeys: true });
            await setDeviceAutoUnlockReady(true);
            return true;
          }
        } catch (e) { console.error("Error during auto-unlock:", e); } finally { set({ isInitializingCrypto: false }); }
      }
      return false;
    },

    setDecryptedKeys: async (keys: RetrievedKeys) => {
      privateKeysCache = keys;
      set({ hasRestoredKeys: true });
      await setDeviceAutoUnlockReady(true);
    },

    bootstrap: async () => {
      if (get().accessToken) {
        set({ isBootstrapping: false });
        return;
      }

      set({ isBootstrapping: true });
      try {
        const refreshRes = await api<{ ok: boolean; accessToken?: string }>("/api/auth/refresh", { method: "POST" });
        if (refreshRes.accessToken) {
          set({ accessToken: refreshRes.accessToken });

          const me = await authFetch<User>("/api/users/me");
          set({ user: me, hasRestoredKeys: await hasStoredKeys() });
          localStorage.setItem("user", JSON.stringify(me));

          await get().tryAutoUnlock();
          connectSocket();
          get().loadBlockedUsers();
        } else {
          throw new Error("No valid session.");
        }
      } catch (error: any) {
        console.log("Bootstrap failed (No session):", error);
        privateKeysCache = null;
        set({ user: null, accessToken: null, blockedUserIds: [] });
        clearAuthCookies();
        localStorage.removeItem("user");
      } finally {
        set({ isBootstrapping: false });
      }
    },

    login: async (usernameHash, password, restoredNotSynced = false) => {
      privateKeysCache = null;
      set({ isInitializingCrypto: true });

      try {
        const res = await api<{ user: User; accessToken: string; encryptedPrivateKey?: string }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ usernameHash, password }),
        });

        if (res.encryptedPrivateKey) {
          await saveEncryptedKeys(res.encryptedPrivateKey);
          await saveDeviceAutoUnlockKey(password);
          await setDeviceAutoUnlockReady(true);
          set({ hasRestoredKeys: true });
        }

        const hasKeys = await hasStoredKeys();
        set({ user: res.user, accessToken: res.accessToken, hasRestoredKeys: hasKeys, blockedUserIds: [] });
        localStorage.setItem("user", JSON.stringify(res.user));

        if (hasKeys) {
          try {
            const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
            const encryptedKeys = await getEncryptedKeys();
            const result = await retrievePrivateKeys(encryptedKeys!, password);

            if (result.success) {
              privateKeysCache = result.keys;
              await saveDeviceAutoUnlockKey(password);
              await setDeviceAutoUnlockReady(true);
            } else {
              throw new Error(`Login successful, but failed to decrypt keys: ${result.reason}`);
            }
          } catch (e) {
            console.error("Failed to decrypt keys on login:", e);
            toast.error("Could not decrypt your stored keys. Please restore your account if the password has changed.");
          }
        }

        get().loadBlockedUsers();

        if (restoredNotSynced) {
          try { await setupAndUploadPreKeyBundle(); } catch(e) { console.error("Failed to sync restored keys:", e); }
        } else if (get().hasRestoredKeys) {
          setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload pre-key bundle on login:", e));
        } else {
          toast("To enable secure messaging, restore your account from your recovery phrase in Settings.", { duration: 7000 });
        }

        try { await resetOneTimePreKeys(); } catch (e) { console.error("Reset OTPK failed:", e); }
        connectSocket();
      } catch (error: any) {
        console.error("Login error:", error);
        set({ user: null, accessToken: null });
        throw error;
      } finally {
        set({ isInitializingCrypto: false });
      }
    },

    registerAndGeneratePhrase: async ({ encryptedProfile, usernameHash, password, turnstileToken }) => {
      set({ isInitializingCrypto: true });
      try {
        const { registerAndGenerateKeys, retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
        const {
          encryptionPublicKeyB64,
          signingPublicKeyB64,
          encryptedPrivateKeys,
          phrase
        } = await registerAndGenerateKeys(password);

        await saveEncryptedKeys(encryptedPrivateKeys);
        await saveDeviceAutoUnlockKey(password);
        await setDeviceAutoUnlockReady(true);
        set({ hasRestoredKeys: true });

        // Cache keys
        try {
          const result = await retrievePrivateKeys(encryptedPrivateKeys, password);
          if (result.success) privateKeysCache = result.keys;
        } catch (e) {}

        const res = await api<{ accessToken: string; user: User }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            usernameHash,
            password,
            encryptedProfile,
            publicKey: encryptionPublicKeyB64,
            signingKey: signingPublicKeyB64,
            encryptedPrivateKeys,
            turnstileToken
          }),
        });

        set({ user: res.user, accessToken: res.accessToken });
        localStorage.setItem("user", JSON.stringify(res.user));
        
        setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload initial pre-key bundle:", e));
        connectSocket();

        return { phrase, userId: res.user.id };
      } finally {
        set({ isInitializingCrypto: false });
      }
    },

    logout: async () => {
      try {
        if ('serviceWorker' in navigator && 'PushManager' in window) {
           const registration = await navigator.serviceWorker.ready;
           const subscription = await registration.pushManager.getSubscription();
           if (subscription) {
             const endpoint = subscription.endpoint;
             await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ endpoint }) }).catch(() => {});
             await subscription.unsubscribe();
           } else {
             await api("/api/auth/logout", { method: "POST" }).catch(() => {});
           }
        } else {
           await api("/api/auth/logout", { method: "POST" }).catch(() => {});
        }
      } catch (e) { console.error("Logout error", e); } finally {
        clearAuthCookies();
        privateKeysCache = null;
        await clearKeys(); 
        localStorage.removeItem('user');
        set({ user: null, accessToken: null });
        disconnectSocket();
        useConversationStore.getState().reset();
        useMessageStore.getState().reset();
      }
    },

    updateProfile: async (data) => {
      // Data is expected to be { encryptedProfile: string } now
      const updatedUser = await authFetch<User>('/api/users/me', {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      set(state => {
        const newUser = { ...state.user!, ...updatedUser };
        localStorage.setItem("user", JSON.stringify(newUser));
        return { user: newUser };
      });
      toast.success('Profile updated!');
    },

    updateAvatar: async (avatar: File) => {
      // Avatar upload is tricky because it needs to update the encrypted profile.
      // For now, just upload the file and return. The UI needs to handle updating the profile JSON.
      const toastId = toast.loading('Processing avatar...');
      const { compressImage } = await import('@lib/fileUtils');
      const { uploadToR2 } = await import('@lib/r2');
      let fileToProcess = avatar;
      if (avatar.type.startsWith('image/')) {
        try { fileToProcess = await compressImage(avatar); } catch (e) {}
      }
      try {
        toast.loading('Uploading to Cloud...', { id: toastId });
        const fileUrl = await uploadToR2(fileToProcess, 'avatars', () => {});
        toast.success('Avatar uploaded! (Profile update required)', { id: toastId });
        // NOTE: We do not call API to save avatarUrl directly anymore.
        // The caller must update their local profile JSON and call updateProfile.
        return fileUrl as any; // Returning the URL so caller can use it
      } catch (e: any) {
        console.error(e);
        toast.error(`Update failed: ${e.message}`, { id: toastId });
        throw e;
      }
    },

    async getMasterSeed() {
      const keys = await retrieveAndCacheKeys();
      return keys.masterSeed;
    },
    async getSigningPrivateKey() {
      const keys = await retrieveAndCacheKeys();
      return keys.signing;
    },
    async getEncryptionKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodium } = await import('@lib/sodiumInitializer');
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.encryption);
      return { publicKey, privateKey: keys.encryption };
    },
    async getSignedPreKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodium } = await import('@lib/sodiumInitializer');
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.signedPreKey);
      return { publicKey, privateKey: keys.signedPreKey };
    },
    setUser: (user) => {
      set({ user });
      localStorage.setItem("user", JSON.stringify(user));
    },

    blockUser: async (userId) => {
      const toastId = toast.loading('Blocking user...');
      try {
        await authFetch(`/api/users/${userId}/block`, { method: 'POST' });
        toast.success('User blocked', { id: toastId });
        set(state => ({ blockedUserIds: [...state.blockedUserIds, userId] }));
      } catch (error: any) {
        const errorMsg = error.details ? JSON.parse(error.details).error : error.message;
        toast.error(`Block failed: ${errorMsg}`, { id: toastId });
        throw error;
      }
    },

    unblockUser: async (userId) => {
      const toastId = toast.loading('Unblocking user...');
      try {
        await authFetch(`/api/users/${userId}/block`, { method: 'DELETE' });
        toast.success('User unblocked', { id: toastId });
        set(state => ({ blockedUserIds: state.blockedUserIds.filter(id => id !== userId) }));
      } catch (error: any) {
        const errorMsg = error.details ? JSON.parse(error.details).error : error.message;
        toast.error(`Unblock failed: ${errorMsg}`, { id: toastId });
        throw error;
      }
    },

    loadBlockedUsers: async () => {
      try {
        const blockedUsers = await authFetch<{ id: string }[]>('/api/users/me/blocked');
        const blockedIds = blockedUsers.map(user => user.id);
        set({ blockedUserIds: blockedIds });
      } catch (error) {
        console.error('Failed to load blocked users:', error);
      }
    },
  };
}, Object.is);
