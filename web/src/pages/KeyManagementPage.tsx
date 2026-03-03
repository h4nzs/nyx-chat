import { Link } from 'react-router-dom';
import { FiKey, FiShield, FiRefreshCw, FiChevronLeft, FiAlertTriangle } from 'react-icons/fi';
import { useState } from 'react';
import { useAuthStore, setupAndUploadPreKeyBundle } from '@store/auth';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { useModalStore } from '@store/modal';
import RecoveryPhraseModal from '@components/RecoveryPhraseModal';
import { api } from '@lib/api';
import { getRecoveryPhrase, generateNewKeys } from '@lib/crypto-worker-proxy';
import { getEncryptedKeys, saveEncryptedKeys } from '@lib/keyStorage';

export default function KeyManagementPage() {
  const { logout } = useAuthStore(state => ({ 
    logout: state.logout,
  }));
  const [isProcessing, setIsProcessing] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const { showConfirm, showPasswordPrompt } = useModalStore();

  const handleShowRecovery = () => {
    showPasswordPrompt(async (password) => {
      if (!password) return;

      setIsProcessing(true);
      try {
        const encryptedKeys = await getEncryptedKeys();
        if (!encryptedKeys) throw new Error("No encrypted key found in storage.");
        
        const phrase = await getRecoveryPhrase(encryptedKeys, password);
        if (!phrase) {
          throw new Error("Failed to decrypt keys. Password mismatch.");
        }
        
        setRecoveryPhrase(phrase);
        setShowRecoveryModal(true);

      } catch (error: any) {
        toast.error(error.message || "Operation failed.");
      } finally {
        setIsProcessing(false);
      }
    });
  };

  const handleGenerateNew = () => {
    showConfirm(
      "INITIATE KEY ROTATION?",
      "WARNING: DESTRUCTIVE ACTION. Previous message history will become undecryptable. This action is irreversible.",
      () => {
        showPasswordPrompt(async (password) => {
          if (!password) return;
          setIsProcessing(true);
          try {
            const {
              encryptedPrivateKeys,
              encryptionPublicKeyB64,
              signingPublicKeyB64,
            } = await generateNewKeys(password);
            
            await saveEncryptedKeys(encryptedPrivateKeys);
            
            await setupAndUploadPreKeyBundle();

            toast.success('Keys Rotated. Rebooting Session...');
            // Force a reload to re-bootstrap the app with the new keys
            setTimeout(() => {
              window.location.reload();
            }, 1000);

          } catch (error: any) {
            toast.error(error.message || "Rotation failed.");
          } finally {
            setIsProcessing(false);
          }
        });
      }
    );
  };

  return (
    <div className="min-h-screen bg-bg-main flex flex-col items-center justify-center p-4 sm:p-8">
      
      {/* Back Button */}
      <div className="w-full max-w-2xl mb-8">
        <Link 
          to="/settings" 
          className="
            inline-flex items-center gap-2 p-3 rounded-xl
            bg-bg-main text-text-secondary
            shadow-neu-flat-light dark:shadow-neu-flat-dark
            active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
            hover:text-accent transition-all
          "
        >
          <FiChevronLeft size={20} />
          <span className="font-bold text-sm uppercase tracking-wide">Return</span>
        </Link>
      </div>

      <div className="
        w-full max-w-2xl relative overflow-hidden
        bg-bg-main rounded-3xl
        shadow-neu-flat-light dark:shadow-neu-flat-dark
        border border-white/20 dark:border-black/20
      ">
        {/* Vault Header */}
        <div className="bg-bg-surface p-8 border-b border-black/5 dark:border-white/5 relative">
          <div className="flex items-center gap-6">
            <div className="p-4 rounded-full bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark text-accent">
               <FiKey size={32} />
            </div>
            <div>
              <h1 className="text-2xl font-black uppercase tracking-tighter text-text-primary">Cryptographic Vault</h1>
              <p className="text-xs font-mono text-text-secondary mt-1 uppercase tracking-widest">End-to-End Encryption Protocol</p>
            </div>
          </div>
          
          {/* Decorative Bolts */}
          <div className="absolute top-4 right-4 w-3 h-3 rounded-full bg-text-secondary/20 shadow-inner"></div>
          <div className="absolute bottom-4 right-4 w-3 h-3 rounded-full bg-text-secondary/20 shadow-inner"></div>
        </div>

        <div className="p-8 space-y-8">
          <p className="text-sm text-text-secondary leading-relaxed font-medium">
            Your private keys are the only way to decrypt your messages. They are stored locally on this device. 
            <strong className="text-text-primary"> Losing these keys means losing your message history forever.</strong>
          </p>

          <div className="space-y-6">
            {/* Recovery Option */}
            <div className="p-6 rounded-2xl bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark border border-white/10">
              <div className="flex items-start gap-4 mb-4">
                 <FiShield className="text-green-500 mt-1" size={20} />
                 <div>
                   <h3 className="font-bold text-text-primary">Master Recovery Phrase</h3>
                   <p className="text-xs text-text-secondary mt-1">Reveal your 24-word seed phrase for backup.</p>
                 </div>
              </div>
              <button 
                onClick={handleShowRecovery} 
                disabled={isProcessing} 
                className="
                  w-full py-3 rounded-xl font-bold uppercase tracking-wider text-sm
                  bg-bg-main text-text-primary
                  shadow-neu-flat-light dark:shadow-neu-flat-dark
                  active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                  hover:text-green-500 transition-colors
                "
              >
                {isProcessing ? <Spinner size="sm" /> : 'Reveal Phrase'}
              </button>
            </div>

            {/* Danger Zone */}
            <div className="relative p-6 rounded-2xl bg-red-500/5 border border-red-500/20 overflow-hidden">
              {/* Warning Stripes */}
              <div className="absolute top-0 left-0 w-full h-1 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,#ef4444_10px,#ef4444_20px)] opacity-50"></div>
              
              <div className="flex items-start gap-4 mb-4">
                 <FiAlertTriangle className="text-red-500 mt-1" size={20} />
                 <div>
                   <h3 className="font-bold text-red-600 dark:text-red-400">Key Rotation (Destructive)</h3>
                   <p className="text-xs text-red-600/70 dark:text-red-400/70 mt-1">Generates new identity keys. Old messages will become unreadable.</p>
                 </div>
              </div>
              
              <button 
                onClick={handleGenerateNew} 
                disabled={isProcessing} 
                className="
                  w-full py-3 rounded-xl font-bold uppercase tracking-wider text-sm
                  bg-bg-main text-red-500
                  shadow-neu-flat-light dark:shadow-neu-flat-dark
                  active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                  hover:bg-red-500 hover:text-white transition-all
                "
              >
                {isProcessing ? <Spinner size="sm" /> : 'Rotate Keys'}
              </button>
            </div>
          </div>
        </div>
      </div>
      
      {showRecoveryModal && <RecoveryPhraseModal phrase={recoveryPhrase} onClose={() => setShowRecoveryModal(false)} />}
    </div>
  );
}
