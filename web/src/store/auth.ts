// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { MinimalUserSchema } from '@nyx/shared';
import { authFetch, api } from "@lib/api";
import { disconnectSocket, connectSocket } from '@lib/transportClient';
import { clearAuthCookies } from "@lib/tokenStorage";
import { useModalStore } from "./modal";
import { useConversationStore } from "./conversation";
import { useMessageStore } from "./message";
import toast from "react-hot-toast";
import { getEncryptedKeys, saveEncryptedKeys, clearKeys, hasStoredKeys, getDeviceAutoUnlockKey, saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady, setAutoUnlockIdentity } from "@lib/keyStorage";
import type { RetrievedKeys } from "@lib/crypto-worker-proxy";
import { getBrowserFingerprint } from "@utils/fingerprint";
import { checkAndRefillOneTimePreKeys, resetOneTimePreKeys } from "@utils/crypto";
import type { UserId, User, SubscriptionTier } from '@nyx/shared';
import { executeLocalWipe } from "@lib/nukeProtocol";
import i18n from '../i18n';
import { prefetchAppChunks } from '@lib/prefetch';

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
let isSettingUpKeys = false;
let lastPrekeySetup = 0;

export async function setupAndUploadPreKeyBundle() {
  if (isSettingUpKeys) return;
  const now = Date.now();
  if (now - lastPrekeySetup < 60000) return; // 1 minute cooldown

  isSettingUpKeys = true;

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

    // [Temuan #2] Kirim salinan encryptedPrivateKey terbaru bersama bundle —
    // tanpa ini, rotasi kunci membiarkan kolom device di server memegang bundle
    // identitas LAMA, dan login blind di device baru mengadopsi bundle basi itu.
    const encryptedPrivateKeys = await getEncryptedKeys();

    const bundle = {
      identityKey: identityKeyB64,
      pqIdentityKey: pqIdentityKeyB64,
      signingKey: sodium.to_base64(signingPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      ...(encryptedPrivateKeys ? { encryptedPrivateKeys } : {}),
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

    lastPrekeySetup = Date.now();
    await checkAndRefillOneTimePreKeys();

  } catch (e) {
    console.error("Failed to set up and upload pre-key bundle:", e);
    throw e;
  } finally {
    isSettingUpKeys = false;
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
  // True selama proses login/dekripsi kunci berlangsung (state `hasRestoredKeys`
  // belum settle). Dipakai agar modal "New Device Detected" tidak flash terbuka
  // beberapa detik di device yang sama (jendela antara baseline false → true).
  isUnlocking: boolean;
  blockedUserIds: string[];
  // Monotonic counter incremented on every successful login/registration.
  // Used by socketListeners to ignore stale force_logout events from a previous
  // session (see connectionLoginGeneration in socketListeners.ts).
  loginGeneration: number;
};

type RegisterResponse = {
  phrase: string;
  userId: string;
};

type Actions = {
  bootstrap: (force?: boolean) => Promise<void>;
  tryAutoUnlock: () => Promise<boolean>;
  lockApp: () => void;
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
  updateSubscription: (tier: SubscriptionTier) => void;
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
let refreshPromise: Promise<boolean> | null = null;
let keysRetrievalPromise: Promise<RetrievedKeys> | null = null;

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
    if (privateKeysCache) {
        return privateKeysCache;
    }
    if (keysRetrievalPromise) {
        return keysRetrievalPromise;
    }

    keysRetrievalPromise = (async () => {
      try {
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
            let isSubmissionStarted = false;
            let isResolvedOrRejected = false;

            const unsubscribe = useModalStore.subscribe((state) => {
              // If the modal is closed and we haven't started a submission or already resolved/rejected
              if (!state.isPasswordPromptOpen && !isSubmissionStarted && !isResolvedOrRejected) {
                isResolvedOrRejected = true;
                unsubscribe();
                // Short delay to ensure no race with a very fast cancel callback
                setTimeout(() => {
                   reject(new Error("Password prompt closed without input."));
                }, 100);
              }
            });

            const cleanup = () => {
              isResolvedOrRejected = true;
              unsubscribe();
            };

            useModalStore.getState().showPasswordPrompt(async (password) => {
              if (isResolvedOrRejected) return;

              // [BIOMETRIC RAM-UNLOCK] Modal mengirim null saat vault sudah
              // terbuka via biometric (unlockFromRecoveryPhrase → setDecryptedKeys
              // → privateKeysCache terisi, TANPA menyentuh bundle IDB). Ambil
              // kunci dari cache — JANGAN reject sebagai "password not provided".
              if (password === null || password === undefined) {
                if (privateKeysCache) {
                  cleanup();
                  resolve(privateKeysCache);
                  return;
                }
                cleanup();
                reject(new Error("Password not provided."));
                return;
              }

              if (!password) { 
                cleanup();
                reject(new Error("Password not provided.")); 
                return; 
              }

              isSubmissionStarted = true;

              try {
                const keysInner = await getEncryptedKeys();
                if (!keysInner) { 
                  cleanup();
                  reject(new Error("Encrypted private keys not found.")); 
                  return; 
                }

                const result = await retrieveFn(keysInner, password);
                if (!result.success) {
                  const reason = result.reason === 'incorrect_password' ? "Incorrect password." : `Failed to retrieve keys: ${result.reason}`;
                  cleanup();
                  reject(new Error(reason));
                  return;
                }

                cleanup();
                privateKeysCache = result.keys;
                resolve(result.keys);
              } catch (e) {
                cleanup();
                reject(e);
              }
            });
          });
        };

        return await promptForPassword(retrievePrivateKeys);
      } finally {
        keysRetrievalPromise = null;
      }
    })();

    return keysRetrievalPromise;
  };

  return {
    user: initialUser,
    accessToken: null,
    isLoading: false,
    isBootstrapping: true,
    isInitializingCrypto: false,
    sendReadReceipts: savedReadReceipts ? JSON.parse(savedReadReceipts) : true,
    hasRestoredKeys: false,
    isUnlocking: false,
    blockedUserIds: [],
    loginGeneration: 0,

    setHasRestoredKeys: async (_hasKeys) => set({ hasRestoredKeys: await hasStoredKeys() }),
    setAccessToken: (token) => set({ accessToken: token }),
    setReadReceipts: (value) => {
      set({ sendReadReceipts: value });
      localStorage.setItem('sendReadReceipts', JSON.stringify(value));
    },

    tryAutoUnlock: async () => {
      let autoUnlockKey: string | undefined | null = null;
      let encryptedKeys: string | undefined | null = null;
      try {
        autoUnlockKey = await getDeviceAutoUnlockKey();
        encryptedKeys = await getEncryptedKeys();
      } catch (e) {
        // Reading the stored auto-unlock material failed — treat as "nothing to
        // unlock", but surface the reason so it isn't a silent dead-end.
        console.warn('[tryAutoUnlock] Failed to read stored unlock material:', e);
        return false;
      }

      // Normal path: no stored auto-unlock material → user must unlock manually.
      // This is expected (e.g. fresh device), so no warning/toast here.
      if (!autoUnlockKey || !encryptedKeys) {
        return false;
      }

      set({ isInitializingCrypto: true });
      try {
        const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
        const result = await retrievePrivateKeys(encryptedKeys, autoUnlockKey);
        if (result.success) {
          privateKeysCache = result.keys;
          set({ hasRestoredKeys: true });
          await setDeviceAutoUnlockReady(true);

          import('./auth').then(({ setupAndUploadPreKeyBundle }) => {
            setupAndUploadPreKeyBundle().catch(e => console.warn("[Auto-Heal] Failed to upload keys:", e));
          });

          return true;
        }
        // Decrypt failed (wrong/corrupted key) — give the user feedback instead of
        // leaving them stuck at the recovery modal with zero signal.
        const reason = result.reason ?? 'unknown';
        console.warn(`[tryAutoUnlock] Auto-unlock failed (decrypt): ${reason}`);
        toast.error(
          'Auto-unlock failed. Please unlock manually with your password or recovery phrase.',
          { id: 'auto-unlock-failed' }
        );
        return false;
      } catch (e) {
        console.warn('[tryAutoUnlock] Error during auto-unlock:', e);
        toast.error(
          'Auto-unlock failed. Please unlock manually with your password or recovery phrase.',
          { id: 'auto-unlock-failed' }
        );
        return false;
      } finally {
        set({ isInitializingCrypto: false });
      }
    },

    lockApp: async () => {
      // WIPE memory cache so decryption fails until unlocked
      privateKeysCache = null;
      set({ hasRestoredKeys: false });
      
      // Wipe auto-unlock key USER AKTIF saja (scoped per user, [FIX #5])
      const { clearKeys, setDeviceAutoUnlockReady } = await import('@lib/keyStorage');
      await clearKeys();
      await setDeviceAutoUnlockReady(false);
    },

    setDecryptedKeys: async (keys: RetrievedKeys) => {
      privateKeysCache = keys;
      set({ hasRestoredKeys: true });
      await setDeviceAutoUnlockReady(true);
      
      import('./auth').then(({ setupAndUploadPreKeyBundle }) => {
        setupAndUploadPreKeyBundle().catch(e => console.warn("[Auto-Heal] Failed to upload keys:", e));
      });
    },

    bootstrap: async (force = false) => {
      if (!force && get().accessToken && get().user) {
        set({ isBootstrapping: false });
        return;
      }

      set({ isBootstrapping: true });
      try {
        const ok = await get().silentRefresh();
        if (ok) {
          const me = await authFetch<User>("/api/users/me");
          set({ user: me, hasRestoredKeys: await hasStoredKeys() });
          localStorage.setItem("user", JSON.stringify(me));

          await get().tryAutoUnlock();
          get().loadBlockedUsers();

          // [NEW] Process Subscription Alerts (Option 1 & 3)
          if (me.systemAlert) {
            import('@utils/systemAlerts').then(m => m.processSystemAlert(me));
          }

          // Prefetch lazy chunks di latar belakang agar tidak blink saat dipakai.
          prefetchAppChunks();
        } else {
          // FALLBACK: refresh bisa gagal secara transien (network/race) sementara
          // cookie akses `at` masih valid. Jangan langsung logout — coba validasi
          // sesi langsung. Hanya logout jika sesi memang sudah tidak berlaku.
          try {
            const me = await api<User>("/api/users/me");
            set({ user: me, hasRestoredKeys: await hasStoredKeys() });
            localStorage.setItem("user", JSON.stringify(me));
            await get().tryAutoUnlock();
            get().loadBlockedUsers();
            prefetchAppChunks();
          } catch {
            throw new Error("No valid session.");
          }
        }
      } catch (error: unknown) {
        // Kasus normal saat berkunjung tanpa sesi — debug, bukan error
        console.debug("Bootstrap failed (No session):", error instanceof Error ? error.message : error);
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
        let newPqPublicKey: string | undefined = undefined;
        let newSigningKey: string | undefined = undefined;
        let newEncryptedPrivateKey: string | undefined = undefined;

        // Cek apakah user sudah punya kunci lokal (misal: Device lama tapi sesi expired)
        const alreadyHasKeys = await hasStoredKeys();
        const existingDeviceId = localStorage.getItem('deviceId') || undefined;
        
        if (alreadyHasKeys && !restoredNotSynced) {
            const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
            const localEncryptedKeys = await getEncryptedKeys();
            if (!localEncryptedKeys) throw new Error("Local keys missing unexpectedly.");

            const result = await retrievePrivateKeys(localEncryptedKeys, password);
            if (result.success && result.keys) {
                const { getSodiumLib } = await import('@utils/crypto');
                const sodium = await getSodiumLib();
                
                // Regenerate public keys from decrypted private keys for server sync
                const encryptionPublicKey = sodium.crypto_scalarmult_base(result.keys.encryption);
                const pqEncryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(result.keys.pqEncryption!);
                const signingPublicKeyBytes = result.keys.signing.slice(32);
                
                newPublicKey = sodium.to_base64(encryptionPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                newPqPublicKey = sodium.to_base64(pqEncryptionKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                newSigningKey = sodium.to_base64(signingPublicKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
                newEncryptedPrivateKey = localEncryptedKeys;
            } else {
                throw new Error("Invalid password for local keys. Please recover your account.");
            }
        } else if (restoredNotSynced) {
            // Restored from phrase, but not synced to server yet
            const { retrievePrivateKeys } = await import('@lib/crypto-worker-proxy');
            const localEncryptedKeys = await getEncryptedKeys();
            if (!localEncryptedKeys) throw new Error("Local keys missing unexpectedly after restore.");

            const result = await retrievePrivateKeys(localEncryptedKeys, password);
            if (result.success && result.keys) {
                const { getSodiumLib } = await import('@utils/crypto');
                const sodium = await getSodiumLib();
                
                const encryptionPublicKey = sodium.crypto_scalarmult_base(result.keys.encryption);
                const pqEncryptionKeyPair = sodium.crypto_kem_xwing_seed_keypair(result.keys.pqEncryption!);
                const signingPublicKeyBytes = result.keys.signing.slice(32);
                
                newPublicKey = sodium.to_base64(encryptionPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                newPqPublicKey = sodium.to_base64(pqEncryptionKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
                newSigningKey = sodium.to_base64(signingPublicKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
                newEncryptedPrivateKey = localEncryptedKeys;
            } else {
                throw new Error("Failed to read restored keys. Please restore your account again.");
            }
        }

        // Call API
        const fingerprint = await getBrowserFingerprint();
        // BUGFIX: login sebelumnya HANYA mengirim fingerprint — tanpa installationId
        // server tidak bisa mengenali perangkat yang sama → selalu dianggap device baru
        // dan modal recovery muncul setiap login ulang.
        const { getPersistentInstallationId } = await import('@utils/fingerprint');
        const installationId = await getPersistentInstallationId();
        const res = await api<{ user: User; accessToken: string; encryptedPrivateKey?: string; deviceId?: string }>("/api/auth/login", {
          method: "POST",
          headers: { 'X-Nyx-Fingerprint': fingerprint, 'X-Nyx-Installation-Id': installationId },
          body: JSON.stringify({ 
              usernameHash, 
              password,
              deviceName: getDeviceName(),
              deviceId: existingDeviceId,
              publicKey: newPublicKey,
              pqPublicKey: newPqPublicKey,
              signingKey: newSigningKey,
              encryptedPrivateKey: newEncryptedPrivateKey
          }),
        });

        // ✅ SET SESSION IMMEDIATELY (Allows navigation to migration pages)
        // isUnlocking: true menahan modal "New Device Detected" selama dekripsi
        // kunci berjalan — mencegah modal flash ~2-4 detik di device yang sama.
        set({ 
          accessToken: res.accessToken, 
          user: res.user, 
          hasRestoredKeys: false, // Baseline as false, will be checked below
          isUnlocking: true,
          blockedUserIds: [],
          loginGeneration: get().loginGeneration + 1,
        });
        localStorage.setItem("user", JSON.stringify(res.user));

        try {
          // [FIX] Identity Persistence
          // 1. Always save deviceId if server provides it (recovery fallback)
          if (res.deviceId) {
             localStorage.setItem('deviceId', res.deviceId);
          }

          // 2. Only adopt server keys if we don't have local keys
          // This prevents overwriting existing IDB data on same device
          if (res.encryptedPrivateKey && !alreadyHasKeys) {
            await saveEncryptedKeys(res.encryptedPrivateKey);
            await saveDeviceAutoUnlockKey(password);
            await setDeviceAutoUnlockReady(true);
          }

          const hasKeysNow = await hasStoredKeys();

          // CHECK: If we still don't have local keys, this is a "Blind Login" on a new device.
          if (!hasKeysNow) {
              get().loadBlockedUsers();
              connectSocket();
              throw new Error("IDENTITY_RECOVERY_REQUIRED");
          }

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

          // NOW set hasRestoredKeys, so App.tsx connects socket only after crypto is ready
          set({ user: res.user, accessToken: res.accessToken, hasRestoredKeys: hasKeysNow, blockedUserIds: [] });
          localStorage.setItem("user", JSON.stringify(res.user));

          get().loadBlockedUsers();
          prefetchAppChunks();

          if (restoredNotSynced) {
            try { await setupAndUploadPreKeyBundle(); } catch(e) { console.error("Failed to sync restored keys:", e); }
          } else if (get().hasRestoredKeys) {
            setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload pre-key bundle on login:", e));
          } else {
            toast("To enable secure messaging, restore your account from your recovery phrase in Settings.", { duration: 7000 });
          }
        } finally {
          // State settle — modal recovery (Login.tsx) baru boleh memutuskan muncul
          set({ isUnlocking: false });
        }

        try { await resetOneTimePreKeys(); } catch (e) { console.error("Reset OTPK failed:", e); }
        connectSocket();
      } catch (error: unknown) {
        console.error("Login error:", error);
        // [FIX] Don't wipe the session if we are just missing local keys.
        // The user is authenticated but needs to recover their identity.
        if (error instanceof Error && error.message === "IDENTITY_RECOVERY_REQUIRED") {
            throw error;
        }
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
          pqEncryptionPublicKeyB64,
          signingPublicKeyB64,
          encryptedPrivateKeys,
          phrase
        } = await registerAndGenerateKeys(password);

        const { getFullDeviceIdentity } = await import('@utils/fingerprint');
        const { fingerprint, installationId } = await getFullDeviceIdentity();
        const res = await api<{ accessToken: string; user: User; deviceId?: string }>("/api/auth/register", {
          method: "POST",
          headers: { 
            'X-Nyx-Fingerprint': fingerprint,
            'X-Nyx-Installation-Id': installationId
          },
          body: JSON.stringify({
            usernameHash,
            password,
            encryptedProfile,
            publicKey: encryptionPublicKeyB64,
            pqPublicKey: pqEncryptionPublicKeyB64,
            signingKey: signingPublicKeyB64,
            encryptedPrivateKeys,
            deviceName: getDeviceName(),
            turnstileToken
          }),
        });

        if (res.deviceId) {
           localStorage.setItem('deviceId', res.deviceId);
        }

        // [FIX #5] identitas harus ter-set SEBELUM menulis auto-unlock key —
        // di register, user belum ada di store/localStorage saat titik ini.
        setAutoUnlockIdentity(res.user.id);
        await saveEncryptedKeys(encryptedPrivateKeys);
        await saveDeviceAutoUnlockKey(password);
        await setDeviceAutoUnlockReady(true);
        set({ hasRestoredKeys: true });

        try {
          const result = await retrievePrivateKeys(encryptedPrivateKeys, password);
          if (result.success) privateKeysCache = result.keys;
        } catch (_e) {}

        set({ user: res.user, accessToken: res.accessToken, loginGeneration: get().loginGeneration + 1 });
        localStorage.setItem("user", JSON.stringify(res.user));

        setupAndUploadPreKeyBundle().catch(e => console.error("Failed to upload initial pre-key bundle:", e));
        prefetchAppChunks();

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
        
        // Pembersihan Sesi (Soft Logout) - Tetap pertahankan data terenkripsi di IDB (Local-First).
        // [FIX #5] clearKeys hanya menghapus slot auto-unlock milik user ini —
        // sesi unlock akun lain di tab yang sama tidak terganggu.
        await clearKeys();
        localStorage.removeItem('user');
        
        set({ user: null, accessToken: null, hasRestoredKeys: false });
        disconnectSocket();
        const { clearReconnectTimer } = await import('./connection');
        clearReconnectTimer();
        const { clearBlobCache } = await import('../utils/blobCache');
        clearBlobCache();

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

        // Nuclear local wipe and redirect
        await executeLocalWipe('/login');

        set({ user: null, accessToken: null });
        disconnectSocket();
        const { clearBlobCache } = await import('../utils/blobCache');
        clearBlobCache();

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
      toast.success(i18n.t('common:profile_updated', 'Profile updated!'));
    },

    updateSubscription: (tier: SubscriptionTier) => {
      set(state => {
        if (!state.user) return state;
        const newUser = { ...state.user, subscriptionTier: tier };
        localStorage.setItem("user", JSON.stringify(newUser));
        return { user: newUser };
      });
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
        toast.loading(i18n.t('common:uploading_to_cloud', 'Uploading to Cloud...'), { id: toastId });
        const fileUrl = await uploadToR2(fileToProcess, 'avatars', () => {});
        toast.success(i18n.t('common:avatar_uploaded', 'Avatar uploaded! (Profile update required)'), { id: toastId });
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
      const publicKey = sodium.crypto_scalarmult_base(keys.encryption);
      return { publicKey, privateKey: keys.encryption };
    },
    async getPqEncryptionKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodiumLib } = await import('@utils/crypto');
      const sodium = await getSodiumLib();
      if (!keys.pqEncryption) throw new Error("PQ Encryption key missing");
      const kp = sodium.crypto_kem_xwing_seed_keypair(keys.pqEncryption);
      return kp;
    },
    async getSignedPreKeyPair() {
      const keys = await retrieveAndCacheKeys();
      const { getSodiumLib } = await import('@utils/crypto');
      const sodium = await getSodiumLib();
      const publicKey = sodium.crypto_scalarmult_base(keys.signedPreKey);
      return { publicKey, privateKey: keys.signedPreKey };
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
        toast.success(i18n.t('common:user_unblocked_plain', 'User unblocked'), { id: toastId });
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
      if (refreshPromise) return refreshPromise;

      refreshPromise = (async () => {
        try {
          const { api } = await import('@lib/api');
          const { runExclusive } = await import('@lib/refreshLock');
          const { refreshWithRetry } = await import('@lib/refreshRetry');

          const doRefresh = async () => {
            // Retry hingga 3× — kegagalan refresh yang transien (network hiccup,
            // rotasi konkuren dari tab lain, dsb.) tidak boleh memaksa logout.
            // Berkat grace di server, menyajikan ulang rt yang baru dirotasi dalam
            // beberapa detik justru menghasilkan token baru (bukan revoke family).
            const data = await refreshWithRetry(async () =>
              runExclusive(async () =>
                api<Record<string, unknown>>('/api/auth/refresh', {
                  method: 'POST',
                })
              )
            );
            if (data && typeof data.accessToken === 'string') {
              set({ accessToken: data.accessToken });
              return true;
            }
            return false;
          };

          // Cross-tab single-flight refresh.
          //
          // Two tabs racing POST /refresh send the SAME `rt` cookie; the server
          // rotates it once and treats the second as a reuse attack → revokes the
          // whole session family (both tabs logged out). `runExclusive` already
          // serializes the POST via the Web Locks API (with a localStorage
          // fallback), but the *second* tab must NOT blindly fire its own POST
          // afterwards — by then its refresh token is stale and would re-trigger
          // reuse detection.
          //
          // So, inside the lock we FIRST probe whether the session was already
          // refreshed by the previous holder: a cheap authenticated GET. If it
          // succeeds (the cookie was already rotated by the other tab) we skip our
          // own POST /refresh entirely and report success. Only on failure do we
          // proceed with the actual refresh.
          //
          // NOTE: we use the non-refreshing `api` (not `authFetch`) for the probe.
          // `authFetch` auto-invokes silentRefresh() on 401, which would recurse
          // into this same refreshPromise and deadlock inside the lock.
          if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            return await navigator.locks.request('nyx-silent-refresh', async () => {
              try {
                await api('/api/users/me');
                return true; // session already valid → skip our own refresh
              } catch {
                return await doRefresh();
              }
            });
          }

          // Fallback: no Web Locks support → original behavior unchanged.
          return await doRefresh();
        } finally {
          refreshPromise = null;
        }
      })();

      return refreshPromise;
    },  };
}, Object.is);
;

// [FIX #5] Ekspos store untuk keyStorage: scoping auto-unlock key per user
// butuh identitas user aktif tanpa import statis (menghindari cycle module).
// Harus SETELAH createWithEqualityFn selesai — reference di dalam initializer
// dievaluasi sebelum const selesai (TDZ → ReferenceError).
(globalThis as Record<string, unknown>).__nyxAuthStore = useAuthStore;

