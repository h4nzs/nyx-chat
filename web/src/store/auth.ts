import { createWithEqualityFn } from "zustand/traditional";
import { authFetch, api } from "@lib/api";
import { disconnectSocket, connectSocket } from "@lib/socket";
import { clearAuthCookies } from "@lib/tokenStorage";
// import { getSodium } from '@lib/sodiumInitializer'; // Removed top-level import
import { useModalStore } from "./modal";
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";
import { getEncryptedKeys, saveEncryptedKeys, clearKeys, hasStoredKeys, getDeviceAutoUnlockKey, saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady, getDeviceAutoUnlockReady } from "@lib/keyStorage";
import type { RetrievedKeys } from "@lib/crypto-worker-proxy"; // Only import TYPE

/**
 * Retrieves the persisted signed pre-key, signs it with the identity signing key,
 * and uploads the bundle to the server.
 */
export async function setupAndUploadPreKeyBundle() {
  try {
    // Dynamic imports
    const { getSodium } = await import('@lib/sodiumInitializer');
    
    const { getSigningPrivateKey, getEncryptionKeyPair, getSignedPreKeyPair } = useAuthStore.getState();

    const sodium = await getSodium();
    const signingPrivateKey = await getSigningPrivateKey();
    const { publicKey: identityKey } = await getEncryptionKeyPair();
    const { publicKey: signedPreKey } = await getSignedPreKeyPair();

    const identityKeyB64 = sodium.to_base64(identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    // The public key is the last 32 bytes of the 64-byte secret key.
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
  } catch (e) {
    console.error("Failed to set up and upload pre-key bundle:", e);
  }
}

export type User = {
  id: string;
  email: string;
  username: string;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  hasCompletedOnboarding?: boolean;
  showEmailToOthers?: boolean;
  role?: string;
};

type State = {
  user: User | null;
  accessToken: string | null;
  isBootstrapping: boolean;
  isInitializingCrypto: boolean; // New state
  sendReadReceipts: boolean;
  hasRestoredKeys: boolean;
};

type RegisterResponse = {
  phrase: string;
  needVerification: boolean;
  userId?: string;
  email?: string;
};

type Actions = {
  bootstrap: () => Promise<void>;
  tryAutoUnlock: () => Promise<boolean>;
  login: (emailOrUsername: string, password: string, restoredNotSynced?: boolean) => Promise<void>;
  registerAndGeneratePhrase: (data: any) => Promise<RegisterResponse>; 
  verifyEmail: (userId: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  getEncryptionKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getSigningPrivateKey: () => Promise<Uint8Array>;
  getSignedPreKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getMasterSeed: () => Promise<Uint8Array | undefined>;
  setUser: (user: User) => void;
  setAccessToken: (token: string | null) => void;
  updateProfile: (data: Partial<Pick<User, 'name' | 'description' | 'showEmailToOthers'>>) => Promise<void>;
  updateAvatar: (avatar: File) => Promise<void>;
  setReadReceipts: (value: boolean) => void;
  setHasRestoredKeys: (hasKeys: boolean) => void;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  loadBlockedUsers: () => Promise<void>;
  blockedUserIds: string[];
  setDecryptedKeys: (keys: RetrievedKeys) => void;
};

let privateKeysCache: RetrievedKeys | null = null;

export const useAuthStore = createWithEqualityFn<State & Actions>((set, get) => {
  const savedUser = localStorage.getItem("user"); // User is still in localStorage
  const savedReadReceipts = localStorage.getItem('sendReadReceipts');

  const retrieveAndCacheKeys = async (): Promise<RetrievedKeys> => {
    if (privateKeysCache) return privateKeysCache;

    // Dynamic import for retrievePrivateKeys
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
      } catch (e) {
        // Fall through to password prompt
      }
    }

    // Helper to wrap the modal prompt in a Promise
    const promptForPassword = async (retrieveFn: typeof retrievePrivateKeys): Promise<RetrievedKeys> => {
      return new Promise((resolve, reject) => {
        useModalStore.getState().showPasswordPrompt(async (password) => {
          if (!password) {
            reject(new Error("Password not provided."));
            return;
          }

          try {
            const keysInner = await getEncryptedKeys();
            if (!keysInner) {
              reject(new Error("Encrypted private keys not found."));
              return;
            }

            const result = await retrieveFn(keysInner, password);
            if (!result.success) {
              const reason = result.reason === 'incorrect_password' ? "Incorrect password." : `Failed to retrieve keys: ${result.reason}`;
              reject(new Error(reason));
              return;
            }

            privateKeysCache = result.keys;
            resolve(result.keys);
          } catch (e) {
            reject(e);
          }
        });
      });
    };

    return promptForPassword(retrievePrivateKeys);
  };

  return {
    user: savedUser ? JSON.parse(savedUser) : null,
    accessToken: null,
    isBootstrapping: true,
    isInitializingCrypto: false,
    sendReadReceipts: savedReadReceipts ? JSON.parse(savedReadReceipts) : true,
    hasRestoredKeys: false, // Initial state, will be updated by bootstrap
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
          console.error("Auto-unlock failed.");
        } catch (e) {
           console.error("Error during auto-unlock:", e);
        } finally {
          set({ isInitializingCrypto: false });
        }
      }
      return false;
    },

    setDecryptedKeys: async (keys: RetrievedKeys) => {
      privateKeysCache = keys;
      set({ hasRestoredKeys: true });
      await setDeviceAutoUnlockReady(true);
    },

    bootstrap: async () => {
      // [FIX] Cek apakah kita baru saja register/login manual?
      // Jika accessToken sudah ada (dari register), jangan bootstrap dulu biar gak tabrakan.
      if (get().accessToken) {
        console.log("Bootstrap skipped: Session already active from register/login.");
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

          // Only load crypto if we have a valid session
          await get().tryAutoUnlock();
          connectSocket();

          get().loadBlockedUsers();
        } else {
          throw new Error("No valid session.");
        }
      } catch (error: any) {
        console.log("Bootstrap failed (No session):", error);
        // [FIX] Jangan panggil logout() atau clearKeys() di sini!
        // Cukup bersihkan state memori & localstorage user, TAPI JANGAN hapus kunci IndexedDB.
        privateKeysCache = null;
        set({ user: null, accessToken: null, blockedUserIds: [] });
        clearAuthCookies();
        localStorage.removeItem("user");
      } finally {
        set({ isBootstrapping: false });
      }
    },

    login: async (emailOrUsername, password, restoredNotSynced = false) => {
      privateKeysCache = null;
      set({ isInitializingCrypto: true }); // Show loading for crypto init

      try {
        const res = await api<{ user: User; accessToken: string; encryptedPrivateKey?: string }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ emailOrUsername, password }),
        });

        // [SYNC] Restore Encrypted Keys from Server if available
        if (res.encryptedPrivateKey) {
          console.log("[Auth] Restoring encrypted keys from server backup...");
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
            // Dynamic import
            const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
            
            const encryptedKeys = await getEncryptedKeys();
            const isAutoUnlockReady = await getDeviceAutoUnlockReady();
            let result;

            if (isAutoUnlockReady) {
               result = await retrievePrivateKeys(encryptedKeys!, password);
            } else {
               result = await retrievePrivateKeys(encryptedKeys!, password);
            }

            if (result.success) {
              privateKeysCache = result.keys;
              // If decryption was successful with a password, save it as the auto-unlock key for next time.
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
          try {
            await setupAndUploadPreKeyBundle();
          } catch(e) {
            console.error("Failed to sync restored keys with server:", e);
          }
        } else if (get().hasRestoredKeys) {
          setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload pre-key bundle on login:", e));
        } else {
          toast("To enable secure messaging, restore your account from your recovery phrase in Settings.", { duration: 7000 });
        }

        connectSocket();
      } catch (error: any) {
        console.error("Login error:", error);
        if (error.message && error.message.includes("Email not verified")) {
          const isEmail = emailOrUsername.includes('@');
          try {
            let userData: User | null = null;
            if (isEmail) {
              userData = await api<User>(`/api/users/by-email?email=${encodeURIComponent(emailOrUsername)}`);
            } else {
              userData = await api<User>(`/api/users/by-username?username=${encodeURIComponent(emailOrUsername)}`);
            }

            if (userData?.id && userData?.email) {
              import('@utils/verificationPersistence').then(({ saveVerificationState }) => {
                saveVerificationState({
                  userId: userData!.id,
                  email: userData!.email!,
                  timestamp: Date.now()
                });
              });
            }
          } catch (userFetchErr) {
            console.error("Could not fetch user details for verification persistence:", userFetchErr);
          }
        }
        set({ user: null, accessToken: null });
        throw error;
      } finally {
        set({ isInitializingCrypto: false });
      }
    },

    registerAndGeneratePhrase: async (data) => {
      set({ isInitializingCrypto: true });
      try {
        // Dynamic Import
        const { registerAndGenerateKeys, retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');

        const {
          encryptionPublicKeyB64,
          signingPublicKeyB64,
          encryptedPrivateKeys,
          phrase
        } = await registerAndGenerateKeys(data.password);

        // 1. Simpan Kunci Terenkripsi ke IndexedDB
        await saveEncryptedKeys(encryptedPrivateKeys);
        
        // [FIX] 2. Simpan Kunci Auto-Unlock (Biar ga minta password lagi pas refresh/chat)
        await saveDeviceAutoUnlockKey(data.password);
        await setDeviceAutoUnlockReady(true);

        set({ hasRestoredKeys: true });

        // 3. Cache di memori untuk sesi sekarang
        try {
          const result = await retrievePrivateKeys(encryptedPrivateKeys, data.password);
          if (result.success) {
             privateKeysCache = result.keys;
          }
        } catch (e) { console.error("Failed to cache keys:", e); }

        // 4. Panggil API Register
        const res = await api<{ 
          user?: User; 
          accessToken?: string; 
          message?: string; 
          needVerification?: boolean;
          userId?: string; 
        }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            ...data,
            publicKey: encryptionPublicKeyB64,
            signingKey: signingPublicKeyB64,
            encryptedPrivateKeys // Upload kunci terenkripsi ke server
          }),
        });

        if (res.needVerification && res.userId) {
          return { 
            phrase, 
            needVerification: true, 
            userId: res.userId, 
            email: data.email 
          };
        }

        if (res.user && res.accessToken) {
          set({ user: res.user, accessToken: res.accessToken });
          localStorage.setItem("user", JSON.stringify(res.user));
          setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload initial pre-key bundle:", e));
          connectSocket();
          return { phrase, needVerification: false };
        }

        throw new Error("Unexpected response from registration.");
      } finally {
        set({ isInitializingCrypto: false });
      }
    },

    verifyEmail: async (userId, code) => {
      const res = await api<{ user: User; accessToken: string }>("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ userId, code }),
      });

      if (res.user && res.accessToken) {
        set({ user: res.user, accessToken: res.accessToken });
        localStorage.setItem("user", JSON.stringify(res.user));
        
        // [FIX] Ensure app knows keys are present and loaded
        set({ hasRestoredKeys: true });
        await get().tryAutoUnlock(); 

        // Public keys and encrypted keys are already saved during registerAndGeneratePhrase
        setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload initial pre-key bundle:", e));
        connectSocket();
      }
    },

    resendVerification: async (email) => {
      try {
        await api("/api/auth/resend-verification", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        toast.success("Verification code resent!");
      } catch (error: any) {
        console.error("Failed to resend verification code:", error);
        throw error;
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
      } catch (e) {
        console.error("Logout error", e);
      } finally {
        clearAuthCookies();
        privateKeysCache = null;
        
        // [FIX] Clear keys BEFORE removing user, because getDb() needs the userId from localStorage
        await clearKeys(); 
        
        localStorage.removeItem('user');

        set({ user: null, accessToken: null });

        disconnectSocket();
        useConversationStore.getState().reset();
        useMessageStore.getState().reset();
      }
    },

    updateProfile: async (data) => {
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
      const toastId = toast.loading('Processing avatar...');
      
      // Dynamic imports
      const { compressImage } = await import('@lib/fileUtils');
      const { uploadToR2 } = await import('@lib/r2');

      let fileToProcess = avatar;

      if (avatar.type.startsWith('image/')) {
        try {
          fileToProcess = await compressImage(avatar);
        } catch (e) {
          // Fallback, do nothing
        }
      }

      try {
        toast.loading('Uploading to Cloud...', { id: toastId });
        
        const fileUrl = await uploadToR2(fileToProcess, 'avatars', (percent) => {
           // Optional progress
        });

        toast.loading('Saving profile...', { id: toastId });
        
        const updatedUser = await authFetch<User>('/api/uploads/avatars/save', {
          method: 'POST',
          body: JSON.stringify({ fileUrl }),
        });
        
        set({ user: updatedUser });
        localStorage.setItem("user", JSON.stringify(updatedUser));
        toast.success('Avatar updated!', { id: toastId });

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
      const { getSodium } = await import('@lib/sodiumInitializer'); // Dynamic
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.encryption);
      return { publicKey, privateKey: keys.encryption };
    },
    async getSignedPreKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodium } = await import('@lib/sodiumInitializer'); // Dynamic
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
        await authFetch(`/api/users/${userId}/block`, {
          method: 'POST'
        });
        toast.success('User blocked', { id: toastId });

        set(state => ({
          blockedUserIds: [...state.blockedUserIds, userId]
        }));
      } catch (error: any) {
        const errorMsg = error.details ? JSON.parse(error.details).error : error.message;
        toast.error(`Block failed: ${errorMsg}`, { id: toastId });
        throw error;
      }
    },

    unblockUser: async (userId) => {
      const toastId = toast.loading('Unblocking user...');
      try {
        await authFetch(`/api/users/${userId}/block`, {
          method: 'DELETE'
        });
        toast.success('User unblocked', { id: toastId });

        set(state => ({
          blockedUserIds: state.blockedUserIds.filter(id => id !== userId)
        }));
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