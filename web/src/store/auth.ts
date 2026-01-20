import { createWithEqualityFn } from "zustand/traditional";
import { authFetch, api } from "@lib/api";
import { disconnectSocket, connectSocket } from "@lib/socket";
import { eraseCookie } from "@lib/tokenStorage";
import { clearKeyCache } from "@utils/crypto";
import { getSodium } from '@lib/sodiumInitializer';
import { useModalStore } from "./modal";
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";
import { 
  registerAndGenerateKeys,
  retrievePrivateKeys,
  type RetrieveKeysResult
} from "@lib/crypto-worker-proxy";

/**
 * Retrieves the persisted signed pre-key, signs it with the identity signing key,
 * and uploads the bundle to the server.
 */
export async function setupAndUploadPreKeyBundle() {
  try {
    const { getSigningPrivateKey, getSignedPreKeyPair, getEncryptionKeyPair } = useAuthStore.getState();

    const sodium = await getSodium();
    const signingPrivateKey = await getSigningPrivateKey();
    const signedPreKeyPair = await getSignedPreKeyPair();
    const encryptionKeyPair = await getEncryptionKeyPair();

    const identityKeyFromStorage = localStorage.getItem('publicKey');
    if (!identityKeyFromStorage) throw new Error("Identity key not found in localStorage.");

    const derivedIdentityKey = sodium.to_base64(encryptionKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    if (identityKeyFromStorage !== derivedIdentityKey) {
      throw new Error("CRITICAL: Stored public key does not match derived private key. Aborting pre-key bundle upload.");
    }

    const signature = sodium.crypto_sign_detached(signedPreKeyPair.publicKey, signingPrivateKey);

    const bundle = {
      identityKey: identityKeyFromStorage,
      signedPreKey: {
        key: sodium.to_base64(signedPreKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
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
    // toast.error("Could not prepare for secure asynchronous messages.");
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

type RetrievedKeys = {
  encryption: Uint8Array;
  signing: Uint8Array;
  signedPreKey: Uint8Array;
  masterSeed?: Uint8Array;
};

type State = {
  user: User | null;
  accessToken: string | null;
  isBootstrapping: boolean;
  sendReadReceipts: boolean;
  hasRestoredKeys: boolean;
};

type Actions = {
  bootstrap: () => Promise<void>;
  login: (emailOrUsername: string, password: string, restoredNotSynced?: boolean) => Promise<void>;
  registerAndGeneratePhrase: (data: any) => Promise<string>;
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
  // --- FIX: Tambahkan definisi setMasterSeed ---
  setMasterSeed: (seed: string) => Promise<void>; 
  clearPrivateKeysCache: () => void;
};

const savedUser = localStorage.getItem("user");
const savedReadReceipts = localStorage.getItem('sendReadReceipts');

let privateKeysCache: RetrievedKeys | null = null;

export const useAuthStore = createWithEqualityFn<State & Actions>((set, get) => {
  // Helper function to retrieve and cache keys, handling password prompt and errors
  const retrieveAndCacheKeys = (): Promise<RetrievedKeys> => {
    if (privateKeysCache) return Promise.resolve(privateKeysCache);

    return new Promise((resolve, reject) => {
      // 1. Cek Auto-Unlock Key (Untuk device hasil linking / login QR)
      const autoKey = localStorage.getItem('device_auto_unlock_key');
      // Cek kedua kemungkinan format key (untuk backward compatibility)
      const encryptedKeys = localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys');

      if (autoKey && encryptedKeys) {
        // Coba unlock otomatis tanpa prompt
        retrievePrivateKeys(encryptedKeys, autoKey).then((result) => {
          if (result.success) {
            privateKeysCache = result.keys;
            resolve(result.keys);
          } else {
            // Fallback ke prompt password jika auto-unlock gagal
            promptForPassword();
          }
        }).catch(() => promptForPassword());
      } else {
        promptForPassword();
      }

      function promptForPassword() {
         useModalStore.getState().showPasswordPrompt(async (password) => {
          if (!password) return reject(new Error("Password not provided."));
          
          const encryptedKeysInner = localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys');
          if (!encryptedKeysInner) return reject(new Error("Encrypted private keys not found."));

          const result = await retrievePrivateKeys(encryptedKeysInner, password);

          if (!result.success) {
            if (result.reason === 'incorrect_password') {
              return reject(new Error("Incorrect password."));
            }
            if (result.reason === 'legacy_bundle') {
              return reject(new Error("Legacy key bundle found. Please restore your account from your recovery phrase to upgrade."));
            }
            return reject(new Error(`Failed to retrieve keys: ${result.reason}`));
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
    hasRestoredKeys: !!(localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys')),

    setHasRestoredKeys: (hasKeys: boolean) => {
      set({ hasRestoredKeys: hasKeys });
    },

    setAccessToken: (token: string | null) => {
      set({ accessToken: token });
    },

    // --- FIX: Implementasi setMasterSeed ---
    // Fungsi ini dipanggil setelah linking device berhasil untuk menghidupkan cache key
    setMasterSeed: async (seedStr: string) => {
      try {
        const autoKey = localStorage.getItem('device_auto_unlock_key');
        const encryptedKeys = localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys');
        
        if (autoKey && encryptedKeys) {
          const result = await retrievePrivateKeys(encryptedKeys, autoKey);
          if (result.success) {
            privateKeysCache = result.keys;
            set({ hasRestoredKeys: true });
            console.log("Keys hydrated successfully via setMasterSeed");
          }
        }
      } catch (e) {
        console.error("Failed to hydrate keys in setMasterSeed", e);
      }
    },

    clearPrivateKeysCache: () => {
      privateKeysCache = null;
      clearKeyCache();
    },

    setReadReceipts: (value: boolean) => {
      set({ sendReadReceipts: value });
      localStorage.setItem('sendReadReceipts', JSON.stringify(value));
    },

    async bootstrap() {
      try {
        const refreshRes = await api<{ ok: boolean; accessToken?: string }>("/api/auth/refresh", { method: "POST" });
        
        if (refreshRes.accessToken) {
          set({ accessToken: refreshRes.accessToken });
        }

        const me = await authFetch<User>("/api/users/me");
        set({ 
          user: me, 
          hasRestoredKeys: !!(localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys')) 
        });
        localStorage.setItem("user", JSON.stringify(me));
        
        connectSocket();
        
        // Coba pre-warm keys jika ada auto-unlock key
        if (localStorage.getItem('device_auto_unlock_key')) {
           retrieveAndCacheKeys().catch(() => {});
        }

      } catch (error) {
        get().clearPrivateKeysCache();
        set({ user: null, accessToken: null, hasRestoredKeys: false });
        localStorage.removeItem("user");
      } finally {
        set({ isBootstrapping: false });
      }
    },

    async login(emailOrUsername, password, restoredNotSynced = false) {
      // Step 1: Clear any keys from a previous session.
      privateKeysCache = null; 
      
      // Step 2: Authenticate with the server.
      const res = await api<{ user: User; accessToken: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ emailOrUsername, password }),
      });

      const hasKeys = !!(localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys'));
      
      // Step 3: Set user and token state.
      set({ 
        user: res.user, 
        accessToken: res.accessToken,
        hasRestoredKeys: hasKeys 
      });
      localStorage.setItem("user", JSON.stringify(res.user));
      
      // Step 4 (FIX): If keys exist locally, decrypt them now with the provided password.
      if (hasKeys) {
        try {
          const encryptedKeys = localStorage.getItem('encryptedPrivateKeys') || localStorage.getItem('encrypted_private_keys');
          const result = await retrievePrivateKeys(encryptedKeys!, password);
          if (result.success) {
            privateKeysCache = result.keys;
            console.log("✅ Key cache successfully populated during login.");
          } else {
            // This happens if the password is correct for login but not for keys (e.g., after a password reset not yet implemented)
            throw new Error(`Login successful, but failed to decrypt keys: ${result.reason}`);
          }
        } catch (e) {
          console.error("Failed to decrypt keys on login:", e);
          toast.error("Could not decrypt your stored keys. You may need to restore from your recovery phrase if the password has changed.");
        }
      }

      // Step 5: Handle post-login tasks like syncing keys.
      if (restoredNotSynced) {
        // This case is for when a user restores from phrase and then logs in.
        try {
          console.log("Syncing restored keys with the server...");
          await setupAndUploadPreKeyBundle();
          console.log("Server keys updated successfully.");
        } catch(e) {
          console.error("Failed to sync restored keys with server:", e);
          toast.error("Failed to sync new keys with server. You may need to generate new keys.");
        }
      } else if (get().hasRestoredKeys) {
        // For a normal login, also ensure the pre-key bundle is uploaded if needed.
        // The cache should be populated now, so this will succeed.
        setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload pre-key bundle on login:", e));
      } else {
        // This user has no keys on this device.
        toast("To enable secure messaging, restore your account from your recovery phrase in Settings.", { duration: 7000 });
      }
      
      connectSocket();
    },

    async registerAndGeneratePhrase(data) {
      // Step 1: Generate keys and the encrypted bundle.
      const {
        encryptionPublicKeyB64,
        signingPublicKeyB64,
        encryptedPrivateKeys,
        phrase
      } = await registerAndGenerateKeys(data.password);

      // Step 2: Store the encrypted bundle and public keys in localStorage.
      localStorage.setItem('publicKey', encryptionPublicKeyB64);
      localStorage.setItem('signingPublicKey', signingPublicKeyB64);
      localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
      set({ hasRestoredKeys: true });
      
      // Step 3 (FIX): Immediately decrypt the bundle we just created to populate the cache.
      // This prevents the subsequent `setupAndUploadPreKeyBundle` call from failing.
      try {
        const result = await retrievePrivateKeys(encryptedPrivateKeys, data.password);
        if (result.success) {
          privateKeysCache = result.keys;
          console.log("✅ Key cache successfully populated during registration.");
        } else {
          // This should not happen if the password is correct.
          throw new Error(`Failed to prime key cache: ${result.reason}`);
        }
      } catch (e) {
        console.error("Critical error: Failed to cache keys during registration.", e);
        toast.error("A critical error occurred while securing your account. Please try again.");
        // Throwing here to stop the registration process if keys can't be cached.
        throw e;
      }

      // Step 4: Register the user on the server with their public keys.
      const res = await api<{ user: User; accessToken: string }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          publicKey: encryptionPublicKeyB64,
          signingKey: signingPublicKeyB64
        }),
      });

      // Step 5: If server registration is successful, set the session and upload the pre-key bundle.
      if (res.user && res.accessToken) {
        set({ 
          user: res.user, 
          accessToken: res.accessToken 
        });
        localStorage.setItem("user", JSON.stringify(res.user));
        // This will now succeed because the key cache is populated.
        try {
          await setupAndUploadPreKeyBundle();
        } catch (e) {
          console.error("Failed to upload initial pre-key bundle:", e);
        }
        connectSocket();
      }

      return phrase;
    },

    async logout() {
      try {
        let endpoint = null;
        if ('serviceWorker' in navigator && 'PushManager' in window) {
           const registration = await navigator.serviceWorker.ready;
           const subscription = await registration.pushManager.getSubscription();
           if (subscription) {
             endpoint = subscription.endpoint;
             await subscription.unsubscribe(); 
           }
        }
        await api("/api/auth/logout", {
          method: "POST",
          body: JSON.stringify({ endpoint })
         });
      } catch (e) {
        console.error("Logout error", e);
      }
      eraseCookie("at");
      eraseCookie("rt");
      get().clearPrivateKeysCache();
      localStorage.removeItem('user');
      // Jangan hapus keys jika user logout, tapi hapus auto-unlock key agar aman
      localStorage.removeItem('device_auto_unlock_key'); 
      
      set({ user: null, accessToken: null, hasRestoredKeys: false });
      
      disconnectSocket();
      useConversationStore.getState().reset();
      useMessageStore.getState().reset();
    },

    updateProfile: async (data) => {
      try {
        const updatedUser = await authFetch<User>('/api/users/me', {
          method: 'PUT',
          body: JSON.stringify(data),
        });
        set({ user: updatedUser });
        toast.success('Profile updated!');
      } catch (e: any) {
        toast.error(`Update failed: ${e.message}`);
        throw e;
      }
    },

    updateAvatar: async (avatar: File) => {
      const formData = new FormData();
      formData.append('avatar', avatar);
      try {
        const updatedUser = await authFetch<User>('/api/uploads/avatars/upload', {
          method: 'POST',
          body: formData,
        });
        set({ user: updatedUser });
        localStorage.setItem("user", JSON.stringify(updatedUser));
        toast.success('Avatar updated!');
      } catch (e: any) {
        toast.error(`Upload failed: ${e.message}`);
        throw e;
      }
    },

    async getMasterSeed(): Promise<Uint8Array | undefined> {
        const keys = await retrieveAndCacheKeys();
        return keys.masterSeed;
    },

    async getSigningPrivateKey(): Promise<Uint8Array> {
      const keys = await retrieveAndCacheKeys();
      if (!keys.signing) throw new Error("Signing key not found in bundle.");
      return keys.signing;
    },

    async getEncryptionKeyPair(): Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }> {
      const keys = await retrieveAndCacheKeys();
      if (!keys.encryption) throw new Error("Encryption key not found in bundle.");
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.encryption);
      return { publicKey, privateKey: keys.encryption };
    },

    async getSignedPreKeyPair(): Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }> {
      const keys = await retrieveAndCacheKeys();
      if (!keys.signedPreKey) throw new Error("Signed pre-key not found in bundle.");
      const sodium = await getSodium();
      const publicKey = sodium.crypto_scalarmult_base(keys.signedPreKey);
      return { publicKey, privateKey: keys.signedPreKey };
    },

    setUser: (user: User) => {
      set({ user });
      localStorage.setItem("user", JSON.stringify(user));
    },
  }
});