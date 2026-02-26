import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import AuthForm from "../components/AuthForm";
import RecoveryPhraseModal from "@components/RecoveryPhraseModal";
import { Turnstile } from '@marsidev/react-turnstile';
import toast from "react-hot-toast";
import { hashUsername } from "@lib/crypto-worker-proxy";

export default function Register() {
  const [error, setError] = useState("");
  const [step, setStep] = useState<'form' | 'recovery'>('form');
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string>('');

  const navigate = useNavigate();
  const { registerAndGeneratePhrase } = useAuthStore();

  async function handleRegister(data: { name?: string, d?: string, b?: string }) {
    const { name, d: username, b: password } = data;
    setError("");

    // --- Validation Logic ---
    if (!name) { throw new Error("Name is required"); }
    if (name.length > 80) { throw new Error("Name must be less than 80 characters"); }
    
    // Username constraints (min 3 chars)
    if (!username || username.length < 3) { throw new Error("Username must be at least 3 characters"); }
    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username)) { throw new Error("Username can only contain letters, numbers, and underscores"); }
    
    if (!password) { throw new Error("Password is required"); }
    if (password.length < 8) { throw new Error("Password must be at least 8 characters"); }
    // --- End Validation ---

    // Validasi Turnstile
    // if (!turnstileToken) { throw new Error("Please complete the CAPTCHA."); }

    try {
      // CLIENT-SIDE BLIND INDEXING
      // Hash the username before it ever leaves the device.
      // The server never sees the plaintext username.
      const usernameHash = await hashUsername(username);

      const result = await registerAndGeneratePhrase({ 
        name, usernameHash, password, turnstileToken 
      });

      setRecoveryPhrase(result.phrase);
      setStep('recovery'); // Success! Show phrase.
      toast.success("Account created successfully!");
      
    } catch (err: any) {
      setError(err.message || "Registration failed");
    }
  }

  useEffect(() => {
    let timerId: NodeJS.Timeout;

    if (step === 'recovery' && !recoveryPhrase) {
      // If phrase is lost (e.g. refresh), just go to chat.
      toast.success("Welcome! You can view your recovery phrase in Settings.");
      timerId = setTimeout(() => navigate('/chat'), 100);
    }

    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [step, recoveryPhrase, navigate]);

  // STEP 2: RECOVERY PHRASE
  if (step === 'recovery') {
    if (!recoveryPhrase) return null;

    return <RecoveryPhraseModal phrase={recoveryPhrase} onClose={() => navigate('/chat')} />
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
            <h2 className="text-2xl font-bold text-teal-400 mb-2">ANONYMOUS REGISTRATION</h2>
            <p className="text-stone-400">Create a secure identity. No email required.</p>
          </div>

          {error && <div className="text-red-500 text-center mb-4 text-sm">{error}</div>}

          {/* Modified AuthForm for Username Only */}
          <AuthForm
            onSubmit={handleRegister}
            button="Initialize Identity"
            hideEmail={true} 
          />

          {/* Turnstile Widget */}
          <div className="mt-4 flex justify-center">
            <Turnstile
              siteKey="0x4AAAAAACN0kvKqxA8cYt6U" 
              onSuccess={setTurnstileToken}
              onError={() => toast.error("Security check failed.")}
              onExpire={() => setTurnstileToken('')}
              options={{ theme: 'auto' }}
            />
          </div>

          <div className="text-center mt-6">
            <p className="text-stone-500 text-sm">
              Already have an identity? <Link to="/login" className="font-semibold text-teal-500 hover:underline">Login</Link>
            </p>
          </div>
        </div>
      </div>

      {/* Right Panel - Dynamic Visualization */}
      <div className="w-full md:w-3/5 bg-gradient-to-br from-stone-900 to-black relative overflow-hidden flex items-center justify-center p-8">
         {/* ... Visualization code ... */}
         <div className="relative z-10 text-center max-w-lg">
            <h2 className="text-3xl font-black text-white mb-4 tracking-tighter">PURE <span className="text-teal-500">ANONYMITY</span></h2>
            <p className="text-stone-400 mb-6">Your username is hashed on your device. We don't know who you are.</p>
         </div>
      </div>
    </div>
  );
}