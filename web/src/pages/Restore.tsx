import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiKey, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { recoverAccountWithSignature } from '@lib/crypto-worker-proxy';
import { saveEncryptedKeys } from '@lib/keyStorage';
import { useAuthStore } from '@store/auth';
import { api } from '@lib/api';

export default function RestorePage() {
  const [identifier, setIdentifier] = useState('');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const navigate = useNavigate();

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier || !phrase.trim() || !password) {
      toast.error("Please fill in all fields.");
      return;
    }
    setIsRestoring(true);
    try {
      const trimmedPhrase = phrase.trim().toLowerCase();
      const timestamp = Date.now();

      // 1. Fetch Server-side Nonce Challenge
      const challengeRes = await api<{ nonce: string }>(`/api/auth/recover/challenge?identifier=${encodeURIComponent(identifier)}`, { method: 'GET' });
      const nonce = challengeRes.nonce;

      // 2. Generate keys & Sign Payload locally
      const {
        encryptedPrivateKeys,
        signatureB64
      } = await recoverAccountWithSignature(trimmedPhrase, password, identifier, timestamp, nonce);

      if (!encryptedPrivateKeys || !signatureB64) {
        throw new Error("Failed to generate recovery payload.");
      }

      // 3. Send Cryptographic Proof to Server
      const res = await api<{ accessToken: string }>('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify({
          identifier,
          newPassword: password,
          newEncryptedKeys: encryptedPrivateKeys,
          signature: signatureB64,
          timestamp,
          nonce
        })
      });
      // 3. Save to local storage & finalize login
      await saveEncryptedKeys(encryptedPrivateKeys);
      useAuthStore.getState().setHasRestoredKeys(true);
      
      // Force fetch user profile to complete login state
      // (Assuming bootstrap or login logic usually handles this, but here we manually refresh)
      // Since we have the token now (via cookie or response), bootstrap should work or we can reload.
      // But let's follow the plan: force fetch profile? useAuthStore doesn't expose fetchProfile directly in the interface I recall.
      // Let's check auth store. It has `bootstrap` which fetches /me.
      // Or we can just navigate to / and let App.tsx bootstrap.
      // The plan says "Force fetch user profile". I'll use bootstrap() if available or just rely on navigation.
      // Actually, api/auth/recover returns accessToken. We should set it.
      if (res.accessToken) {
          useAuthStore.getState().setAccessToken(res.accessToken);
          await useAuthStore.getState().bootstrap(true); // Force fetch user profile
      }

      toast.success('Account successfully recovered! Welcome back.');
      navigate('/');

    } catch (error: any) {
      console.error("Restore failed:", error);
      if (error.message?.includes('mnemonic')) {
        toast.error("Invalid recovery phrase. Please check for typos.");
      } else {
        toast.error(error.message || "Recovery failed. Please verify your details.");
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
          <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-text-primary">Account Recovery</h1>
          <p className="text-xs text-text-secondary mt-2 tracking-widest uppercase">
            Zero-Knowledge Password Reset
          </p>
        </div>
        
        <form onSubmit={handleRestore} className="bg-bg-surface p-8 rounded-2xl shadow-neumorphic-convex border border-white/5 relative overflow-hidden">
          <div className="space-y-6">
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Email or Username</span>
              </label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="USER_ID..."
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Recovery Phrase</span>
              </label>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="w-full h-24 p-4 rounded-xl resize-none bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="ENTER_24_WORD_SEED_PHRASE..."
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">New Server Password</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="SET_NEW_PASSWORD..."
                required
              />
            </div>
          </div>
          <div className="mt-8">
            <button 
              type="submit" 
              className="w-full py-4 rounded-xl font-bold uppercase tracking-wider text-sm bg-accent text-white shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:brightness-110 flex items-center justify-center gap-3" 
              disabled={isRestoring}
            >
              {isRestoring ? <Spinner size="sm" className="text-white" /> : <FiUpload />}
              {isRestoring ? 'VERIFYING...' : 'RECOVER_ACCOUNT'}
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