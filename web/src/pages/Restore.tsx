import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiKey, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { recoverAccountWithSignature } from '@lib/crypto-worker-proxy';
import { saveEncryptedKeys } from '@lib/keyStorage';
import { useAuthStore } from '@store/auth';
import { api } from '@lib/api';
import { useTranslation } from 'react-i18next';

export default function RestorePage() {
  const { t } = useTranslation(['auth', 'common']);
  const [identifier, setIdentifier] = useState('');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const navigate = useNavigate();

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier || !phrase.trim() || !password) {
      toast.error(t('auth:restore.error_fill'));
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
        encryptionPublicKeyB64,
        pqEncryptionPublicKeyB64,
        signingPublicKeyB64,
        encryptedPrivateKeys,
        signatureB64
      } = await recoverAccountWithSignature(trimmedPhrase, password, identifier, timestamp, nonce);

      if (!encryptedPrivateKeys || !signatureB64) {
        throw new Error(t('auth:restore.error_payload'));
      }

      // 3. Send Cryptographic Proof to Server
      const res = await api<{ accessToken: string }>('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify({
          identifier,
          newPassword: password,
          newEncryptedKeys: encryptedPrivateKeys,
          publicKey: encryptionPublicKeyB64,
          pqPublicKey: pqEncryptionPublicKeyB64,
          signingKey: signingPublicKeyB64,
          signature: signatureB64,
          timestamp,
          nonce
        })
      });
      // 4. Save to local storage & finalize login
      await saveEncryptedKeys(encryptedPrivateKeys);
      useAuthStore.getState().setHasRestoredKeys(true);
      
      if (res.accessToken) {
          useAuthStore.getState().setAccessToken(res.accessToken);
          try {
            await useAuthStore.getState().bootstrap(true); // Force fetch user profile
          } catch (err) {
            toast.error(t('auth:restore.error_generic'));
            return;
          }
      }

      toast.success(t('auth:restore.success'));
      navigate('/');

    } catch (error: unknown) {
      console.error("Restore failed:", error);
      if ((error instanceof Error ? error.message : t('common:errors.unknown'))?.includes('mnemonic')) {
        toast.error(t('auth:restore.error_mnemonic'));
      } else {
        toast.error((error instanceof Error ? error.message : t('common:errors.unknown')) || t('auth:restore.error_generic'));
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
          <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-text-primary">{t('auth:restore.title')}</h1>
          <p className="text-xs text-text-secondary mt-2 tracking-widest uppercase">
            {t('auth:restore.subtitle')}
          </p>
        </div>
        
        <form onSubmit={handleRestore} className="bg-bg-surface p-8 rounded-2xl shadow-neumorphic-convex border border-white/5 relative overflow-hidden">
          <div className="space-y-6">
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">{t('auth:restore.labels.identifier')}</span>
              </label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder={t('auth:restore.placeholders.identifier')}
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">{t('auth:restore.labels.phrase')}</span>
              </label>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="w-full h-24 p-4 rounded-xl resize-none bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder={t('auth:restore.placeholders.phrase')}
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">{t('auth:restore.labels.new_password')}</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder={t('auth:restore.placeholders.new_password')}
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
              {isRestoring ? t('auth:restore.buttons.verifying') : t('auth:restore.buttons.recover')}
            </button>
          </div>
        </form>
        <div className="mt-8 text-center">
          <Link to="/login" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest transition-colors">
            {t('auth:restore.buttons.abort')}
          </Link>
        </div>
      </div>
    </div>
  );
}
