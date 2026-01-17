import { createWithEqualityFn } from "zustand/traditional";
import { authFetch, api } from "@lib/api";
import { getSocket, disconnectSocket, connectSocket } from "@lib/socket";
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
    toast.error("Could not prepare for secure asynchronous messages.");
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
  updateProfile: (data: Partial<Pick<User, 'name' | 'description' | 'showEmailToOthers'>>) => Promise<void>;
  updateAvatar: (avatar: File) => Promise<void>;
  setReadReceipts: (value: boolean) => void;
  setHasRestoredKeys: (hasKeys: boolean) => void;
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
      useModalStore.getState().showPasswordPrompt(async (password) => {
        if (!password) return reject(new Error("Password not provided."));
        
        const encryptedKeys = localStorage.getItem('encryptedPrivateKeys');
        if (!encryptedKeys) return reject(new Error("Encrypted private keys not found."));

        // Use the worker proxy to retrieve keys
        const result = await retrievePrivateKeys(encryptedKeys, password);

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
    });
  };

  return {
    user: savedUser ? JSON.parse(savedUser) : null,
    isBootstrapping: true,
    sendReadReceipts: savedReadReceipts ? JSON.parse(savedReadReceipts) : true,
    hasRestoredKeys: !!localStorage.getItem('encryptedPrivateKeys'),

    setHasRestoredKeys: (hasKeys: boolean) => {
      set({ hasRestoredKeys: hasKeys });
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
        const me = await authFetch<User>("/api/users/me");
        set({ user: me, hasRestoredKeys: !!localStorage.getItem('encryptedPrivateKeys') });
        localStorage.setItem("user", JSON.stringify(me));
        connectSocket();
      } catch (error) {
        get().clearPrivateKeysCache();
        set({ user: null, hasRestoredKeys: false });
        localStorage.removeItem("user");
      } finally {
        set({ isBootstrapping: false });
      }
    },

    async login(emailOrUsername, password, restoredNotSynced = false) {
      get().clearPrivateKeysCache();
      const res = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ emailOrUsername, password }),
      });
      const hasKeys = !!localStorage.getItem('encryptedPrivateKeys');
      set({ user: res.user, hasRestoredKeys: hasKeys });
      localStorage.setItem("user", JSON.stringify(res.user));
      
      // If logging in after a restore, update the public keys on the server
      if (restoredNotSynced) {
        try {
          console.log("Syncing restored keys with the server...");
          const publicKey = localStorage.getItem('publicKey');
          const signingKey = localStorage.getItem('signingPublicKey');
          if (!publicKey || !signingKey) throw new Error("Restored public keys not found in local storage.");

          await authFetch('/api/users/me/keys', {
            method: 'PUT',
            body: JSON.stringify({ publicKey, signingKey }),
          });
          console.log("Server keys updated successfully.");
        } catch(e) {
          console.error("Failed to sync restored keys with server:", e);
          toast.error("Failed to sync new keys with server. You may need to generate new keys.");
        }
      }
      
      if (hasKeys) {
        try {
          await setupAndUploadPreKeyBundle();
        } catch (e) {
          toast.error("Could not prepare secure sessions.");
        }
      } else {
        toast("To enable secure messaging, please restore your account from your recovery phrase in Settings.", { duration: 7000 });
      }
      
      connectSocket();
    },

    async registerAndGeneratePhrase(data) {
      // All heavy crypto work is now in the worker
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
      
      // The non-crypto part remains here
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          publicKey: encryptionPublicKeyB64,
          signingKey: signingPublicKeyB64
        }),
      });
      return phrase;
    },

    async logout() {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch {}
      eraseCookie("at");
      eraseCookie("rt");
      get().clearPrivateKeysCache();
      localStorage.removeItem('user');
      set({ user: null, hasRestoredKeys: false });
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
      // This is a very lightweight operation, acceptable to keep on main thread
      const publicKey = sodium.crypto_scalarmult_base(keys.encryption);
      return { publicKey, privateKey: keys.encryption };
    },

    async getSignedPreKeyPair(): Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }> {
      const keys = await retrieveAndCacheKeys();
      if (!keys.signedPreKey) throw new Error("Signed pre-key not found in bundle.");
      const sodium = await getSodium();
      // This is a very lightweight operation, acceptable to keep on main thread
      const publicKey = sodium.crypto_scalarmult_base(keys.signedPreKey);
      return { publicKey, privateKey: keys.signedPreKey };
    },

    setUser: (user: User) => {
      set({ user });
      localStorage.setItem("user", JSON.stringify(user));
    },
  }
});
