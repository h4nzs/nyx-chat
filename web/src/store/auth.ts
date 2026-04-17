// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { MinimalUserSchema } from '@nyx/shared';
import { authFetch, api } from "@lib/api";
import { disconnectSocket, connectSocket } from "@lib/socket";
import { clearAuthCookies } from "@lib/tokenStorage";
import { useModalStore } from "./modal";
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";
import { getEncryptedKeys, saveEncryptedKeys, clearKeys, hasStoredKeys, getDeviceAutoUnlockKey, saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady, nuclearWipe } from "@lib/keyStorage";
import type { RetrievedKeys } from "@lib/crypto-worker-proxy"; 
import { checkAndRefillOneTimePreKeys, resetOneTimePreKeys } from "@utils/crypto"; 
import type { UserId, User } from '@nyx/shared';
import i18n from '../i18n';

// ✅ Helper pendeteksi nama perangkat
const getDeviceName = () => {
    const ua = navigator.userAgent;
    let browser = "Web Browser";
    let os = "Unknown OS";
    
    if (ua.includes("Firefox")) browser = "Firefox";
    else if (ua.includes("Edg")) browser = "Edge";
    else if (ua.includes("Chrome")) browser = "Chrome";
    else if (ua.includes("Safari") && !ua.includes("Chrome")) browser = "Safari";

    if (ua.includes("Win")) os = "Windows";
    else if (ua.includes("Mac")) os = "MacOS";
    else if (ua.includes("Linux")) os = "Linux";
    else if (ua.includes("Android")) os = "Android";
    else if (ua.includes("like Mac")) os = "iOS";

    return `${browser} on ${os}`;
};

/**
 * Retrieves the persisted signed pre-key, signs it with the identity signing key,
 * and uploads the bundle to the server.
 * Also checks and refills One-Time Pre-Keys (OTPK).
 */
