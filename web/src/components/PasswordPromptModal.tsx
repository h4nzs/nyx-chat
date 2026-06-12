import { useState, useEffect } from 'react';
import { useModalStore } from '@store/modal';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { IoFingerPrint } from "react-icons/io5";
import toast from 'react-hot-toast';

export default function PasswordPromptModal() {
  const { t } = useTranslation(['modals', 'common', 'auth']);
  const { isPasswordPromptOpen, onPasswordSubmit, hidePasswordPrompt } = useModalStore(useShallow(s => ({
    isPasswordPromptOpen: s.isPasswordPromptOpen, onPasswordSubmit: s.onPasswordSubmit, hidePasswordPrompt: s.hidePasswordPrompt
  })));
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasBioVault, setHasBioVault] = useState(false);

  useEffect(() => {
    if (isPasswordPromptOpen) {
      setHasBioVault(!!localStorage.getItem('nyx_bio_vault'));
      setError('');
    }
  }, [isPasswordPromptOpen]);

  const handleCancel = () => {
    onPasswordSubmit(null);
    setPassword('');
    hidePasswordPrompt();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPasswordPromptOpen) {
        handleCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPasswordPromptOpen]);

  if (!isPasswordPromptOpen) {
    return null;
  }

  const handleBiometricUnlock = async () => {
    setIsLoading(true);
    setError('');
    try {
      const { api } = await import('@lib/api');
      const { unlockWithBiometric } = await import('@lib/biometricUnlock');
      const { restoreFromPhrase } = await import('@lib/crypto-worker-proxy');
      const { saveEncryptedKeys, saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady } = await import('@lib/keyStorage');
      
      const options = await api<unknown>("/api/auth/webauthn/login/options");
      const { recoveryPhrase } = await unlockWithBiometric(options as Record<string, unknown>);

      if (recoveryPhrase) {
        const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
        const sessionPassword = sodium.to_hex(sodium.randombytes_buf(16)); 
        
        const { encryptedPrivateKeys } = await restoreFromPhrase(recoveryPhrase, sessionPassword);
        
        await saveEncryptedKeys(encryptedPrivateKeys);
        await saveDeviceAutoUnlockKey(sessionPassword);
        await setDeviceAutoUnlockReady(true);
        
        toast.success(t('auth:status.vault_unlocked', 'Vault unlocked via Biometric PRF!'));
        
        // Pass the new session password to the caller so they can decrypt the new keys
        await (onPasswordSubmit(sessionPassword) as unknown as Promise<void>);
        setPassword('');
        hidePasswordPrompt();
      } else {
        throw new Error(t('auth:errors.biometric_corrupt', 'Biometric key invalid or corrupted. Please enter password manually.'));
      }
    } catch (err: unknown) {
      console.error("Biometric unlock error:", err);
      // Don't show confusing error if user simply cancels the biometric prompt
      if ((err as Error).name !== 'NotAllowedError' && !(err instanceof Error ? err.message : '').includes('cancelled') && !(err as Error).message.includes('User cancelled')) {
        const msg = err instanceof Error ? err.message : t('auth:errors.biometric_failed', 'Biometric login failed. Please use password or try again.');
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    
    setIsLoading(true);
    setError('');
    try {
      // Tunggu hingga proses validasi/dekripsi di authStore selesai
      await (onPasswordSubmit(password) as unknown as Promise<void>);
      setPassword('');
      hidePasswordPrompt();
    } catch (err: unknown) {
      console.error("Password submission error:", err);
      const msg = err instanceof Error ? err.message : t('modals:password_prompt.error');
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleCancel}
    >
      <div 
        className="bg-[#1f2937] border-2 border-gray-700 rounded-lg p-8 w-full max-w-md mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-gray-800 border-2 border-orange-500 flex items-center justify-center mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-orange-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">{t('modals:password_prompt.title')}</h2>
          <p className="text-gray-400 text-sm">{t('modals:password_prompt.desc')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-bold text-center animate-shake">
              {error}
            </div>
          )}
          
          <div className="relative">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
              className="w-full bg-[#111827] border-2 border-gray-700 rounded-lg py-4 px-4 pr-12 text-white focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/30 transition-all duration-300 disabled:opacity-50"
              placeholder={t('modals:password_prompt.placeholder')}
              autoFocus
            />
            <div className="absolute right-4 top-1/2 transform -translate-y-1/2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            </div>
          </div>

          {hasBioVault && (
            <div className="flex flex-col gap-2">
              <div className="relative flex items-center py-2">
                <div className="flex-grow border-t border-gray-700"></div>
                <span className="flex-shrink-0 mx-4 text-gray-500 text-xs uppercase tracking-wider">{t('common:words.or', 'OR')}</span>
                <div className="flex-grow border-t border-gray-700"></div>
              </div>
              <button
                type="button"
                onClick={handleBiometricUnlock}
                disabled={isLoading}
                className="w-full py-3 px-4 rounded-lg bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20 transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-3"
              >
                <IoFingerPrint size={20} />
                <span>{t('auth:buttons.biometric_unlock', 'Unlock with Biometrics')}</span>
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={handleCancel}
              disabled={isLoading}
              className="py-3 px-4 rounded-lg bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700 transition-all duration-300 disabled:opacity-50"
            >
              {t('common:actions.abort')}
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="py-3 px-4 rounded-lg bg-orange-600 text-white hover:bg-orange-700 shadow-[0_0_15px_rgba(249,115,22,0.4)] transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  <span>{t('common:status.decrypting', 'Decrypting...')}</span>
                </>
              ) : (
                t('common:actions.unlock')
              )}
            </button>
          </div>
        </form>

        <div className="mt-6 pt-4 border-t border-gray-800">
          <div className="flex justify-between text-xs text-gray-500">
            <span>{t('modals:password_prompt.vault_id')}</span>
            <span>{t('modals:password_prompt.status_locked')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
