import { createWithEqualityFn } from "zustand/traditional";
import { authFetch, api } from "@lib/api";
import { getSocket, disconnectSocket, connectSocket } from "@lib/socket";
import { eraseCookie } from "@lib/tokenStorage";
import { clearKeyCache } from "@utils/crypto";
import { getSodium } from '@lib/sodiumInitializer';
import { exportPublicKey, storePrivateKeys, retrievePrivateKeys, type RetrieveKeysResult } from "@utils/keyManagement";
import { useModalStore } from "./modal";
import * as bip39 from 'bip39';
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";

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
    const encryptionKeyPair = await getEncryptionKeyPair(); // Get the main identity key pair

    // Validation: Ensure the public key in localStorage matches the one derived from the private key
    const identityKeyFromStorage = localStorage.getItem('publicKey');
    if (!identityKeyFromStorage) throw new Error("Identity key not found in localStorage.");

    const derivedIdentityKey = await exportPublicKey(encryptionKeyPair.publicKey);

    if (identityKeyFromStorage !== derivedIdentityKey) {
      throw new Error("CRITICAL: Stored public key does not match derived private key. Aborting pre-key bundle upload.");
    }

    const signature = sodium.crypto_sign_detached(signedPreKeyPair.publicKey, signingPrivateKey);

    const bundle = {
      identityKey: identityKeyFromStorage,
      signedPreKey: {
        key: await exportPublicKey(signedPreKeyPair.publicKey),
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
};

type Actions = {
  bootstrap: () => Promise<void>;
  login: (emailOrUsername: string, password: string) => Promise<void>;
  registerAndGeneratePhrase: (data: any) => Promise<string>;
  logout: () => Promise<void>;
  getEncryptionKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getSigningPrivateKey: () => Promise<Uint8Array>;
  getSignedPreKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  setUser: (user: User) => void;
  updateProfile: (data: Partial<Pick<User, 'name' | 'description' | 'showEmailToOthers'>>) => Promise<void>;
  updateAvatar: (avatar: File) => Promise<void>;
  setReadReceipts: (value: boolean) => void;
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
        set({ user: me });
        localStorage.setItem("user", JSON.stringify(me));
        connectSocket();
      } catch (error) {
        get().clearPrivateKeysCache();
        set({ user: null });
        localStorage.removeItem("user");
      } finally {
        set({ isBootstrapping: false });
      }
    },

    async login(emailOrUsername, password) {
      get().clearPrivateKeysCache();
      const res = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ emailOrUsername, password }),
      });
      set({ user: res.user });
      localStorage.setItem("user", JSON.stringify(res.user));
      
      if (localStorage.getItem('encryptedPrivateKeys')) {
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
      const sodium = await getSodium();
      const masterSeed = sodium.randombytes_buf(32);
      const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
      const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));
      const signedPreKeySeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
      const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
      const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
      const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
      const encryptionPublicKeyB64 = await exportPublicKey(encryptionKeyPair.publicKey);
      const signingPublicKeyB64 = await exportPublicKey(signingKeyPair.publicKey);
      const encryptedPrivateKeys = await storePrivateKeys({
        encryption: encryptionKeyPair.privateKey,
        signing: signingKeyPair.privateKey,
        signedPreKey: signedPreKeyPair.privateKey,
        masterSeed: masterSeed
      }, data.password);
      localStorage.setItem('publicKey', encryptionPublicKeyB64);
      localStorage.setItem('signingPublicKey', signingPublicKeyB64);
      localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
      const phrase = bip39.entropyToMnemonic(masterSeed);
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
      set({ user: null });
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
        const updatedUser = await authFetch<User>('/api/users/me/avatar', {
          method: 'POST',
          body: formData,
        });
        set({ user: updatedUser });
        toast.success('Avatar updated!');
      } catch (e: any) {
        toast.error(`Upload failed: ${e.message}`);
        throw e;
      }
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
