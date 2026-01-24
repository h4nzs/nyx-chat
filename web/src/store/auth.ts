import { createWithEqualityFn } from "zustand/traditional";
import { authFetch, api } from "@lib/api";
import { disconnectSocket, connectSocket } from "@lib/socket";
import { clearAuthCookies } from "@lib/tokenStorage";
import { getSodium } from '@lib/sodiumInitializer';
import { useModalStore } from "./modal";
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";
import { uploadToR2 } from "@lib/r2"; // <--- Helper Upload R2
import { compressImage } from "@lib/fileUtils"; // Helper Kompresi
import { 
  registerAndGenerateKeys,
  retrievePrivateKeys,
  type RetrievedKeys,
} from "@lib/crypto-worker-proxy";

/**
 * Retrieves the persisted signed pre-key, signs it with the identity signing key,
 * and uploads the bundle to the server.
 */
export async function setupAndUploadPreKeyBundle() {
  try {
    const { getSigningPrivateKey, getEncryptionKeyPair, getSignedPreKeyPair } = useAuthStore.getState();

    const sodium = await getSodium();
    const signingPrivateKey = await getSigningPrivateKey();
    const { publicKey: identityKey } = await getEncryptionKeyPair();
    const { publicKey: signedPreKey } = await getSignedPreKeyPair();

    const identityKeyB64 = sodium.to_base64(identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    localStorage.setItem('publicKey', identityKeyB64);

    const signature = sodium.crypto_sign_detached(signedPreKey, signingPrivateKey);

    const bundle = {
      identityKey: identityKeyB64,
      signedPreKey: {
        key: sodium.to_base64(signedPreKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        signature: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING),
      },
    };
    await authFetch("/api/keys/prekey-bundle", {
      method: "POST",
      body: JSON.stringify(bundle),
    });
    console.log("Pre-key bundle uploaded successfully.");
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
};

type State = {
  user: User | null;
  accessToken: string | null;
  isBootstrapping: boolean;
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
};

const savedUser = localStorage.getItem("user");
const savedReadReceipts = localStorage.getItem('sendReadReceipts');

let privateKeysCache: RetrievedKeys | null = null;

export const useAuthStore = createWithEqualityFn<State & Actions>((set, get) => {
  const retrieveAndCacheKeys = (): Promise<RetrievedKeys> => {
    if (privateKeysCache) return Promise.resolve(privateKeysCache);

    return new Promise((resolve, reject) => {
      const autoUnlockKey = localStorage.getItem('device_auto_unlock_key');
      const encryptedKeys = localStorage.getItem('encryptedPrivateKeys');

      if (autoUnlockKey && encryptedKeys) {
        retrievePrivateKeys(encryptedKeys, autoUnlockKey)
          .then((result) => {
            if (result.success) {
              privateKeysCache = result.keys;
              resolve(result.keys);
            } else {
              promptForPassword();
            }
          })
          .catch(() => promptForPassword());
      } else {
        promptForPassword();
      }

      function promptForPassword() {
        useModalStore.getState().showPasswordPrompt(async (password) => {
          if (!password) return reject(new Error("Password not provided."));

          const encryptedKeysInner = localStorage.getItem('encryptedPrivateKeys');
          if (!encryptedKeysInner) return reject(new Error("Encrypted private keys not found."));

          const result = await retrievePrivateKeys(encryptedKeysInner, password);

          if (!result.success) {
            const reason = result.reason === 'incorrect_password' ? "Incorrect password." : `Failed to retrieve keys: ${result.reason}`;
            return reject(new Error(reason));
          }

          privateKeysCache = result.keys;
          resolve(result.keys);
        });
      }
    });
  };

  return {
    user: savedUser ? JSON.parse(savedUser) : null,
    accessToken: null,
    isBootstrapping: true,
    sendReadReceipts: savedReadReceipts ? JSON.parse(savedReadReceipts) : true,
    hasRestoredKeys: !!localStorage.getItem('encryptedPrivateKeys'),

    setHasRestoredKeys: (hasKeys) => set({ hasRestoredKeys: hasKeys }),
    setAccessToken: (token) => set({ accessToken: token }),
    setReadReceipts: (value) => {
      set({ sendReadReceipts: value });
      localStorage.setItem('sendReadReceipts', JSON.stringify(value));
    },

    tryAutoUnlock: async () => {
      const autoUnlockKey = localStorage.getItem('device_auto_unlock_key');
      const encryptedKeys = localStorage.getItem('encryptedPrivateKeys');

      if (autoUnlockKey && encryptedKeys) {
        console.log("Auto-unlock key found. Attempting to decrypt keys...");
        try {
          const result = await retrievePrivateKeys(encryptedKeys, autoUnlockKey);
          if (result.success) {
            privateKeysCache = result.keys;
            set({ hasRestoredKeys: true });
            console.log("✅ Auto-unlock successful. Keys are cached.");
            return true;
          }
          console.warn("Auto-unlock failed.");
        } catch (e) {
           console.error("Error during auto-unlock:", e);
        }
      }
      return false;
    },

    bootstrap: async () => {
      set({ isBootstrapping: true });
      let sessionStarted = false;

      if (!sessionStarted) {
        try {
          const refreshRes = await api<{ ok: boolean; accessToken?: string }>("/api/auth/refresh", { method: "POST" });
          if (refreshRes.accessToken) {
            set({ accessToken: refreshRes.accessToken });

            const me = await authFetch<User>("/api/users/me");
            set({ user: me, hasRestoredKeys: !!localStorage.getItem('encryptedPrivateKeys') });
            localStorage.setItem("user", JSON.stringify(me));

            await get().tryAutoUnlock();
            connectSocket();
          } else {
            throw new Error("No valid session.");
          }
        } catch (error: any) {
          console.error("Bootstrap error:", error);

          privateKeysCache = null;
          set({ user: null, accessToken: null });
          clearAuthCookies();
          localStorage.removeItem("user");
        }
      }

      set({ isBootstrapping: false });
    },

    login: async (emailOrUsername, password, restoredNotSynced = false) => {
      privateKeysCache = null;

      try {
        const res = await api<{ user: User; accessToken: string }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ emailOrUsername, password }),
        });

        const hasKeys = !!localStorage.getItem('encryptedPrivateKeys');

        set({ user: res.user, accessToken: res.accessToken, hasRestoredKeys: hasKeys });
        localStorage.setItem("user", JSON.stringify(res.user));

        if (hasKeys) {
          try {
            const encryptedKeys = localStorage.getItem('encryptedPrivateKeys')!;
            const isAutoUnlockReady = localStorage.getItem('device_auto_unlock_ready') === 'true';
            let result;

            if (isAutoUnlockReady) {
               console.log("🔐 Login: Detected linked device key. Using auto-unlock...");
               // Kita tidak bisa menggunakan kunci yang disimpan di localStorage karena tidak aman
               // Jadi kita harus meminta password pengguna untuk membuka kunci
               result = await retrievePrivateKeys(encryptedKeys, password);
            } else {
               result = await retrievePrivateKeys(encryptedKeys, password);
            }

            if (result.success) {
              privateKeysCache = result.keys;
              console.log("✅ Key cache successfully populated during login.");
            } else {
              throw new Error(`Login successful, but failed to decrypt keys: ${result.reason}`);
            }
          } catch (e) {
            console.error("Failed to decrypt keys on login:", e);
            toast.error("Could not decrypt your stored keys. Please restore your account if the password has changed.");
          }
        }

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
        set({ user: null, accessToken: null });
        throw error;
      }
    },

    registerAndGeneratePhrase: async (data) => {
      const {
        encryptionPublicKeyB64,
        signingPublicKeyB64,
        encryptedPrivateKeys,
        phrase
      } = await registerAndGenerateKeys(data.password);

      localStorage.setItem('publicKey', encryptionPublicKeyB64);
      localStorage.setItem('signingPublicKey', signingPublicKeyB64);
      localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
      set({ hasRestoredKeys: true });

      try {
        const result = await retrievePrivateKeys(encryptedPrivateKeys, data.password);
        if (result.success) privateKeysCache = result.keys;
      } catch (e) { throw e; }

      // JANGAN SIMPAN PASSWORD MENTAH KE LOCALSTORAGE
      // localStorage.setItem('device_auto_unlock_key', data.password);

      // Sebagai gantinya, kita hanya menyimpan indikator bahwa kunci sudah siap untuk dibuka otomatis
      // dan kunci aktual akan di-cache di memori sementara dan dihapus saat logout
      localStorage.setItem('device_auto_unlock_ready', 'true');

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
          signingKey: signingPublicKeyB64
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
    },

    verifyEmail: async (userId, code) => {
      const res = await api<{ user: User; accessToken: string }>("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ userId, code }),
      });

      if (res.user && res.accessToken) {
        set({ user: res.user, accessToken: res.accessToken });
        localStorage.setItem("user", JSON.stringify(res.user));
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
        localStorage.removeItem('user');
        localStorage.removeItem('device_auto_unlock_key'); // Hapus legacy key
        localStorage.removeItem('device_auto_unlock_ready'); // Hapus indikator baru

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
      set({ user: updatedUser });
      toast.success('Profile updated!');
    },

    // --- LOGIKA UPDATE AVATAR YANG BENAR ---
    updateAvatar: async (avatar: File) => {
      const toastId = toast.loading('Processing avatar...');
      let fileToProcess = avatar;

      // 1. Kompresi (Tetap jalan)
      if (avatar.type.startsWith('image/')) {
        try {
          fileToProcess = await compressImage(avatar);
          console.log(`🖼️ Avatar compressed: ${(avatar.size / 1024).toFixed(2)}KB -> ${(fileToProcess.size / 1024).toFixed(2)}KB`);
        } catch (e) {
          console.warn("Avatar compression failed, using original file:", e);
        }
      }

      try {
        // 2. Upload ke R2 (Langsung dari browser)
        toast.loading('Uploading to Cloud...', { id: toastId });
        
        const fileUrl = await uploadToR2(fileToProcess, 'avatars', (percent) => {
           // Opsional: Update progress toast jika mau
        });

        // 3. Simpan Metadata ke Backend (Endpoint BARU)
        toast.loading('Saving profile...', { id: toastId });
        
        const updatedUser = await authFetch<User>('/api/uploads/avatars/save', {
          method: 'POST',
          body: JSON.stringify({ fileUrl }), // Kirim JSON URL (Metadata)
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
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.encryption);
      return { publicKey, privateKey: keys.encryption };
    },
    async getSignedPreKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.signedPreKey);
      return { publicKey, privateKey: keys.signedPreKey };
    },
    setUser: (user) => {
      set({ user });
      localStorage.setItem("user", JSON.stringify(user));
    },
  };
}, Object.is);