import { Link } from 'react-router-dom';
import { FiKey, FiShield, FiRefreshCw } from 'react-icons/fi';
import { IoFingerPrint } from "react-icons/io5";
import { useState } from 'react';
import { useAuthStore, setupAndUploadPreKeyBundle } from '@store/auth';
import { retrievePrivateKeys, generateKeyPairs, storePrivateKeys, exportPublicKey } from '@utils/keyManagement';
import { getSodium } from '@lib/sodiumInitializer';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { useModalStore } from '@store/modal';
import * as bip39 from 'bip39';
import RecoveryPhraseModal from '@components/RecoveryPhraseModal';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '@lib/api';

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
        
        const keys = await retrievePrivateKeys(encryptedKeys, password);
        if (!keys || !keys.masterSeed) {
          throw new Error("Failed to decrypt keys or master seed. The password may be incorrect.");
        }
        
        const mnemonic = bip39.entropyToMnemonic(keys.masterSeed);
        setRecoveryPhrase(mnemonic);
        setShowRecoveryModal(true);

      } catch (error: any) {
        toast.error(error.message || "Failed to generate recovery phrase.");
      } finally {
        setIsProcessing(false);
      }
    });
  };

  const handleRegisterDevice = async () => {
    setIsProcessing(true);
    try {
      const regOptions = await api("/api/auth/webauthn/register-options");
      const attResp = await startRegistration(regOptions);
      const verificationJSON = await api("/api/auth/webauthn/register-verify", {
        method: "POST",
        body: JSON.stringify(attResp),
      });

      if (verificationJSON?.verified) {
        toast.success("Device registered successfully!");
      } else {
        throw new Error("Failed to verify device registration.");
      }

    } catch (error: any) {
      toast.error(error.message || "Device registration failed.");
    } finally {
      setIsProcessing(false);
    }
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
            // 1. Generate new keys locally
            const sodium = await getSodium();
            const masterSeed = sodium.randombytes_buf(32);
            const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
            const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));
            const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
            const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);

            // 2. Store them in localStorage
            const encryptedPrivateKeys = await storePrivateKeys({
              encryption: encryptionKeyPair.privateKey,
              signing: signingKeyPair.privateKey,
              masterSeed: masterSeed
            }, password);
            localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
            localStorage.setItem('publicKey', await exportPublicKey(encryptionKeyPair.publicKey));
            localStorage.setItem('signingPublicKey', await exportPublicKey(signingKeyPair.publicKey));
            
            // 3. Upload the new pre-key bundle to the server
            await setupAndUploadPreKeyBundle(signingKeyPair.privateKey);

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
      <div className="w-full max-w-2xl bg-bg-surface rounded-lg shadow-lg p-8 border border-border">
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
          <button onClick={handleRegisterDevice} disabled={isProcessing} className="btn btn-secondary w-full justify-center gap-3">
            {isProcessing ? <Spinner size="sm" /> : <IoFingerPrint />}
            <span>{isProcessing ? 'Processing...' : 'Register This Device for Biometric Login'}</span>
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
