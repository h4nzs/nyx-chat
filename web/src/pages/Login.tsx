import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore, type User } from "../store/auth";
import AuthForm from "../components/AuthForm";
import { IoFingerPrint } from "react-icons/io5";
import { startAuthentication, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from "@lib/api";

export default function Login() {
  const [error, setError] = useState("");
  const [isBiometricsAvailable, setIsBiometricsAvailable] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const { login } = useAuthStore(s => ({
    login: s.login,
  }));

  useEffect(() => {
    // Cek ketersediaan hardware biometric
    platformAuthenticatorIsAvailable().then((available: boolean) => {
      setIsBiometricsAvailable(available);
    });
  }, []);

  const handleLogin = async (data: { a: string; b?: string }) => {
    if (!data.a || !data.b) {
      setError("Both fields are required.");
      return;
    }
    try {
      const restoredNotSynced = location.state?.restoredNotSynced === true;
      await login(data.a, data.b, restoredNotSynced);
      navigate("/chat");

    } catch (err: any) {
      setError(err.message || "Login failed. Please check your credentials.");
    }
  };

  async function handleBiometricLogin() {
    try {
      setError("");
      
      // A. Minta Challenge Login
      const options = await api<any>("/api/auth/webauthn/login/options");

      // B. Browser minta fingerprint user
      const authResp = await startAuthentication(options);

      // C. Verifikasi ke Server
      const result = await api<{ verified: boolean; user: User; accessToken: string }>("/api/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify(authResp)
      });

      if (result.verified && result.accessToken) {
        // D. Login Sukses -> Set Store -> Redirect
        useAuthStore.getState().setAccessToken(result.accessToken);
        useAuthStore.getState().setUser(result.user);
        
        // Auto-unlock keys jika ada di localStorage (dari sesi sebelumnya/link device)
        useAuthStore.getState().tryAutoUnlock();
        
        navigate("/chat");
      }
    } catch (err: any) {
      console.error(err);
      if (err.name === 'NotAllowedError') return; // User cancel
      setError("Biometric login failed. Please use password.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-main p-4">
      <div className="w-full max-w-md bg-bg-surface rounded-xl p-8 shadow-neumorphic-concave">
        <h1 className="text-3xl font-bold text-center text-foreground mb-6">Login</h1>
        {error && <p className="text-red-500 text-center mb-4">{error}</p>}
        <AuthForm 
          onSubmit={handleLogin}
          button="Login"
        />
        {isBiometricsAvailable && (
          <button 
            type="button"
            onClick={handleBiometricLogin}
            className="w-full flex items-center justify-center gap-3 mt-4 btn btn-secondary"
          >
            <IoFingerPrint size={20} />
            <span>Login with Passkey</span>
          </button>
        )}
        <div className="text-center mt-6">
          <p className="text-text-secondary">
            Don't have an account? <Link to="/register" className="font-semibold text-accent hover:underline">Sign up</Link>
          </p>
          <div className="flex justify-center gap-4 mt-4">
            <Link to="/restore" className="text-sm text-accent hover:underline">Restore from phrase</Link>
            <Link to="/link-device" className="text-sm text-accent hover:underline">Link a new device</Link>
          </div>
        </div>
      </div>
    </div>
  );
}