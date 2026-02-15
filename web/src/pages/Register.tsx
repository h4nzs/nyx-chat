import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import AuthForm from "../components/AuthForm";
import RecoveryPhraseModal from "@components/RecoveryPhraseModal";
import { Turnstile } from '@marsidev/react-turnstile';
import { FiMail, FiRefreshCw } from 'react-icons/fi';
import toast from "react-hot-toast";

export default function Register() {
  const [error, setError] = useState("");
  const [step, setStep] = useState<'form' | 'otp' | 'recovery'>('form');
  const [recoveryPhrase, setRecoveryPhrase] = useState('');

  // State untuk Verifikasi
  const [userId, setUserId] = useState('');
  const [emailForVerify, setEmailForVerify] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [isResending, setIsResending] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const location = useLocation();
  const navigate = useNavigate();
  const { registerAndGeneratePhrase, verifyEmail, resendVerification } = useAuthStore();

  // Check if we should show verification form based on location state or stored verification state
  useEffect(() => {
    const locationState = location.state;
    if (locationState?.showVerification && locationState?.userId && locationState?.email) {
      // User was redirected from login because they have pending verification
      setUserId(locationState.userId);
      setEmailForVerify(locationState.email);
      setStep('otp');
      // Clear the location state to prevent showing it again on refresh using router navigation
      navigate('.', { replace: true, state: {} });
    } else {
      // Check if there's stored verification state
      import('@utils/verificationPersistence').then(({ getVerificationState }) => {
        const storedState = getVerificationState();
        if (storedState) {
          setUserId(storedState.userId);
          setEmailForVerify(storedState.email);
          if (storedState.phrase) setRecoveryPhrase(storedState.phrase);
          setStep('otp');
        }
      });
    }
  }, [location.state, navigate]);

  async function handleRegister(data: { name?: string, d?: string, c?: string, b?: string }) {
    const { name, d: username, c: email, b: password } = data;
    setError("");

    // --- Validation Logic ---
    if (!name) { throw new Error("Name is required"); }
    if (name.length > 80) { throw new Error("Name must be less than 80 characters"); }
    if (!username) { throw new Error("Username is required"); }
    if (username.length < 3) { throw new Error("Username must be at least 3 characters"); }
    if (username.length > 32) { throw new Error("Username must be less than 32 characters"); }
    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username)) { throw new Error("Username can only contain letters, numbers, and underscores"); }
    if (!email) { throw new Error("Email is required"); }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) { throw new Error("Please enter a valid email address"); }
    if (email.length > 200) { throw new Error("Email must be less than 200 characters"); }
    if (!password) { throw new Error("Password is required"); }
    if (password.length < 8) { throw new Error("Password must be at least 8 characters"); }
    if (password.length > 128) { throw new Error("Password must be less than 128 characters"); }
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[@$!%*?&]/.test(password);
    if (!hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) { throw new Error("Password must contain at least one uppercase, lowercase, number, and special character"); }
    // --- End Validation ---

    // Validasi Turnstile
    // Note: Jika di local dev tanpa key, backend mungkin bypass, tapi di prod wajib.
    // if (!turnstileToken) { throw new Error("Please complete the CAPTCHA."); }

    try {
      const result = await registerAndGeneratePhrase({ 
        name, username, email, password, turnstileToken 
      });

      setRecoveryPhrase(result.phrase);
      
      if (result.needVerification && result.userId) {
        setUserId(result.userId);
        setEmailForVerify(result.email || email);
        // Save verification state to localStorage so it persists if user closes the tab
        import('@utils/verificationPersistence').then(({ saveVerificationState }) => {
          saveVerificationState({
            userId: result.userId!,
            email: result.email || email,
            timestamp: Date.now(),
            phrase: result.phrase // Save the phrase!
          });
        });
        setStep('otp');
        toast.success("Registration successful! Please check your email for the code.");
      } else {
        // Jika verifikasi dimatikan backend, langsung ke recovery
        setStep('recovery');
      }
    } catch (err: any) {
      setError(err.message || "Registration failed");
    }
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otpCode.length !== 6) {
      setError("Code must be 6 digits.");
      return;
    }
    setError("");
    setIsVerifying(true);

    try {
      await verifyEmail(userId, otpCode);
      toast.success("Email verified!");
      // Don't clear verification state yet, we need the phrase for the next step!
      setStep('recovery'); // Pindah ke Recovery Phrase setelah sukses
    } catch (err: any) {
      // Tampilkan pesan kesalahan yang lebih spesifik
      if (err.message.includes("expired")) {
        setError("Verification code has expired. Please request a new one.");
      } else if (err.message.includes("Invalid")) {
        setError("Invalid verification code. Please try again.");
      } else {
        setError(err.message || "Verification failed");
      }
    } finally {
      setIsVerifying(false);
    }
  };

  // Countdown effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (countdown > 0) {
      interval = setInterval(() => {
        setCountdown((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [countdown]);

  const handleResend = async () => {
    if (countdown > 0) return; // Jangan lakukan apa-apa jika masih dalam countdown

    setIsResending(true);
    try {
      await resendVerification(emailForVerify);
      toast.success("Verification code resent!");
      setCountdown(60); // Countdown 60 detik sebelum bisa mengirim ulang
    } catch (err: any) {
      toast.error(err.message || "Failed to resend");
    } finally {
      setIsResending(false);
    }
  };

  // STEP 3: RECOVERY PHRASE
  if (step === 'recovery') {
    return <RecoveryPhraseModal phrase={recoveryPhrase} onClose={() => {
      // Clear state only when finished
      import('@utils/verificationPersistence').then(({ clearVerificationState }) => {
        clearVerificationState();
      });
      navigate('/chat');
    }} />
  }

  // STEP 2: OTP FORM
  if (step === 'otp') {
    return (
      <div className="min-h-screen flex flex-col md:flex-row bg-stone-900">
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
              <h1 className="text-3xl font-black text-white tracking-tighter">SECURE<span className="text-teal-500">VAULT</span></h1>
            </div>

            <div className="mb-8">
              <h2 className="text-2xl font-bold text-teal-400 mb-2">EMAIL VERIFICATION</h2>
              <p className="text-stone-400">Confirm your email to activate your account</p>
              
              <div className="mt-6 p-4 bg-cyan-900/20 border border-cyan-500/30 rounded-xl shadow-[0_0_15px_rgba(6,182,212,0.1)] backdrop-blur-sm">
                 <p className="text-cyan-100/80 text-xs flex items-start gap-3">
                    <FiMail className="text-cyan-400 flex-shrink-0 mt-0.5" size={16} />
                    <span className="leading-relaxed">
                      If the code doesn't appear in your inbox within 1 minute, please check your <span className="text-cyan-300 font-bold border-b border-cyan-500/50">Spam</span> or <span className="text-cyan-300 font-bold border-b border-cyan-500/50">Junk</span> folder.
                    </span>
                 </p>
              </div>
            </div>

            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

            <form onSubmit={handleVerifyOtp} className="space-y-6">
              <div className="relative">
                <input
                  type="text"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="Verification Code"
                  className="w-full text-center text-3xl tracking-widest font-mono py-4 rounded-lg bg-stone-800 text-white focus:outline-none transition-all duration-300"
                  style={{
                    boxShadow: 'inset 5px 5px 10px rgba(0, 0, 0, 0.6), inset -5px -5px 10px rgba(255, 255, 255, 0.05)'
                  }}
                />
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2 w-2 h-2 rounded-full bg-transparent"></div>
              </div>

              <button
                type="submit"
                disabled={isVerifying || otpCode.length < 6}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-teal-500 to-teal-600 text-white font-semibold transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  boxShadow: '5px 5px 15px rgba(0,150,150,0.4), -5px -5px 15px rgba(100,200,200,0.2)'
                }}
              >
                {isVerifying ? "Verifying..." : "Verify Code"}
              </button>
            </form>

            <div className="mt-6 pt-4 border-t border-stone-700">
              <p className="text-stone-500 text-xs mb-2">Didn't receive the code?</p>
              <button
                onClick={handleResend}
                type="button"
                disabled={countdown > 0 || isResending}
                className="flex items-center justify-center gap-2 w-full py-2 text-sm text-stone-300 hover:bg-stone-700/50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  boxShadow: '3px 3px 6px rgba(0, 0, 0, 0.4), -3px -3px 6px rgba(255, 255, 255, 0.05)'
                }}
              >
                <FiRefreshCw size={14} /> {countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
              </button>
            </div>

            <div className="text-center mt-8">
              <p className="text-stone-500 text-sm">
                Already have an account? <Link to="/login" className="font-semibold text-teal-500 hover:underline">Login</Link>
              </p>
            </div>
          </div>
        </div>

        {/* Right Panel - Dynamic Visualization */}
        <div className="w-full md:w-3/5 bg-gradient-to-br from-stone-900 to-black relative overflow-hidden flex items-center justify-center p-8">
          {/* Abstract 3D visualization */}
          <div className="absolute inset-0 z-0">
            <div className="absolute top-1/4 left-1/4 w-32 h-32 rounded-full bg-teal-500/10 blur-3xl animate-pulse"></div>
            <div className="absolute bottom-1/3 right-1/3 w-48 h-48 rounded-full bg-blue-500/10 blur-3xl animate-pulse delay-1000"></div>
            <div className="absolute top-1/3 right-1/4 w-24 h-24 rounded-full bg-orange-500/10 blur-3xl animate-pulse delay-500"></div>
          </div>

          {/* Grid pattern */}
          <div className="absolute inset-0 z-0 opacity-20"
               style={{
                 backgroundImage: `linear-gradient(stone 1px, transparent 1px), linear-gradient(to right, stone 1px, transparent 1px)`,
                 backgroundSize: '40px 40px'
               }}></div>

          {/* Central security graphic */}
          <div className="relative z-10 text-center max-w-lg">
            <div className="inline-block mb-8 relative">
              <div className="w-48 h-48 rounded-full border-4 border-teal-500/30 flex items-center justify-center">
                <div className="w-32 h-32 rounded-full border-4 border-teal-500/20 flex items-center justify-center">
                  <div className="w-20 h-20 rounded-full border-4 border-teal-500/10 flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-r from-teal-500 to-teal-700 flex items-center justify-center">
                      <div className="w-6 h-6 rounded-full bg-teal-300 animate-pulse"></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scanning animation */}
              <div className="absolute inset-0 rounded-full border-4 border-teal-500 animate-ping opacity-20"></div>
            </div>

            <h2 className="text-3xl font-black text-white mb-4 tracking-tighter">ACCOUNT<span className="text-teal-500">-</span>SETUP</h2>
            <p className="text-stone-400 mb-6">Complete your registration to join the secure communication network.</p>

            <div className="grid grid-cols-3 gap-4 mt-12">
              <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
                <div className="text-teal-500 text-2xl mb-2">🔒</div>
                <h3 className="font-bold text-white text-sm">E2E ENCRYPTED</h3>
              </div>
              <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
                <div className="text-teal-500 text-2xl mb-2">🔑</div>
                <h3 className="font-bold text-white text-sm">KEY OWNERSHIP</h3>
              </div>
              <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
                <div className="text-teal-500 text-2xl mb-2">🛡️</div>
                <h3 className="font-bold text-white text-sm">PRIVACY FIRST</h3>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // STEP 1: REGISTER FORM
  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-stone-900">
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
            <h1 className="text-3xl font-black text-white tracking-tighter">SECURE<span className="text-teal-500">VAULT</span></h1>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-teal-400 mb-2">NEW ACCOUNT SETUP</h2>
            <p className="text-stone-400">Register to create your secure communication vault</p>
          </div>

          {error && step === 'form' && <div className="text-red-500 text-center mb-4 text-sm">{error}</div>}

          <AuthForm
            onSubmit={handleRegister}
            button="Sign Up"
          />

          {/* Turnstile Widget */}
          <div className="mt-4 flex justify-center">
            <Turnstile
              siteKey="0x4AAAAAACN0kvKqxA8cYt6U" // Ganti dengan Site Key Cloudflare kamu!
              onSuccess={setTurnstileToken}
              onError={() => toast.error("Security check failed. Please refresh.")}
              onExpire={() => setTurnstileToken('')}
              options={{ theme: 'auto' }}
            />
          </div>

          <div className="text-center mt-6">
            <p className="text-stone-500 text-sm">
              Already have an account? <Link to="/login" className="font-semibold text-teal-500 hover:underline">Login</Link>
            </p>
            <div className="mt-4 pt-4 border-t border-stone-800">
              <Link to="/privacy" className="text-xs text-stone-600 hover:text-stone-400 transition-colors">Privacy Policy & Terms</Link>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Dynamic Visualization */}
      <div className="w-full md:w-3/5 bg-gradient-to-br from-stone-900 to-black relative overflow-hidden flex items-center justify-center p-8">
        {/* Abstract 3D visualization */}
        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/4 left-1/4 w-32 h-32 rounded-full bg-teal-500/10 blur-3xl animate-pulse"></div>
          <div className="absolute bottom-1/3 right-1/3 w-48 h-48 rounded-full bg-blue-500/10 blur-3xl animate-pulse delay-1000"></div>
          <div className="absolute top-1/3 right-1/4 w-24 h-24 rounded-full bg-orange-500/10 blur-3xl animate-pulse delay-500"></div>
        </div>

        {/* Grid pattern */}
        <div className="absolute inset-0 z-0 opacity-20"
             style={{
               backgroundImage: `linear-gradient(stone 1px, transparent 1px), linear-gradient(to right, stone 1px, transparent 1px)`,
               backgroundSize: '40px 40px'
             }}></div>

        {/* Central security graphic */}
        <div className="relative z-10 text-center max-w-lg">
          <div className="inline-block mb-8 relative">
            <div className="w-48 h-48 rounded-full border-4 border-teal-500/30 flex items-center justify-center">
              <div className="w-32 h-32 rounded-full border-4 border-teal-500/20 flex items-center justify-center">
                <div className="w-20 h-20 rounded-full border-4 border-teal-500/10 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-r from-teal-500 to-teal-700 flex items-center justify-center">
                    <div className="w-6 h-6 rounded-full bg-teal-300 animate-pulse"></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Scanning animation */}
            <div className="absolute inset-0 rounded-full border-4 border-teal-500 animate-ping opacity-20"></div>
          </div>

          <h2 className="text-3xl font-black text-white mb-4 tracking-tighter">INDUSTRIAL-<span className="text-teal-500">GRADE</span> SECURITY</h2>
          <p className="text-stone-400 mb-6">Your communications are protected with end-to-end encryption using the Signal Protocol.</p>

          <div className="grid grid-cols-3 gap-4 mt-12">
            <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
              <div className="text-teal-500 text-2xl mb-2">🔒</div>
              <h3 className="font-bold text-white text-sm">E2E ENCRYPTED</h3>
            </div>
            <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
              <div className="text-teal-500 text-2xl mb-2">🔑</div>
              <h3 className="font-bold text-white text-sm">KEY OWNERSHIP</h3>
            </div>
            <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
              <div className="text-teal-500 text-2xl mb-2">🛡️</div>
              <h3 className="font-bold text-white text-sm">PRIVACY FIRST</h3>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}