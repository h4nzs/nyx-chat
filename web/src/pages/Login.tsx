import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore, type User } from "../store/auth";
import { useModalStore } from "../store/modal";
import AuthForm from "../components/AuthForm";
import { IoFingerPrint } from "react-icons/io5";
import { startAuthentication, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from "@lib/api";
import { retrievePrivateKeys } from "@lib/crypto-worker-proxy";
import { connectSocket } from "@lib/socket";
import { getEncryptedKeys } from "@lib/keyStorage";
import toast from "react-hot-toast";

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

      // Check if user has pending email verification
      const verificationState = await import('@utils/verificationPersistence').then(
        ({ getVerificationState }) => getVerificationState()
      );

      if (verificationState) {
        // User has pending verification, redirect to verification page
        navigate("/register", { state: { showVerification: true, ...verificationState } });
      } else {
        navigate("/chat");
      }

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
      const result = await api<{ verified: boolean; user: User; accessToken: string; encryptedPrivateKey?: string }>("/api/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify(authResp)
      });

      if (result.verified && result.accessToken) {
        // D. Login Sukses -> Set Store
        useAuthStore.getState().setAccessToken(result.accessToken);
        useAuthStore.getState().setUser(result.user);

        // [SYNC] Restore Encrypted Keys from Server if available
        if (result.encryptedPrivateKey) {
          const { saveEncryptedKeys } = await import("@lib/keyStorage");
          await saveEncryptedKeys(result.encryptedPrivateKey);
          useAuthStore.getState().setHasRestoredKeys(true);
        }

        // Try auto-unlock first
        const autoUnlockSuccess = await useAuthStore.getState().tryAutoUnlock();
        const hasEncryptedKeys = await getEncryptedKeys();

        if (!autoUnlockSuccess && hasEncryptedKeys) {
          // Kunci ada (baru diunduh), tapi tidak bisa dibuka otomatis (karena biometric gak bawa password).
          // Minta user input password SEKALI untuk membuka brankas.
          useModalStore.getState().showPasswordPrompt(async (password) => {
            if (!password) return; // User cancel

            try {
              const encryptedKeys = await getEncryptedKeys();
              const result = await retrievePrivateKeys(encryptedKeys!, password);
              
              if (result.success) {
                // Sukses! Simpan password biar besok2 auto-unlock jalan
                const { saveDeviceAutoUnlockKey, setDeviceAutoUnlockReady } = await import("@lib/keyStorage");
                await saveDeviceAutoUnlockKey(password);
                await setDeviceAutoUnlockReady(true);

                useAuthStore.getState().setDecryptedKeys(result.keys);
                await useAuthStore.getState().loadBlockedUsers();
                connectSocket();
                
                // Redirect logic
                const verificationState = await import('@utils/verificationPersistence').then(m => m.getVerificationState());
                if (verificationState) {
                  navigate("/register", { state: { showVerification: true, ...verificationState } });
                } else {
                  navigate("/chat");
                }
              } else {
                toast.error("Password salah. Gagal mendekripsi kunci.");
              }
            } catch (e) {
              console.error("Decryption error:", e);
              toast.error("Terjadi kesalahan saat dekripsi.");
            }
          });
          
          // Jangan redirect dulu, tunggu user isi password di modal
          return; 
        } 
        
        // Kalau auto-unlock sukses (jarang terjadi di flow baru ini) atau tidak ada kunci
        await useAuthStore.getState().loadBlockedUsers();
        connectSocket();

        // Check verification state
        const verificationState = await import('@utils/verificationPersistence').then(
          ({ getVerificationState }) => getVerificationState()
        );

        if (verificationState) {
          navigate("/register", { state: { showVerification: true, ...verificationState } });
        } else {
          navigate("/chat");
        }
      }
    } catch (err: any) {
      console.error("Biometric login error:", err);

      // Tangani berbagai jenis error WebAuthn
      if (err.name === 'NotAllowedError') {
        setError("Biometric authentication was cancelled or timed out.");
        return;
      } else if (err.name === 'SecurityError') {
        setError("Biometric authentication is not available due to security settings.");
        return;
      } else if (err.name === 'AbortError') {
        setError("Biometric authentication was aborted.");
        return;
      } else if (err.name === 'InvalidStateError') {
        setError("Device is locked or already authenticated. Please try again later.");
        return;
      }

      // Error umum
      setError("Biometric login failed. Please use password or try again.");
    }
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-stone-900">
      {/* Left Panel - Concrete Security Panel */}
      <div className="w-full md:w-2/5 bg-gradient-to-br from-stone-800 to-stone-900 p-8 flex flex-col justify-center"
           style={{
             boxShadow: 'inset -10px -10px 30px rgba(0, 0, 0, 0.5)'
           }}>
        <div className="max-w-md w-full mx-auto">
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 rounded-lg bg-orange-500 flex items-center justify-center mr-3">
              <div className="w-8 h-8 rounded bg-orange-300"></div>
            </div>
            <h1 className="text-3xl font-black text-white tracking-tighter">SECURE<span className="text-orange-500">VAULT</span></h1>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-orange-400 mb-2">ACCESS TERMINAL</h2>
            <p className="text-stone-400">Authenticate to access your encrypted communications</p>
          </div>

          {error && <p className="text-red-500 text-center mb-4 text-sm">{error}</p>}

          <AuthForm
            onSubmit={handleLogin}
            button="Login"
          />

          {isBiometricsAvailable && (
            <button
              type="button"
              onClick={handleBiometricLogin}
              className="w-full flex items-center justify-center gap-3 mt-6 py-3 px-4 rounded-lg bg-stone-700 text-stone-200 font-medium transition-all duration-300"
              style={{
                boxShadow: '3px 3px 6px rgba(0, 0, 0, 0.4), -3px -3px 6px rgba(255, 255, 255, 0.05)'
              }}
            >
              <div className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center">
                <div className="w-2 h-2 rounded-full bg-orange-200"></div>
              </div>
              <span>Biometric Authentication</span>
            </button>
          )}

          <div className="text-center mt-8 pt-6 border-t border-stone-700">
            <p className="text-stone-500 text-sm mb-4">
              Don't have an account? <Link to="/register" className="font-semibold text-orange-500 hover:underline">Sign up</Link>
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-4">
              <Link to="/restore" className="text-sm text-orange-500 hover:underline">Restore from phrase</Link>
              <Link to="/link-device" className="text-sm text-orange-500 hover:underline">Link a new device</Link>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Dynamic Visualization */}
      <div className="w-full md:w-3/5 bg-gradient-to-br from-stone-900 to-black relative overflow-hidden flex items-center justify-center p-8">
        {/* Abstract 3D visualization */}
        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/4 left-1/4 w-32 h-32 rounded-full bg-orange-500/10 blur-3xl animate-pulse"></div>
          <div className="absolute bottom-1/3 right-1/3 w-48 h-48 rounded-full bg-blue-500/10 blur-3xl animate-pulse delay-1000"></div>
          <div className="absolute top-1/3 right-1/4 w-24 h-24 rounded-full bg-teal-500/10 blur-3xl animate-pulse delay-500"></div>
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
            <div className="w-48 h-48 rounded-full border-4 border-orange-500/30 flex items-center justify-center">
              <div className="w-32 h-32 rounded-full border-4 border-orange-500/20 flex items-center justify-center">
                <div className="w-20 h-20 rounded-full border-4 border-orange-500/10 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-r from-orange-500 to-orange-700 flex items-center justify-center">
                    <div className="w-6 h-6 rounded-full bg-orange-300 animate-pulse"></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Scanning animation */}
            <div className="absolute inset-0 rounded-full border-4 border-orange-500 animate-ping opacity-20"></div>
          </div>

          <h2 className="text-3xl font-black text-white mb-4 tracking-tighter">INDUSTRIAL-<span className="text-orange-500">GRADE</span> SECURITY</h2>
          <p className="text-stone-400 mb-6">Your communications are protected with end-to-end encryption using the Signal Protocol.</p>

          <div className="grid grid-cols-3 gap-4 mt-12">
            <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
              <div className="text-orange-500 text-2xl mb-2">🔒</div>
              <h3 className="font-bold text-white text-sm">E2E ENCRYPTED</h3>
            </div>
            <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
              <div className="text-orange-500 text-2xl mb-2">🔑</div>
              <h3 className="font-bold text-white text-sm">KEY OWNERSHIP</h3>
            </div>
            <div className="p-4 bg-stone-800/50 backdrop-blur-sm rounded-lg border border-stone-700">
              <div className="text-orange-500 text-2xl mb-2">🛡️</div>
              <h3 className="font-bold text-white text-sm">PRIVACY FIRST</h3>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}