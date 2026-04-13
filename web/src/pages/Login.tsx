import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { useAuthStore, type User } from "../store/auth";
import { useShallow } from 'zustand/react/shallow';
import { useModalStore } from "../store/modal";
import AuthForm from "../components/AuthForm";
import { IoFingerPrint } from "react-icons/io5";
import { startAuthentication, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from "@lib/api";
import { retrievePrivateKeys, restoreFromPhrase, hashUsername } from "@lib/crypto-worker-proxy";
import { connectSocket } from "@lib/socket";
import { getEncryptedKeys, saveEncryptedKeys, saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady, checkPanicPassword } from "@lib/keyStorage";
import { unlockWithBiometric } from "@lib/biometricUnlock";
import { executeLocalWipe } from "@lib/nukeProtocol";
import toast from "react-hot-toast";
import { FiLock, FiKey, FiShield } from "react-icons/fi";
import SEO from '../components/SEO';
import LanguageSwitcher from '../components/LanguageSwitcher';

import i18n from '../i18n';
export default function Login() {
  const { t } = useTranslation(['auth', 'common']);
  const [error, setError] = useState("");
  const [isBiometricsAvailable, setIsBiometricsAvailable] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const { login } = useAuthStore(useShallow(s => ({
    login: s.login,
  })));

  useEffect(() => {
    // Cek ketersediaan hardware biometric
    platformAuthenticatorIsAvailable().then((available: boolean) => {
      setIsBiometricsAvailable(available);
    });
  }, []);

  const handleLogin = async (data: { a: string; b?: string }) => {
    if (!data.a || !data.b) {
      setError(t('auth:errors.required_both'));
      return;
    }
    try {
      const restoredNotSynced = location.state?.restoredNotSynced === true;

      // --- PANIC PASSWORD CHECK FOR NORMAL LOGIN ---
      const isPanic = await checkPanicPassword(data.b);
      if (isPanic) {
        const toastId = toast.loading(t('auth:status.authenticating'));
        setTimeout(async () => {
          try {
            await executeLocalWipe();
          } catch (e) {
            console.error("Wipe failed", e);
          } finally {
            toast.dismiss(toastId);
          }
        }, 2000); 
        return; 
      }
      
      // CLIENT-SIDE BLIND INDEXING
      // Hash the username input before sending to server.
      const usernameHash = await hashUsername(data.a);

      await login(usernameHash, data.b, restoredNotSynced);

      navigate("/chat");

    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : 'Unknown error') || t('auth:messages.login_failed'));
    }
  };

  async function handleBiometricLogin() {
    try {
      setError("");

      // A. Minta Challenge Login
      const options = await api<unknown>("/api/auth/webauthn/login/options");

      // B. Browser minta fingerprint user (Login Server + Unlock Local Vault)
      const { authResp, recoveryPhrase } = await unlockWithBiometric(options as Record<string, unknown>);

      // C. Verifikasi ke Server
      const result = await api<{ verified: boolean; user: User; accessToken: string; encryptedPrivateKey?: string }>("/api/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify(authResp)
      });

      if (result.verified && result.accessToken) {
        // D. Login Sukses -> Set Store
        useAuthStore.getState().setAccessToken(result.accessToken);
        useAuthStore.getState().setUser(result.user);

        // E. MAGIC UNLOCK: Jika PRF berhasil membuka Recovery Phrase
        if (recoveryPhrase) {
            // Kita punya Phrase! Kita bisa regenerasi semua kunci tanpa password user.
            // Buat password sementara untuk sesi lokal ini agar bisa disimpan di IDB
            const sessionPassword = crypto.randomUUID(); 
            
            // Regenerasi bundle kunci dari phrase
            const { encryptedPrivateKeys } = await restoreFromPhrase(recoveryPhrase, sessionPassword);
            
            // Simpan ke IDB
            await saveEncryptedKeys(encryptedPrivateKeys);
            await saveDeviceAutoUnlockKey(sessionPassword);
            await setDeviceAutoUnlockReady(true);
            
            // Beritahu store bahwa kunci sudah siap
            useAuthStore.getState().setHasRestoredKeys(true);
            
            toast.success(t('auth:status.vault_unlocked'));
        } else if (result.encryptedPrivateKey) {
            // Fallback: Jika PRF tidak jalan/tidak disetup, pakai bundle dari server (tapi masih terkunci password)
            const { saveEncryptedKeys } = await import("@lib/keyStorage");
            await saveEncryptedKeys(result.encryptedPrivateKey);
            useAuthStore.getState().setHasRestoredKeys(true);
        }

        // Try auto-unlock (akan sukses jika PRF jalan tadi)
        const autoUnlockSuccess = await useAuthStore.getState().tryAutoUnlock();
        
        if (!autoUnlockSuccess) {
             // Jika PRF gagal/belum setup, user harus input password manual untuk dekripsi
             if (localStorage.getItem('nyx_bio_vault') && !recoveryPhrase) {
                console.warn("Biometric PRF key derivation failed or mismatched.");
                toast.error(t('auth:errors.biometric_corrupt'));
                localStorage.removeItem('nyx_bio_vault'); 
             }
             
             const hasKeys = await getEncryptedKeys();
             if (hasKeys) {
                useModalStore.getState().showPasswordPrompt(async (password) => {
                    if (!password) return;

                    // --- PANIC PASSWORD CHECK ---
                    const isPanic = await checkPanicPassword(password);
                    if (isPanic) {
                      // Fake loading to deceive the attacker
                      const toastId = toast.loading(t('auth:status.decrypting'));
                      setTimeout(async () => {
                        try {
                          await executeLocalWipe();
                        } catch (e) {
                          console.error("Wipe failed", e);
                        } finally {
                          toast.dismiss(toastId);
                        }
                      }, 2000); 
                      return; 
                    }
                    // --- END PANIC CHECK ---

                    try {
                        const encryptedKeys = await getEncryptedKeys();
                        if (!encryptedKeys) {
                            toast.error(t('auth:messages.keys_not_found'));
                            return;
                        }
                        const result = await retrievePrivateKeys(encryptedKeys, password);
                        if (result.success) {
                            const { saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady } = await import("@lib/keyStorage");
                            await saveDeviceAutoUnlockKey(password);
                            await setDeviceAutoUnlockReady(true);
                            useAuthStore.getState().setDecryptedKeys(result.keys);
                            await useAuthStore.getState().loadBlockedUsers();
                            connectSocket();
                            navigate("/chat");
                        } else {
                            toast.error(t('auth:messages.decrypt_failed'));
                        }
                    } catch (e) {
                        toast.error(i18n.t('errors:something_went_wrong_when_decrypting', 'Something went wrong when decrypting.'));
                    }
                });
                return;
             }
        }
        
        await useAuthStore.getState().loadBlockedUsers();
        connectSocket();

        navigate("/chat");
      }
    } catch (err: unknown) {
      console.error("Biometric login error:", err);

      // Tangani berbagai jenis error WebAuthn
      if ((err as Error).name === 'NotAllowedError' || (err instanceof Error ? err.message : 'Unknown error')?.includes('cancelled')) {
        setError(t('auth:messages.biometric_cancelled'));
        return;
      } 
      
      toast.error(t('auth:errors.biometric_failed'));
      
      if ((err as Error).name === 'SecurityError') {
        setError(t('auth:errors.biometric_security'));
      } else if ((err as Error).name === 'AbortError') {
        setError(t('auth:errors.biometric_abort'));
      } else if ((err as Error).name === 'InvalidStateError') {
        setError(t('auth:errors.biometric_locked'));
      } else {
        setError(t('auth:errors.biometric_failed'));
      }
      
      // Fallback: Show password prompt if keys exist
      const hasKeys = await getEncryptedKeys();
      if (hasKeys) {
         useModalStore.getState().showPasswordPrompt(async (password) => {
            if (!password) return;

            const isPanic = await checkPanicPassword(password);
            if (isPanic) {
              const toastId = toast.loading(t('auth:status.decrypting'));
              setTimeout(async () => {
                try {
                  await executeLocalWipe();
                } catch (e) {
                  console.error("Wipe failed", e);
                } finally {
                  toast.dismiss(toastId);
                }
              }, 2000); 
              return; 
            }

            try {
                const encryptedKeys = await getEncryptedKeys();
                if (!encryptedKeys) return;
                const result = await retrievePrivateKeys(encryptedKeys, password);
                if (result.success) {
                    const { saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady } = await import("@lib/keyStorage");
                    await saveDeviceAutoUnlockKey(password);
                    await setDeviceAutoUnlockReady(true);
                    useAuthStore.getState().setDecryptedKeys(result.keys);
                    await useAuthStore.getState().loadBlockedUsers();
                    connectSocket();
                    navigate("/chat");
                } else {
                    toast.error(t('auth:messages.decrypt_failed'));
                }
            } catch (e) {
                toast.error(i18n.t('auth:messages.decrypt_failed', 'An error occurred during decryption.'));
            }
         });
      }
    }
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-bg-main relative">
      <LanguageSwitcher />
      <SEO title="Login" description="Sign in to your NYX secure enclave to access your E2EE chats." canonicalUrl="/login" />
      {/* Left Panel - Concrete Security Panel */}
      <div className="w-full md:w-2/5 bg-bg-surface p-8 flex flex-col justify-center shadow-2xl z-10">
        <div className="max-w-md w-full mx-auto">
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-accent flex items-center justify-center mr-3 shadow-neu-flat dark:shadow-neu-flat-dark">
              <div className="w-8 h-8 rounded bg-bg-main opacity-50"></div>
            </div>
            <h1 className="text-3xl font-black text-text-primary tracking-tighter">{t('auth:titles.secure_vault')}</h1>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-accent mb-2">{t('auth:titles.access_terminal')}</h2>
            <p className="text-text-secondary">{t('auth:subtitles.login_desc')}</p>
          </div>

          {error && <p className="text-red-500 text-center mb-4 text-sm">{error}</p>}

          <AuthForm
            onSubmit={handleLogin}
            button={t('auth:buttons.login')}
          />

          {isBiometricsAvailable && (
            <button
              type="button"
              onClick={handleBiometricLogin}
              className="w-full flex items-center justify-center gap-3 mt-6 py-3 px-4 rounded-xl bg-bg-main text-text-primary font-bold transition-all duration-300 shadow-neu-flat dark:shadow-neu-flat-dark active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark hover:text-accent"
            >
              <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-accent">
                <IoFingerPrint size={16} />
              </div>
              <span>{t('auth:buttons.biometric_unlock')}</span>
            </button>
          )}

          <div className="text-center mt-8 pt-6 border-t border-white/10 dark:border-white/5">
            <p className="text-text-secondary text-sm mb-4">
              {t('auth:links.no_account')} <Link to="/register" className="font-bold text-accent hover:underline">{t('auth:links.sign_up')}</Link>
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-4">
              <Link to="/restore" className="text-sm text-accent hover:underline">{t('auth:links.restore')}</Link>
              <Link to="/migrate-receive" className="text-sm text-accent hover:underline">{t('auth:links.transfer')}</Link>
            </div>
            <div className="mt-4 pt-4 border-t border-white/10 dark:border-white/5">
              <a href="https://nyx-app.my.id/privacy" target="_blank" rel="noopener noreferrer" className="text-xs text-text-secondary hover:text-accent transition-colors">{t('common:nav.privacy')} & {t('common:nav.terms')}</a>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Dynamic Visualization */}
      <div className="hidden md:flex w-full md:w-3/5 bg-bg-main relative overflow-hidden items-center justify-center p-8">
        {/* Abstract 3D visualization */}
        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/4 left-1/4 w-32 h-32 rounded-full bg-accent/10 blur-3xl animate-pulse"></div>
          <div className="absolute bottom-1/3 right-1/3 w-48 h-48 rounded-full bg-accent/5 blur-3xl animate-pulse delay-1000"></div>
        </div>

        {/* Grid pattern */}
        <div className="absolute inset-0 z-0 opacity-10"
             style={{
               backgroundImage: `linear-gradient(var(--color-text-secondary) 1px, transparent 1px), linear-gradient(to right, var(--color-text-secondary) 1px, transparent 1px)`,
               backgroundSize: '40px 40px'
             }}></div>

        {/* Central security graphic */}
        <div className="relative z-10 text-center max-w-lg">
          <div className="inline-block mb-8 relative">
            <div className="w-48 h-48 rounded-full border-4 border-accent/30 flex items-center justify-center">
              <div className="w-32 h-32 rounded-full border-4 border-accent/20 flex items-center justify-center">
                <div className="w-20 h-20 rounded-full border-4 border-accent/10 flex items-center justify-center shadow-neu-pressed dark:shadow-neu-pressed-dark">
                  <div className="w-12 h-12 rounded-full bg-accent flex items-center justify-center shadow-[0_0_20px_rgba(var(--accent),0.5)]">
                    <div className="w-6 h-6 rounded-full bg-bg-main animate-pulse opacity-50"></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Scanning animation */}
            <div className="absolute inset-0 rounded-full border-4 border-accent animate-ping opacity-20"></div>
          </div>

          <h2 className="text-3xl font-black text-text-primary mb-4 tracking-tighter">{t('auth:marketing.industrial_security')}</h2>
          <p className="text-text-secondary mb-6">{t('auth:marketing.industrial_desc')}</p>

          <div className="grid grid-cols-3 gap-4 mt-12">
            <div className="p-4 bg-bg-surface rounded-xl shadow-neu-flat dark:shadow-neu-flat-dark">
              <div className="text-accent mb-2 flex justify-center"><FiLock size={24} /></div>
              <h3 className="font-bold text-text-primary text-xs uppercase tracking-wider">{t('auth:marketing.e2e_encrypted')}</h3>
            </div>
            <div className="p-4 bg-bg-surface rounded-xl shadow-neu-flat dark:shadow-neu-flat-dark">
              <div className="text-accent mb-2 flex justify-center"><FiKey size={24} /></div>
              <h3 className="font-bold text-text-primary text-xs uppercase tracking-wider">{t('auth:marketing.key_ownership')}</h3>
            </div>
            <div className="p-4 bg-bg-surface rounded-xl shadow-neu-flat dark:shadow-neu-flat-dark">
              <div className="text-accent mb-2 flex justify-center"><FiShield size={24} /></div>
              <h3 className="font-bold text-text-primary text-xs uppercase tracking-wider">{t('auth:marketing.privacy_first')}</h3>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
