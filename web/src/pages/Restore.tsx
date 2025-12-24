import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiKey, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { restoreFromPhrase } from '@lib/crypto-worker-proxy';
import { useAuthStore } from '@store/auth';

export default function RestorePage() {
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const navigate = useNavigate();


  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phrase.trim() || !password) {
      toast.error("Please enter both your recovery phrase and a new password.");
      return;
    }
    setIsRestoring(true);
    try {
      const trimmedPhrase = phrase.trim().toLowerCase();
      
      // All heavy crypto work is now in the worker
      const {
        encryptedPrivateKeys,
        encryptionPublicKeyB64,
        signingPublicKeyB64,
      } = await restoreFromPhrase(trimmedPhrase, password);

      if (!encryptedPrivateKeys) {
        throw new Error("Failed to restore keys. The phrase may be invalid.");
      }

      // Store the new encrypted bundle and public keys in localStorage
      localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
      localStorage.setItem('publicKey', encryptionPublicKeyB64);
      localStorage.setItem('signingPublicKey', signingPublicKeyB64);
      
      // Manually update the auth store state
      useAuthStore.getState().setHasRestoredKeys(true);

      toast.success('Account restored! Please log in to sync your new keys with the server.');
      navigate('/login', { state: { restoredNotSynced: true } });

    } catch (error: any) {
      console.error("Restore failed:", error);
      // Bip39 in the worker will throw an error for invalid mnemonics
      if (error.message.includes('mnemonic')) {
        toast.error("Invalid recovery phrase. Please check for typos and ensure all words are correct.");
      } else {
        toast.error(error.message || "Restore failed. Please check your phrase and try again.");
      }
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-main text-text-primary p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <FiKey className="mx-auto text-accent text-5xl mb-4" />
          <h1 className="text-3xl font-bold">Restore Account</h1>
          <p className="text-text-secondary mt-2">
            Enter your 12 or 24-word recovery phrase and set a new password for this device.
          </p>
        </div>
        <form onSubmit={handleRestore} className="bg-bg-surface rounded-lg shadow-lg p-8 border border-border">
          <div className="space-y-6">
            <div className="form-control">
              <label className="label">
                <span className="label-text text-text-secondary">Recovery Phrase</span>
              </label>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="textarea textarea-bordered w-full h-28"
                placeholder="Enter your recovery phrase, separated by spaces..."
                required
              />
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text text-text-secondary">New Password</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input input-bordered w-full"
                placeholder="Choose a strong password for this device"
                required
              />
            </div>
          </div>
          <div className="mt-8">
            <button type="submit" className="btn btn-primary w-full" disabled={isRestoring}>
              {isRestoring ? <Spinner /> : <FiUpload className="mr-2" />}
              {isRestoring ? 'Restoring...' : 'Restore & Set Password'}
            </button>
          </div>
        </form>
        <div className="mt-6 text-center">
          <Link to="/login" className="text-accent-color hover:underline">
            &larr; Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
}