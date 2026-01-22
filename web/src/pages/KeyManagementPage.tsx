import { Link } from 'react-router-dom';
import { FiKey, FiShield, FiRefreshCw } from 'react-icons/fi';
import { useState } from 'react';
import { useAuthStore, setupAndUploadPreKeyBundle } from '@store/auth';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { useModalStore } from '@store/modal';
import RecoveryPhraseModal from '@components/RecoveryPhraseModal';
import { api } from '@lib/api';
import { getRecoveryPhrase, generateNewKeys } from '@lib/crypto-worker-proxy';

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
        const encryptedKeys = localStorage.getItem('encryptedPrivateKeys');
        if (!encryptedKeys) throw new Error("No encrypted key found in storage.");
        
        const phrase = await getRecoveryPhrase(encryptedKeys, password);
        if (!phrase) {
          throw new Error("Failed to decrypt keys or master seed. The password may be incorrect.");
        }
        
        setRecoveryPhrase(phrase);
        setShowRecoveryModal(true);

      } catch (error: any) {
        toast.error(error.message || "Failed to generate recovery phrase.");
      } finally {
        setIsProcessing(false);
      }
    });
  };

  const handleGenerateNew = () => {
    showConfirm(
      "Generate New Keys",
      "WARNING: This is a destructive action. You will lose access to all past encrypted messages. This cannot be undone.",
      () => {
        showPasswordPrompt(async (password) => {
          if (!password) return;
          setIsProcessing(true);
          try {
            // 1. Generate new keys using the worker
            const {
              encryptedPrivateKeys,
              encryptionPublicKeyB64,
              signingPublicKeyB64,
            } = await generateNewKeys(password);
            
            // 2. Store them in localStorage
            localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
            localStorage.setItem('publicKey', encryptionPublicKeyB64);
            localStorage.setItem('signingPublicKey', signingPublicKeyB64);
            
            // 3. Upload the new pre-key bundle to the server
            await setupAndUploadPreKeyBundle();

            toast.success('New keys generated and uploaded! For security, you will be logged out.', { duration: 5000 });
            setTimeout(() => {
              logout();
            }, 2000);

          } catch (error: any) {
            toast.error(error.message || "Failed to generate new keys.");
          } finally {
            setIsProcessing(false);
          }
        });
      }
    );
  };

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-main text-text-primary p-4">
      <div className="w-full max-w-2xl card-neumorphic p-8">
        <div className="flex items-center gap-4 mb-6">
          <FiKey className="text-accent text-3xl" />
          <h1 className="text-2xl font-bold text-text-primary">Encryption Key Management</h1>
        </div>
        <p className="text-text-secondary mb-6">
          Your end-to-end encryption keys ensure that only you and the recipient can read your messages.
          Back up your key to restore your chat history on a new device.
        </p>

        <div className="space-y-4">
          <button onClick={handleShowRecovery} disabled={isProcessing} className="btn btn-secondary w-full justify-center gap-3">
            {isProcessing ? <Spinner size="sm" /> : <FiShield />}
            <span>{isProcessing ? 'Processing...' : 'Show Recovery Phrase'}</span>
          </button>
          <button onClick={handleGenerateNew} disabled={isProcessing} className="btn-destructive-neumorphic w-full justify-center gap-3">
            {isProcessing ? <Spinner size="sm" /> : <FiRefreshCw />}
            <span>{isProcessing ? 'Generating...' : 'Generate New Keys'}</span>
          </button>
        </div>

        <div className="mt-8 text-center">
          <Link to="/settings" className="text-accent-color hover:underline">
            &larr; Back to Settings
          </Link>
        </div>
      </div>
      {showRecoveryModal && <RecoveryPhraseModal phrase={recoveryPhrase} onClose={() => setShowRecoveryModal(false)} />}
    </div>
  );
}
