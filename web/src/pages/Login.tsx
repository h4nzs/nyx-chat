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
      const result = await api<{ verified: boolean; user: User; accessToken: string }>("/api/auth/webauthn/login/verify", {
        method: "POST",
        body: JSON.stringify(authResp)
      });

      if (result.verified && result.accessToken) {
        // D. Login Sukses -> Set Store -> Redirect
        useAuthStore.getState().setAccessToken(result.accessToken);
        useAuthStore.getState().setUser(result.user);

        // For biometric login, we need to handle key decryption
        // Try auto-unlock first (this works if device_auto_unlock_key is available)
        const autoUnlockSuccess = await useAuthStore.getState().tryAutoUnlock();

        // If auto-unlock failed and we have encrypted keys, we need to prompt for password now
        // This provides better UX than prompting later when user tries to send a message
        const hasEncryptedKeys = !!localStorage.getItem('encryptedPrivateKeys');
        if (!autoUnlockSuccess && hasEncryptedKeys) {
          // Prompt for password to decrypt keys now
          useModalStore.getState().showPasswordPrompt(async (password) => {
            if (!password) {
              // If user cancels, they can still use the app but won't be able to send messages
              // until they provide the password
              console.log("User cancelled password prompt. Keys remain locked.");
              return;
            }

            try {
              const encryptedKeys = localStorage.getItem('encryptedPrivateKeys');
              if (!encryptedKeys) {
                console.error("No encrypted keys found in storage");
                return;
              }

              const result = await retrievePrivateKeys(encryptedKeys, password);
              if (result.success) {
                // Set the decrypted keys directly in the store
                useAuthStore.getState().setDecryptedKeys(result.keys);
                console.log("✅ Keys decrypted and cached successfully via biometric login.");

                // Initialize post-login functionality after setting decrypted keys
                await useAuthStore.getState().loadBlockedUsers();
                connectSocket();
              } else {
                console.error("Failed to decrypt keys:", result.reason);
                // Optionally show an error to the user
              }
            } catch (e) {
              console.error("Error during key decryption:", e);
            }
          });
        } else if (autoUnlockSuccess || !hasEncryptedKeys) {
          // If auto-unlock succeeded or there are no encrypted keys,
          // initialize post-login functionality immediately
          await useAuthStore.getState().loadBlockedUsers();
          connectSocket();
        }

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
    <div className="min-h-screen flex items-center justify-center bg-bg-main p-4">
      <div className="w-full max-w-md card-neumorphic p-8">
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
          <div className="flex flex-col sm:flex-row justify-center gap-4 mt-4">
            <Link to="/restore" className="text-sm text-accent hover:underline">Restore from phrase</Link>
            <Link to="/link-device" className="text-sm text-accent hover:underline">Link a new device</Link>
          </div>
        </div>
      </div>
    </div>
  );
}