export async function setupAndUploadPreKeyBundle() {
  try {
    const { getSodiumLib } = await import('@utils/crypto');
    
    const { getSigningPrivateKey, getEncryptionKeyPair, getSignedPreKeyPair, getPqEncryptionKeyPair, getPqSignedPreKeyPair } = useAuthStore.getState();

    const sodium = await getSodiumLib();
    const signingPrivateKey = await getSigningPrivateKey();
    const { publicKey: identityKey } = await getEncryptionKeyPair();
    const { publicKey: signedPreKey } = await getSignedPreKeyPair();
    const { publicKey: pqIdentityKey } = await getPqEncryptionKeyPair();
    const { publicKey: pqSignedPreKey } = await getPqSignedPreKeyPair();

    const identityKeyB64 = sodium.to_base64(identityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const pqIdentityKeyB64 = sodium.to_base64(pqIdentityKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const signingPublicKey = signingPrivateKey.slice(32);

    const signature = sodium.crypto_sign_detached(signedPreKey, signingPrivateKey);
    const pqSignature = sodium.crypto_sign_detached(pqSignedPreKey, signingPrivateKey);

    const bundle = {
      identityKey: identityKeyB64,
      pqIdentityKey: pqIdentityKeyB64,
      signingKey: sodium.to_base64(signingPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      signedPreKey: {
        key: sodium.to_base64(signedPreKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        pqKey: sodium.to_base64(pqSignedPreKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        signature: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING),
        pqSignature: sodium.to_base64(pqSignature, sodium.base64_variants.URLSAFE_NO_PADDING),
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

export type { User };

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
  bootstrap: (force?: boolean) => Promise<void>;
  tryAutoUnlock: () => Promise<boolean>;
  login: (usernameHash: string, password: string, restoredNotSynced?: boolean) => Promise<void>;
  registerAndGeneratePhrase: (data: { 
    encryptedProfile: string; 
    usernameHash: string; // Blind Index
    password: string; 
    turnstileToken?: string; 
  }) => Promise<RegisterResponse>;
  
  logout: () => Promise<void>;
  emergencyLogout: () => Promise<void>; // Nuclear Option
  getEncryptionKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getPqEncryptionKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getSigningPrivateKey: () => Promise<Uint8Array>;
  getSignedPreKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
  getPqSignedPreKeyPair: () => Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>;
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
  silentRefresh: () => Promise<boolean>;
};

let privateKeysCache: RetrievedKeys | null = null;

export const useAuthStore = createWithEqualityFn<State & Actions>((set, get) => {
  const savedUser = localStorage.getItem("user");
  const savedReadReceipts = localStorage.getItem('sendReadReceipts');
  
  let initialUser: User | null = null;
  if (savedUser) {
    try {
        const parsedData = JSON.parse(savedUser);
        const validated = MinimalUserSchema.safeParse(parsedData);
        if (validated.success) {
            initialUser = validated.data;
        } else {
            console.warn("[Zustand Persist] Corrupted user data in localStorage, dropping...");
            localStorage.removeItem("user");
        }
    } catch {
        console.warn("[Zustand Persist] Invalid JSON in localStorage, dropping...");
        localStorage.removeItem("user");
    }
  }

  const retrieveAndCacheKeys = async (): Promise<RetrievedKeys> => {
    if (privateKeysCache) return privateKeysCache;

    const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');

    let autoUnlockKey: string | undefined | null = null;
    let encryptedKeys: string | undefined | null = null;

    try {
      autoUnlockKey = await getDeviceAutoUnlockKey();
      encryptedKeys = await getEncryptedKeys();
    } catch (_e) {
      console.error("Failed to read keys/auto-unlock info:", _e);
    }

    // Attempt auto-unlock if both exist
    if (autoUnlockKey && encryptedKeys) {
      try {
        const result = await retrievePrivateKeys(encryptedKeys, autoUnlockKey);
        if (result.success) {
          privateKeysCache = result.keys;
          return result.keys;
        }
      } catch (e) {}
    }

    // Fallback: Prompt user for password manually
    const promptForPassword = async (retrieveFn: typeof retrievePrivateKeys): Promise<RetrievedKeys> => {
      return new Promise((resolve, reject) => {
        const unsubscribe = useModalStore.subscribe((state) => {
          if (!state.isPasswordPromptOpen) {
            unsubscribe();
            setTimeout(() => {
               reject(new Error("Password prompt closed without input."));
            }, 100);
          }
        });

        const cleanup = () => unsubscribe();

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
    user: initialUser,
    accessToken: null,
    isLoading: false,
    isBootstrapping: true,
    isInitializingCrypto: false,
    sendReadReceipts: savedReadReceipts ? JSON.parse(savedReadReceipts) : true,
    hasRestoredKeys: false,
    blockedUserIds: [],

    setHasRestoredKeys: async (_hasKeys) => set({ hasRestoredKeys: await hasStoredKeys() }),
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

    bootstrap: async (force = false) => {
      if (!force && get().accessToken && get().user) {
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
      } catch (error: unknown) {
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
        let newPublicKey: string | undefined = undefined;
        let newSigningKey: string | undefined = undefined;
        let newEncryptedPrivateKey: string | undefined = undefined;

        // Cek apakah user sudah punya kunci lokal (misal: Device lama tapi sesi expired)
        const alreadyHasKeys = await hasStoredKeys();
        
        if (alreadyHasKeys && !restoredNotSynced) {
            const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
            const localEncryptedKeys = await getEncryptedKeys();
            if (!localEncryptedKeys) throw new Error("Local keys missing unexpectedly.");

            const result = await retrievePrivateKeys(localEncryptedKeys, password);
            if (result.success && result.keys) {
                const { getSodiumLib } = await import('@utils/crypto');
                const sodium = await getSodiumLib();
                
                // Regenerate public keys from decrypted private keys for server sync
                const encryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(result.keys.encryption);
                const signingPublicKeyBytes = result.keys.signing.slice(32);
                
                newPublicKey = sodium.to_base64(encryptionKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                newSigningKey = sodium.to_base64(signingPublicKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
                newEncryptedPrivateKey = localEncryptedKeys;
            } else {
                throw new Error("Invalid password for local keys. Please recover your account.");
            }
        } else if (!alreadyHasKeys && !restoredNotSynced) {
            // Fresh login on a brand new device -> Generate completely new identities
            const { generateNewKeys } = await import('@lib/crypto-worker-proxy');
            const keys = await generateNewKeys(password);
            
            newPublicKey = keys.encryptionPublicKeyB64;
            newSigningKey = keys.signingPublicKeyB64;
            newEncryptedPrivateKey = keys.encryptedPrivateKeys;
        }

        // Call API
        const res = await api<{ user: User; accessToken: string; encryptedPrivateKey?: string }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ 
              usernameHash, 
              password,
              deviceName: getDeviceName(),
              publicKey: newPublicKey,
              signingKey: newSigningKey,
              encryptedPrivateKey: newEncryptedPrivateKey
          }),
        });

        // FIX 1: SIMPAN encryptedPrivateKey DARI SERVER DULU sebelum mencoba membukanya
        if (res.encryptedPrivateKey) {
          await saveEncryptedKeys(res.encryptedPrivateKey);
          await saveDeviceAutoUnlockKey(password);
          await setDeviceAutoUnlockReady(true);
        }

        const hasKeysNow = await hasStoredKeys();
        set({ user: res.user, accessToken: res.accessToken, hasRestoredKeys: hasKeysNow, blockedUserIds: [] });
        localStorage.setItem("user", JSON.stringify(res.user));

        // FIX 2: Buka kunci MENGGUNAKAN data yang baru saja disave
        if (hasKeysNow) {
          try {
            const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
            const storedEncryptedKeys = await getEncryptedKeys();
            if (storedEncryptedKeys) {
                const result = await retrievePrivateKeys(storedEncryptedKeys, password);

                if (result.success) {
                  privateKeysCache = result.keys;
                  // Persist for auto-unlock
                  await saveDeviceAutoUnlockKey(password);
                  await setDeviceAutoUnlockReady(true);
                } else {
                  throw new Error(`Login successful, but failed to decrypt keys: ${result.reason}`);
                }
            }
          } catch (e) {
            console.error("Failed to decrypt keys on login:", e);
            toast.error(i18n.t('errors:could_not_decrypt_your_stored_keys_pleas', 'Could not decrypt your stored keys. Please restore your account if the password has changed.'));
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
      } catch (error: unknown) {
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

        const res = await api<{ accessToken: string; user: User }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            usernameHash,
            password,
            encryptedProfile,
            publicKey: encryptionPublicKeyB64,
            signingKey: signingPublicKeyB64,
            encryptedPrivateKeys,
            deviceName: getDeviceName(),
            turnstileToken
          }),
        });

        await saveEncryptedKeys(encryptedPrivateKeys);
        await saveDeviceAutoUnlockKey(password);
        await setDeviceAutoUnlockReady(true);
        set({ hasRestoredKeys: true });

        try {
          const result = await retrievePrivateKeys(encryptedPrivateKeys, password);
          if (result.success) privateKeysCache = result.keys;
        } catch (_e) {}

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

    emergencyLogout: async () => {
      try {
        await api("/api/auth/logout-all", { method: "POST" }).catch((e) => console.error("Server kill failed:", e));
        
        if ('serviceWorker' in navigator && 'PushManager' in window) {
           const registration = await navigator.serviceWorker.ready;
           const subscription = await registration.pushManager.getSubscription();
           if (subscription) await subscription.unsubscribe();
        }
      } catch (e) { 
        console.error("Emergency logout error", e); 
      } finally {
        clearAuthCookies();
        privateKeysCache = null;
        await nuclearWipe(); 
        
        set({ user: null, accessToken: null });
        disconnectSocket();
        useConversationStore.getState().reset();
        useMessageStore.getState().reset();
        
        window.location.href = '/login';
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
      toast.success(i18n.t('common:profile_updated', 'Profile updated!'));
    },

    updateAvatar: async (avatar: File) => {
      const toastId = toast.loading(i18n.t('common:processing_avatar', 'Processing avatar...'));
      const { compressImage } = await import('@lib/fileUtils');
      const { uploadToR2 } = await import('@lib/r2');
      let fileToProcess = avatar;
      if (avatar.type.startsWith('image/')) {
        try { fileToProcess = await compressImage(avatar); } catch (_e) {}
      }
      try {
        toast.loading('Uploading to Cloud...', { id: toastId });
        const fileUrl = await uploadToR2(fileToProcess, 'avatars', () => {});
        toast.success('Avatar uploaded! (Profile update required)', { id: toastId });
        return fileUrl; 
      } catch (e: unknown) {
        console.error(e);
        toast.error(`Update failed: ${(e instanceof Error ? e.message : 'Unknown error')}`, { id: toastId });
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
      const { getSodiumLib } = await import('@utils/crypto');
      const sodium = await getSodiumLib();
      return sodium.crypto_kem_xwing_seed_keypair(keys.encryption);
    },
    async getPqEncryptionKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodiumLib } = await import('@utils/crypto');
      const sodium = await getSodiumLib();
      if (!keys.pqEncryption) throw new Error("PQ Encryption key missing");
      return sodium.crypto_kem_xwing_seed_keypair(keys.pqEncryption);
    },
    async getSignedPreKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodiumLib } = await import('@utils/crypto');
      const sodium = await getSodiumLib();
      return sodium.crypto_kem_xwing_seed_keypair(keys.signedPreKey);
    },
    async getPqSignedPreKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodiumLib } = await import('@utils/crypto');
      const sodium = await getSodiumLib();
      if (!keys.pqSignedPreKey) throw new Error("PQ Signed PreKey missing");
      return sodium.crypto_kem_xwing_seed_keypair(keys.pqSignedPreKey);
    },
    setUser: (user) => {
      set({ user });
      localStorage.setItem("user", JSON.stringify(user));
    },

    blockUser: async (userId) => {
      const toastId = toast.loading(i18n.t('common:blocking_user', 'Blocking user...'));
      try {
        await authFetch(`/api/users/${userId}/block`, { method: 'POST' });
        toast.success(i18n.t('common:user_blocked', 'User blocked'), { id: toastId });
        set(state => ({ blockedUserIds: [...state.blockedUserIds, userId] }));
      } catch (error: unknown) {
        const errorDetails = typeof error === 'object' && error !== null && 'details' in error ? (error as Record<string, unknown>).details : undefined;
        const errorMsg = errorDetails ? JSON.parse(String(errorDetails)).error : (error instanceof Error ? error.message : 'Unknown error');
        toast.error(`Block failed: ${errorMsg}`, { id: toastId });
        throw error;
      }
    },

    unblockUser: async (userId) => {
      const toastId = toast.loading(i18n.t('common:unblocking_user', 'Unblocking user...'));
      try {
        await authFetch(`/api/users/${userId}/block`, { method: 'DELETE' });
        toast.success('User unblocked', { id: toastId });
        set(state => ({ blockedUserIds: state.blockedUserIds.filter(id => id !== userId) }));
      } catch (error: unknown) {
        const errorDetails = typeof error === 'object' && error !== null && 'details' in error ? (error as Record<string, unknown>).details : undefined;
        const errorMsg = errorDetails ? JSON.parse(String(errorDetails)).error : (error instanceof Error ? error.message : 'Unknown error');
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

    silentRefresh: async () => {
      try {
        const { api } = await import('@lib/api');
        const data = await api<Record<string, unknown>>('/api/auth/refresh', {
          method: 'POST',
        });
        
        if (data && typeof data === 'object' && 'accessToken' in data && typeof data.accessToken === 'string') {
          set({ accessToken: data.accessToken });
          return true;
        }
        return false;
      } catch (error) {
        console.warn('[Auth] Silent refresh failed:', error);
        return false;
      }
    },
  };
}, Object.is);
