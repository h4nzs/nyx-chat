import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { useAuthStore } from "../store/auth";
import { useShallow } from 'zustand/react/shallow';
import AuthForm from "../components/AuthForm";
import RecoveryPhraseModal from "@components/RecoveryPhraseModal";
import { Turnstile } from '@marsidev/react-turnstile';
import toast from "react-hot-toast";
import { api } from "@lib/api";
import { FiShield, FiSkipForward, FiCpu, FiZap } from "react-icons/fi";
import { IoFingerPrint } from "react-icons/io5";
import SEO from '../components/SEO';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { Spinner } from "@components/Spinner";
import { getFullDeviceIdentity } from "../utils/fingerprint";

// 🚨 PERHATIAN: 
// Import '@lib/crypto-worker-proxy', '@lib/keychainDb', dan '@simplewebauthn/browser' 
// SENGAJA DIHAPUS DARI SINI UNTUK MENCEGAH RENDER-BLOCKING 5 DETIK!

export default function Register() {
  const { t } = useTranslation(['auth', 'common']);
  const [error, setError] = useState("");
  const [step, setStep] = useState<'form' | 'biometric' | 'recovery'>('form');
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [isBiometricsSupported, setIsBiometricsSupported] = useState(false);
  const [isVerifyingBio, setIsVerifyingBio] = useState(false);
  const [miningStatus, setMiningStatus] = useState<'idle' | 'mining' | 'verifying'>('idle');

  const navigate = useNavigate();
  const { registerAndGeneratePhrase, user } = useAuthStore(useShallow(s => ({ 
    registerAndGeneratePhrase: s.registerAndGeneratePhrase, 
    user: s.user 
  })));

  // ✅ DYNAMIC IMPORT: Cek dukungan biometrik secara asinkron di latar belakang
  useEffect(() => {
    import('@simplewebauthn/browser')
      .then(({ platformAuthenticatorIsAvailable }) => {
        platformAuthenticatorIsAvailable().then(setIsBiometricsSupported);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (user && sessionStorage.getItem('nyx_registration_in_progress') !== 'true') {
      navigate('/chat', { replace: true });
    }
    if (!user) {
      sessionStorage.removeItem('nyx_registration_in_progress');
    }
  }, [user, navigate]);

  // ✅ FIX: Use testing sitekey on localhost to prevent origin mismatch errors
  const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || 
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? '1x00000000000000000000AA' 
      : '');

  async function handleProofOfWork() {
    setMiningStatus('mining');
    const toastId = toast.loading(t('auth:messages.mining_connecting', 'Establishing trust sequence...'));
    
    try {
      // 0. Get Identity
      const { fingerprint, installationId } = await getFullDeviceIdentity();

      // 1. Get Challenge with Fingerprint Headers
      const { salt, difficulty } = await api<{ salt: string, difficulty: number }>('/api/auth/pow/challenge', {
        headers: {
            'X-Nyx-Fingerprint': fingerprint,
            'X-Nyx-Installation-Id': installationId
        }
      });
      
      toast.loading(t('auth:messages.mining_processing', 'Mining proof of trust...'), { id: toastId });
      
      const { minePoW } = await import("@lib/crypto-worker-proxy");
      const { nonce } = await minePoW(salt, difficulty);
      
      setMiningStatus('verifying');
      toast.loading(t('auth:messages.mining_verifying', 'Verifying proof...'), { id: toastId });
      
      const result = await api<{ success: boolean }>('/api/auth/pow/verify', {
        method: 'POST',
        body: JSON.stringify({ nonce })
      });
      
      if (result.success) {
        toast.success(t('auth:messages.mining_success', 'Trust verified!'), { id: toastId });
        setStep('recovery');
      } else {
        throw new Error(t('auth:errors.verification_failed', 'Verification failed'));
      }
    } catch (error: unknown) {
      console.error(error);
      const errorMsg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('auth:messages.mining_failed', { error: errorMsg, defaultValue: 'Verification failed' }), { id: toastId });
    } finally {
      setMiningStatus('idle');
    }
  }

  async function handleRegister(data: { name?: string, d?: string, b?: string }) {
    if (!TURNSTILE_SITE_KEY) {
      toast.error(t('errors:turnstile_missing'));
      return;
    }

    if (!turnstileToken) {
      toast.error(t('auth:errors.wait_turnstile', 'Please wait for the security check to complete.'));
      return;
    }
    const { name, d: username, b: password } = data;
    setError("");

    // --- Validation Logic ---
    if (!name) { throw new Error(t('auth:validation.name_required')); }
    if (name.length > 80) { throw new Error(t('auth:validation.name_length')); }
    if (!username || username.length < 3) { throw new Error(t('auth:validation.username_required')); }
    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username)) { throw new Error(t('auth:validation.username_format')); }
    if (!password) { throw new Error(t('auth:validation.password_required')); }
    if (password.length < 8) { throw new Error(t('auth:validation.password_length')); }
    // --- End Validation ---

    try {
      sessionStorage.setItem('nyx_registration_in_progress', 'true');
      
      // ✅ DYNAMIC IMPORT: Unduh mesin Kripto (libsodium) HANYA SAAT tombol daftar diklik!
      const { hashUsername, generateProfileKey, encryptProfile } = await import("@lib/crypto-worker-proxy");
      const { saveProfileKey } = await import("@lib/keychainDb");

      const usernameHash = await hashUsername(username);
      const profileKeyB64 = await generateProfileKey();
      const profileJson = JSON.stringify({ name, description: "", avatarUrl: "" });
      const encryptedProfile = await encryptProfile(profileJson, profileKeyB64);

      const result = await registerAndGeneratePhrase({ 
        usernameHash, 
        password, 
        encryptedProfile, 
        turnstileToken 
      });

      await saveProfileKey(result.userId, profileKeyB64);
      setRecoveryPhrase(result.phrase);

      // Mark that user just registered to prevent SystemInitModal from showing
      sessionStorage.setItem('nyx_just_registered', 'true');

      // Move to Biometric step instead of Recovery directly
      setStep('biometric');
      toast.success(t('auth:status.identity_initialized'));
      
    } catch (err: unknown) {
      sessionStorage.removeItem('nyx_registration_in_progress');
      setError((err instanceof Error ? err.message : t('common:errors.unknown', 'Unknown error')) || t('auth:errors.registration_failed', 'Registration failed'));
    }
  }

  const handleBiometricRegister = async () => {
    setIsVerifyingBio(true);
    try {
      // ✅ DYNAMIC IMPORT: Unduh logika WebAuthn HANYA SAAT user setuju memakai sidik jari!
      const { startRegistration } = await import('@simplewebauthn/browser');

      // 1. Get Options
      const options = await api<unknown>("/api/auth/webauthn/register/options");
      
      // 2. Browser Prompt
      const attResp = await startRegistration(options as Parameters<typeof startRegistration>[0]);
      
      // 3. Verify on Server
      const verificationResp = await api<{ verified: boolean }>("/api/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify(attResp),
      });

      if (verificationResp.verified) {
        toast.success(t('auth:status.biometric_verified'));
        setStep('recovery');
      } else {
        throw new Error(t('auth:errors.verification_failed', 'Verification failed'));
      }
    } catch (error: unknown) {
      if ((error as Error).name === 'NotAllowedError') {
        toast.error(t('auth:messages.biometric_cancelled'));
      } else {
        toast.error(`${t('common:errors.error_prefix', 'Error:')} ${(error instanceof Error ? error.message : t('common:errors.unknown', 'Unknown error'))}`);
      }
    } finally {
      setIsVerifyingBio(false);
    }
  };

  const handleSkipBiometric = () => {
    toast(t('auth:messages.verify_later'));
    // Clear the just-registered flag so SystemInitModal can show on next login
    sessionStorage.removeItem('nyx_just_registered');
    setStep('recovery');
  };

  useEffect(() => {
    let timerId: NodeJS.Timeout;
    if (step === 'recovery' && !recoveryPhrase) {
      toast.success(t('auth:messages.welcome'));
      timerId = setTimeout(() => navigate('/chat'), 100);
    }
    return () => { if (timerId) clearTimeout(timerId); };
  }, [step, recoveryPhrase, navigate, t]);

  // STEP 3: RECOVERY PHRASE
  if (step === 'recovery') {
    if (!recoveryPhrase) return null;
    return <RecoveryPhraseModal phrase={recoveryPhrase} onClose={() => {
      // Clear the just-registered flag when user completes registration flow
      sessionStorage.removeItem('nyx_just_registered');
      sessionStorage.removeItem('nyx_registration_in_progress');
      navigate('/chat');
    }} />
  }

  // STEP 2: TRUST VERIFICATION
  if (step === 'biometric') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-bg-main p-4 relative">
        <LanguageSwitcher />
        <div className="max-w-md w-full bg-bg-surface rounded-2xl p-8 shadow-neu-flat dark:shadow-neu-flat-dark text-center">
          <div className="w-16 h-16 bg-accent/10 rounded-full flex items-center justify-center mx-auto mb-6 text-accent shadow-neu-pressed dark:shadow-neu-pressed-dark">
            <FiShield size={32} />
          </div>
          
          <h2 className="text-2xl font-black text-text-primary mb-2 tracking-tight">{t('auth:titles.trust_verification')}</h2>
          <p className="text-text-secondary text-sm mb-8">
            {t('auth:subtitles.verify_desc')}
          </p>

          <div className="space-y-4">
            {/* Option 1: Biometric (Conditional) */}
            {isBiometricsSupported && (
              <button
                onClick={handleBiometricRegister}
                disabled={isVerifyingBio || miningStatus !== 'idle'}
                className="w-full p-4 rounded-xl bg-bg-main border border-white/5 shadow-neu-flat hover:border-accent/50 transition-all text-left flex items-start gap-4 group disabled:opacity-50"
              >
                <div className="p-3 bg-accent/10 text-accent rounded-full group-hover:bg-accent group-hover:text-white transition-colors">
                  {isVerifyingBio ? <Spinner size="sm" /> : <FiZap size={24} />}
                </div>
                <div>
                  <h3 className="font-bold text-text-primary text-sm">{t('auth:buttons.biometric_verify', 'Instant Biometric')}</h3>
                  <p className="text-[10px] text-text-secondary mt-1">{t('auth:subtitles.biometric_short', 'Verify using your device fingerprint or face.')}</p>
                </div>
              </button>
            )}

            {/* Option 2: Proof of Work */}
            <button
              onClick={handleProofOfWork}
              disabled={miningStatus !== 'idle' || isVerifyingBio}
              className="w-full p-4 rounded-xl bg-bg-main border border-white/5 shadow-neu-flat hover:border-accent/50 transition-all text-left flex items-start gap-4 group disabled:opacity-50"
            >
              <div className="p-3 bg-blue-500/10 text-blue-500 rounded-full group-hover:bg-blue-500 group-hover:text-white transition-colors">
                {miningStatus === 'idle' ? <FiCpu size={24} /> : <Spinner size="sm" />}
              </div>
              <div>
                <h3 className="font-bold text-text-primary text-sm">{t('auth:buttons.pow_verify', 'Proof of Trust')}</h3>
                <p className="text-[10px] text-text-secondary mt-1">
                  {miningStatus === 'idle' ? t('auth:subtitles.pow_desc', 'Verify by solving a cryptographic challenge.') :
                   miningStatus === 'mining' ? t('auth:status.mining', 'Mining...') : t('auth:status.verifying', 'Verifying...')}
                </p>
              </div>
            </button>
            
            {/* Skip Button */}
            <button
              onClick={handleSkipBiometric}
              disabled={miningStatus !== 'idle' || isVerifyingBio}
              className="w-full py-4 rounded-xl bg-bg-main text-text-secondary hover:text-accent font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-neu-flat dark:shadow-neu-flat-dark active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark disabled:opacity-50 mt-4"
            >
              <FiSkipForward /> {t('auth:buttons.skip_now')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // STEP 1: REGISTER FORM
  return (
    <div className="min-h-dvh flex flex-col md:flex-row bg-bg-main relative">
      <LanguageSwitcher />
      <SEO title="Register" description="Create a new anonymous, end-to-end encrypted account on NYX. No tracking, no ads." canonicalUrl="/register" />
      {/* Left Panel - Concrete Security Panel */}
      <div className="w-full md:w-2/5 bg-bg-surface p-8 flex flex-col justify-center shadow-2xl z-10">
        <div className="max-w-md w-full mx-auto">
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-accent flex items-center justify-center mr-3 shadow-neu-flat dark:shadow-neu-flat-dark">
              <div className="w-8 h-8 rounded bg-bg-main opacity-50"></div>
            </div>
            <h1 className="text-3xl font-black text-text-primary tracking-tighter">{t('auth:titles.secure_vault')}</h1>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-accent mb-2">{t('auth:titles.anonymous_reg')}</h2>
            <p className="text-text-secondary">{t('auth:subtitles.register_desc')}</p>
          </div>

          {error && <div className="text-red-500 text-center mb-4 text-sm">{error}</div>}

          {/* Modified AuthForm for Username Only */}
          <AuthForm
            onSubmit={handleRegister}
            button={!TURNSTILE_SITE_KEY ? 'Configuration Error' : (!turnstileToken ? t('auth:status.verifying_security', 'Checking Security...') : t('auth:buttons.register'))}
            hideEmail={true} 
            isRegister={true}
            disabled={!TURNSTILE_SITE_KEY || !turnstileToken}
          />

          {/* Turnstile Widget */}
          <div className="mt-4 flex justify-center">
            {TURNSTILE_SITE_KEY ? (
              <Turnstile
                siteKey={TURNSTILE_SITE_KEY}
                onSuccess={setTurnstileToken}
                onError={() => toast.error(t('auth:errors.security_check_failed', 'Security check failed.'))}
                onExpire={() => setTurnstileToken('')}
                options={{ theme: 'auto' }}
              />
            ) : (
              <div className="text-red-500 text-sm p-4 border border-red-500 rounded bg-red-500/10">
                {t('errors:turnstile_missing', 'System configuration error: Turnstile site key is missing.')}
              </div>
            )}
          </div>

          <div className="text-center mt-6">
            <p className="text-stone-500 text-sm">
              {t('auth:links.has_account')} <Link to="/login" className="font-semibold text-teal-500 hover:underline">{t('auth:buttons.login')}</Link>
            </p>
          </div>
        </div>
      </div>

      {/* Right Panel - Dynamic Visualization */}
      <div className="w-full md:w-3/5 bg-gradient-to-br from-stone-900 to-black relative overflow-hidden flex items-center justify-center p-8">
         {/* ... Visualization code ... */}
         <div className="relative z-10 text-center max-w-lg">
            <h2 className="text-3xl font-black text-white mb-4 tracking-tighter">{t('auth:marketing.pure_anonymity')}</h2>
            <p className="text-stone-400 mb-6">{t('auth:marketing.anonymity_desc')}</p>
         </div>
      </div>
    </div>
  );
}
