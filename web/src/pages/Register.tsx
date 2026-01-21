import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
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

  const navigate = useNavigate();
  const { registerAndGeneratePhrase, verifyEmail, resendVerification } = useAuthStore();

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
    return <RecoveryPhraseModal phrase={recoveryPhrase} onClose={() => navigate('/chat')} />
  }

  // STEP 2: OTP FORM
  if (step === 'otp') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-main p-4">
        <div className="w-full max-w-md bg-bg-surface rounded-xl p-8 shadow-neumorphic-concave text-center">
          <div className="mb-4 flex justify-center text-accent">
            <FiMail size={48} />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-2">Verify your Email</h1>
          <p className="text-text-secondary text-sm mb-6">
            We sent a verification code to <br/> <span className="font-semibold text-text-primary">{emailForVerify}</span>
          </p>

          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

          <form onSubmit={handleVerifyOtp} className="space-y-6">
            <input 
              type="text" 
              maxLength={6}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-full text-center text-3xl tracking-widest font-mono py-3 rounded-lg bg-bg-main text-text-primary border border-border focus:border-accent focus:ring-1 focus:ring-accent outline-none transition-all"
            />
            
            <button 
              type="submit" 
              disabled={isVerifying || otpCode.length < 6}
              className="w-full py-3 rounded-lg bg-accent text-white font-semibold shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isVerifying ? "Verifying..." : "Verify Code"}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-border">
            <p className="text-text-secondary text-xs mb-2">Didn't receive the code?</p>
            <button
              onClick={handleResend}
              type="button"
              disabled={countdown > 0 || isResending}
              className="flex items-center justify-center gap-2 w-full py-2 text-sm text-text-primary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FiRefreshCw size={14} /> {countdown > 0 ? `Resend in ${countdown}s` : "Resend Code"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // STEP 1: REGISTER FORM
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-main p-4">
      <div className="w-full max-w-md bg-bg-surface rounded-xl p-8 shadow-neumorphic-concave">
        <h1 className="text-3xl font-bold text-center text-foreground mb-6">Register</h1>
        
        {/* Pass error state down if AuthForm supports it, otherwise handle locally */}
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
            options={{ theme: 'auto' }}
          />
        </div>

        <div className="text-center mt-6">
          <p className="text-text-secondary">
            Already have an account? <Link to="/login" className="font-semibold text-accent hover:underline">Login</Link>
          </p>
        </div>
      </div>
    </div>
  );
}