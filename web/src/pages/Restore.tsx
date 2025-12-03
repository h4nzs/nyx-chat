import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiKey, FiUpload } from 'react-icons/fi';
import { useAuthStore } from '@store/auth';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import * as bip39 from 'bip39';
import { getSodium } from '@lib/sodiumInitializer';
import { storePrivateKeys, exportPublicKey } from "@utils/keyManagement";
import { syncSessionKeys } from '@utils/sessionSync';

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
      const trimmedPhrase = phrase.trim();
      if (!bip39.validateMnemonic(trimmedPhrase)) {
        throw new Error("Invalid recovery phrase. Please check for typos.");
      }
      
      const sodium = await getSodium();

      // 1. Convert the mnemonic back to the original 32-byte entropy (master seed).
      const masterSeedHex = bip39.mnemonicToEntropy(trimmedPhrase);
      const masterSeed = sodium.from_hex(masterSeedHex);

      if (masterSeed.length !== 32) {
        throw new Error("Failed to derive a valid 32-byte seed from the phrase.");
      }

      // 2. Deterministically re-derive the specific seeds for encryption and signing
      const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
      const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));

      // 3. Re-generate the exact same key pairs from the derived seeds
      const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
      const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);

      // 4. Encrypt and store the retrieved private keys (including the master seed) with the NEW password
      const encryptedPrivateKeys = await storePrivateKeys(
        { 
          encryption: encryptionKeyPair.privateKey, 
          signing: signingKeyPair.privateKey,
          masterSeed: masterSeed 
        },
        password
      );

      // 5. Store the new encrypted bundle and public keys in localStorage
      localStorage.setItem('encryptedPrivateKeys', encryptedPrivateKeys);
      localStorage.setItem('publicKey', await exportPublicKey(encryptionKeyPair.publicKey));
      localStorage.setItem('signingPublicKey', await exportPublicKey(signingKeyPair.publicKey));
      
      toast.success('Account restored! Please log in to sync your new keys with the server.');
      navigate('/login', { state: { from: 'restore' } });

    } catch (error: any) {
      console.error("Restore failed:", error);
      toast.error(error.message || "Restore failed. Please check your phrase and try again.");
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
            Enter your 24-word recovery phrase and set a new password for this device.
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
                placeholder="Enter your 24-word recovery phrase, separated by spaces..."
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