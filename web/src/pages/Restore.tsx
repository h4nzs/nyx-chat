import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { FiKey, FiUpload, FiShield } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { recoverAccountWithSignature, restoreFromPhrase } from '@lib/crypto-worker-proxy';
import { saveEncryptedKeys } from '@lib/keyStorage';
import { useAuthStore } from '@store/auth';
import { api } from '@lib/api';
import { useTranslation } from 'react-i18next';

export default function RestorePage() {
  const { t } = useTranslation(['auth', 'common']);
  const location = useLocation();
  const { user, accessToken, login, bootstrap, setHasRestoredKeys, setAccessToken } = useAuthStore();
  
  // Detect if we are in Verification mode (logged in but need keys for new device)
  const isVerifyMode = !!accessToken && location.state?.mode === 'verify';

  const [identifier, setIdentifier] = useState(user?.usernameHash || '');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const navigate = useNavigate();

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validation
    if ((!isVerifyMode && !identifier) || !phrase.trim() || !password) {
      toast.error(t('auth:restore.error_fill'));
      return;
    }

    setIsRestoring(true);
    try {
      const trimmedPhrase = phrase.trim().toLowerCase();
      
      if (isVerifyMode) {
          // --- MODE B: IDENTITY VERIFICATION (LOGGED IN / MIGRATION) ---
          // 1. Locally generate new encrypted keys from phrase using CURRENT password
          const { encryptedPrivateKeys } = await restoreFromPhrase(trimmedPhrase, password);
          
          if (!encryptedPrivateKeys) {
            throw new Error(t('auth:restore.error_payload'));
          }

          // 2. Save keys to local storage (IndexedDB)
          await saveEncryptedKeys(encryptedPrivateKeys);
          
          // 3. Register these keys with the server to finalize bootstrapping.
          // We use the existing 'login' method with restoredNotSynced: true.
          // This performs a POST /api/auth/login with the new public keys, 
          // which registers this device and revokes all other sessions (Single-Active-Device).
          const currentUsernameHash = user?.usernameHash || identifier;
          if (!currentUsernameHash) throw new Error("Username hash missing.");
          
          await login(currentUsernameHash, password, true);
          
          toast.success(t('auth:restore.verify.success', 'Identity verified! Device unique keys generated.'));
          navigate('/chat');
      } else {
          // --- MODE A: ACCOUNT RECOVERY (FORGOT PASSWORD / NOT LOGGED IN) ---
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

          if (!encryptedPrivateKeys || !signatureB64 || !encryptionPublicKeyB64 || !pqEncryptionPublicKeyB64 || !signingPublicKeyB64) {
            throw new Error(t('auth:restore.error_payload'));
          }

          // 3. Send Cryptographic Proof to Server
          const { getFullDeviceIdentity } = await import('@utils/fingerprint');
          const { fingerprint, installationId } = await getFullDeviceIdentity();
          
          const res = await api<{ accessToken: string }>('/api/auth/recover', {
            method: 'POST',
            headers: {
              'X-Nyx-Fingerprint': fingerprint,
              'X-Nyx-Installation-Id': installationId
            },
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
          setHasRestoredKeys(true);
          
          if (res.accessToken) {
              setAccessToken(res.accessToken);
              try {
                await bootstrap(true); // Force fetch user profile
              } catch (err) {
                toast.error(t('auth:restore.error_generic'));
                return;
              }
          }

          toast.success(t('auth:restore.success'));
          navigate('/');
      }

    } catch (error: unknown) {
      console.error("Restore/Verify failed:", error);
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      
      if (msg?.includes('mnemonic') || msg?.includes('seed')) {
        toast.error(t('auth:restore.error_mnemonic'));
      } else if (msg?.includes('password')) {
        toast.error(t('auth:messages.decrypt_failed'));
      } else {
        toast.error(msg || (isVerifyMode ? t('auth:restore.verify.error_generic') : t('auth:restore.error_generic')));
      }
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="min-h-dvh w-full flex flex-col items-center justify-center bg-bg-main text-text-primary p-4 font-mono">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex p-4 rounded-full bg-bg-surface shadow-neumorphic-convex mb-4 text-accent">
             {isVerifyMode ? <FiShield size={40} /> : <FiKey size={40} />}
          </div>
          <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-text-primary">
            {isVerifyMode ? t('auth:restore.verify.title') : t('auth:restore.title')}
          </h1>
          <p className="text-xs text-text-secondary mt-2 tracking-widest uppercase px-4">
            {isVerifyMode 
              ? t('auth:restore.verify.subtitle') 
              : t('auth:restore.subtitle')}
          </p>
        </div>
        
        <form onSubmit={handleRestore} className="bg-bg-surface p-8 rounded-2xl shadow-neumorphic-convex border border-white/5 relative overflow-hidden">
          {/* Visual Indicator for Mode */}
          <div className={`absolute top-0 left-0 w-full h-1 ${isVerifyMode ? 'bg-accent' : 'bg-orange-500'} opacity-50`}></div>

          <div className="space-y-6">
            {!isVerifyMode && (
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
            )}

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
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">
                  {isVerifyMode ? t('auth:restore.verify.labels.password') : t('auth:restore.labels.new_password')}
                </span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder={isVerifyMode ? t('auth:fields.password') : t('auth:restore.placeholders.new_password')}
                required
              />
              {isVerifyMode && (
                <p className="text-[9px] text-text-secondary mt-2 leading-relaxed opacity-70 italic">
                  * {t('auth:subtitles.login_desc')}
                </p>
              )}
            </div>
          </div>

          <div className="mt-8">
            <button 
              type="submit" 
              className="w-full py-4 rounded-xl font-bold uppercase tracking-wider text-sm bg-accent text-white shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:brightness-110 flex items-center justify-center gap-3" 
              disabled={isRestoring}
            >
              {isRestoring ? <Spinner size="sm" className="text-white" /> : (isVerifyMode ? <FiShield /> : <FiUpload />)}
              {isRestoring ? t('auth:restore.buttons.verifying') : (isVerifyMode ? t('auth:restore.verify.buttons.verify') : t('auth:restore.buttons.recover'))}
            </button>
          </div>
        </form>

        <div className="mt-8 text-center">
          <Link 
            to={isVerifyMode ? "/settings" : "/login"} 
            className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest transition-colors"
          >
            {t('auth:restore.buttons.abort')}
          </Link>
        </div>
      </div>
    </div>
  );
}
