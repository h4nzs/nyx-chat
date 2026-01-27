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
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-bg-main text-text-primary p-4 font-mono">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex p-4 rounded-full bg-bg-surface shadow-neumorphic-convex mb-4 text-accent">
             <FiKey size={40} />
          </div>
          <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-text-primary">System Recovery</h1>
          <p className="text-xs text-text-secondary mt-2 tracking-widest uppercase">
            Initialize Key Restoration Protocol
          </p>
        </div>
        
        <form onSubmit={handleRestore} className="bg-bg-surface p-8 rounded-2xl shadow-neumorphic-convex border border-white/5 relative overflow-hidden">
          {/* Decorative Screw Heads */}
          <div className="absolute top-3 left-3 w-2 h-2 rounded-full bg-text-secondary/20 shadow-inner"></div>
          <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-text-secondary/20 shadow-inner"></div>
          <div className="absolute bottom-3 left-3 w-2 h-2 rounded-full bg-text-secondary/20 shadow-inner"></div>
          <div className="absolute bottom-3 right-3 w-2 h-2 rounded-full bg-text-secondary/20 shadow-inner"></div>

          <div className="space-y-6">
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Recovery Phrase Mnemonic</span>
              </label>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="
                  w-full h-32 p-4 rounded-xl resize-none
                  bg-bg-main text-text-primary font-mono text-sm
                  shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50
                  placeholder:text-text-secondary/30
                "
                placeholder="ENTER_12_WORD_SEED_PHRASE..."
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">New Secure Password</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="
                  w-full p-4 rounded-xl
                  bg-bg-main text-text-primary font-mono text-sm
                  shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50
                  placeholder:text-text-secondary/30
                "
                placeholder="SET_NEW_ENCRYPTION_KEY..."
                required
              />
            </div>
          </div>
          <div className="mt-8">
            <button 
              type="submit" 
              className="
                w-full py-4 rounded-xl font-bold uppercase tracking-wider text-sm
                bg-accent text-white
                shadow-neumorphic-convex active:shadow-neumorphic-pressed
                hover:brightness-110 transition-all flex items-center justify-center gap-3
              " 
              disabled={isRestoring}
            >
              {isRestoring ? <Spinner size="sm" className="text-white" /> : <FiUpload />}
              {isRestoring ? 'RESTORING_KEYS...' : 'EXECUTE_RESTORE'}
            </button>
          </div>
        </form>
        <div className="mt-8 text-center">
          <Link to="/login" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest transition-colors">
            [ ABORT_SEQUENCE ]
          </Link>
        </div>
      </div>
    </div>
  );
}