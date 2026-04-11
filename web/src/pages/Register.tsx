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
import { FiShield, FiSkipForward } from "react-icons/fi";
import { IoFingerPrint } from "react-icons/io5";
import SEO from '../components/SEO';
import LanguageSwitcher from '../components/LanguageSwitcher';

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

  async function handleRegister(data: { name?: string, d?: string, b?: string }) {
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

  // STEP 2: BIOMETRIC VERIFICATION
  if (step === 'biometric') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-900 p-4 relative">
        <LanguageSwitcher />
        <div className="max-w-md w-full bg-stone-800 rounded-2xl p-8 shadow-2xl border border-stone-700 text-center">
          <div className="w-16 h-16 bg-teal-500/10 rounded-full flex items-center justify-center mx-auto mb-6 text-teal-500">
            <IoFingerPrint size={32} />
          </div>
          
          <h2 className="text-2xl font-black text-white mb-2 tracking-tight">{t('auth:titles.trust_verification')}</h2>
          <p className="text-stone-400 text-sm mb-8">
            {t('auth:subtitles.verify_desc')}
          </p>

          {isBiometricsSupported ? (
            <div className="space-y-4">
              <button
                onClick={handleBiometricRegister}
                disabled={isVerifyingBio}
                className="w-full py-4 rounded-xl bg-teal-500 hover:bg-teal-400 text-stone-900 font-bold uppercase tracking-wider shadow-lg shadow-teal-500/20 transition-all flex items-center justify-center gap-2"
              >
                {isVerifyingBio ? <span className="animate-pulse">{t('common:actions.loading')}</span> : (
                  <>
                    <FiShield /> {t('auth:buttons.verify_identity')}
                  </>
                )}
              </button>
              
              <button
                onClick={handleSkipBiometric}
                className="w-full py-4 rounded-xl bg-transparent border border-stone-600 text-stone-400 hover:text-white hover:border-stone-500 font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2"
              >
                <FiSkipForward /> {t('auth:buttons.skip_now')}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-500 text-xs">
                {t('auth:messages.device_not_supported')}
              </div>
              <button
                onClick={handleSkipBiometric}
                className="w-full py-4 rounded-xl bg-stone-700 hover:bg-stone-600 text-white font-bold uppercase tracking-wider transition-all"
              >
                {t('auth:buttons.continue_app')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // STEP 1: REGISTER FORM
  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-stone-900 relative">
      <LanguageSwitcher />
      <SEO title="Register" description="Create a new anonymous, end-to-end encrypted account on NYX. No tracking, no ads." canonicalUrl="/register" />
      {/* Left Panel - Concrete Security Panel */}
      <div className="w-full md:w-2/5 bg-gradient-to-br from-stone-800 to-stone-900 p-8 flex flex-col justify-center"
           style={{
             boxShadow: 'inset -10px -10px 30px rgba(0, 0, 0, 0.5)'
           }}>
        <div className="max-w-md w-full mx-auto">
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-teal-500 flex items-center justify-center mr-3">
              <div className="w-8 h-8 rounded bg-teal-300"></div>
            </div>
            <h1 className="text-3xl font-black text-white tracking-tighter">{t('auth:titles.secure_vault')}</h1>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-teal-400 mb-2">{t('auth:titles.anonymous_reg')}</h2>
            <p className="text-stone-400">{t('auth:subtitles.register_desc')}</p>
          </div>

          {error && <div className="text-red-500 text-center mb-4 text-sm">{error}</div>}

          {/* Modified AuthForm for Username Only */}
          <AuthForm
            onSubmit={handleRegister}
            button={!import.meta.env.VITE_TURNSTILE_SITE_KEY ? 'Configuration Error' : (!turnstileToken ? t('auth:status.verifying_security', 'Checking Security...') : t('auth:buttons.register'))}
            hideEmail={true} 
            isRegister={true}
            disabled={!import.meta.env.VITE_TURNSTILE_SITE_KEY || !turnstileToken}
          />

          {/* Turnstile Widget */}
          <div className="mt-4 flex justify-center">
            {import.meta.env.VITE_TURNSTILE_SITE_KEY ? (
              <Turnstile
                siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
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
