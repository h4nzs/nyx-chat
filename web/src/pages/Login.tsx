import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import AuthForm from "../components/AuthForm";
import { IoFingerPrint } from "react-icons/io5";

export default function Login() {
  const [error, setError] = useState("");
  const [isBiometricsAvailable, setIsBiometricsAvailable] = useState(false);
  const navigate = useNavigate();

  const { login, loginWithBiometrics } = useAuthStore(s => ({ 
    login: s.login, 
    loginWithBiometrics: s.loginWithBiometrics,
  }));

  useEffect(() => {
    if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setIsBiometricsAvailable);
    }
  }, []);

  const handleLogin = async (data: { a: string; b?: string }) => {
    if (!data.a || !data.b) {
      setError("Both fields are required.");
      return;
    }
    try {
      await login(data.a, data.b);
      navigate("/chat");

    } catch (err: any) {
      setError(err.message || "Login failed. Please check your credentials.");
    }
  };

  async function handleBiometricLogin(username: string) {
    if (!username) {
      setError("Please enter your username or email first to use biometrics.");
      return;
    }
    try {
      await loginWithBiometrics(username);
      navigate("/chat");
    } catch (err: any) {
      setError(err.message || "Biometric login failed.");
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
            onClick={() => handleBiometricLogin((document.querySelector('input[placeholder="Email or Username"]') as HTMLInputElement)?.value)}
            className="w-full flex items-center justify-center gap-3 mt-4 btn btn-secondary"
          >
            <IoFingerPrint />
            <span>Login with Biometrics</span>
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
