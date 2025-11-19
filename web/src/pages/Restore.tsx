
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import '../styles/AuthForm.css';
import { FiUser, FiLock, FiRefreshCw } from 'react-icons/fi';
import * as bip39 from 'bip39';
import { getSodium } from "@lib/sodiumInitializer";
import { storePrivateKey, exportPublicKey } from "@utils/keyManagement";
import { syncSessionKeys } from "@utils/sessionSync";
import { api } from "@lib/api";
import toast from "react-hot-toast";

export default function Restore() {
  const [username, setUsername] = useState("");
  const [phrase, setPhrase] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!username || !phrase || !newPassword) {
      setError("All fields are required.");
      return;
    }

    const trimmedPhrase = phrase.trim();
    const wordCount = trimmedPhrase.split(' ').length;

    if (wordCount !== 24) {
      setError(`Invalid phrase length. Expected 24 words, but received ${wordCount}.`);
      return;
    }

    if (!bip39.validateMnemonic(trimmedPhrase)) {
      setError("Invalid recovery phrase. Please check the words and try again.");
      return;
    }

    setLoading(true);
    try {
      // 1. Convert phrase back to private key
      const privateKeyHex = bip39.mnemonicToEntropy(trimmedPhrase);
      const sodium = await getSodium();
      const privateKeyBytes = sodium.from_hex(privateKeyHex);

      if (privateKeyBytes.length !== 32) {
        throw new Error("Failed to derive a valid 32-byte key from the phrase.");
      }

      // 2. Derive public key
      const publicKeyBytes = sodium.crypto_scalarmult_base(privateKeyBytes);
      const publicKeyB64 = sodium.to_base64(publicKeyBytes, sodium.base64_variants.ORIGINAL);

      // 3. Verify phrase and update password on server
      await api("/api/keys/verify", {
        method: "POST",
        body: JSON.stringify({ username, recoveryPhrase: trimmedPhrase, newPassword }),
      });

      // 4. Store the recovered keys on the new device
      const encryptedPrivateKey = await storePrivateKey(privateKeyBytes, newPassword);
      localStorage.setItem('publicKey', publicKeyB64);
      localStorage.setItem('encryptedPrivateKey', encryptedPrivateKey);
      
      toast.success("Account restored successfully! Syncing history...");

      // 5. Log the user in to get a valid token for the next step
      // We do this before sync to ensure authFetch works
      await login(username, newPassword);

      // 6. Sync historical session keys to decrypt old messages
      await syncSessionKeys();

      // 7. Navigate to chat
      navigate("/chat");

    } catch (err: any) {
      setError(err.message || "Restore failed. Please check your details and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="form_main">
        <h1 className="text-3xl font-bold text-foreground mb-8">Restore Account</h1>
        {error && <p className="text-red-500 text-sm mb-4 -mt-4 text-center">{error}</p>}
        <form onSubmit={handleSubmit} noValidate className="w-full flex flex-col items-center">
          <div className="inputContainer">
            <FiUser className="inputIcon" />
            <input 
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="inputField"
              disabled={loading}
              required
            />
          </div>
          <div className="inputContainer">
            <FiRefreshCw className="inputIcon" />
            <textarea 
              placeholder="Enter your 24-word recovery phrase"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              className="inputField h-24 py-2 resize-none"
              disabled={loading}
              required
            />
          </div>
          <div className="inputContainer">
            <FiLock className="inputIcon" />
            <input 
              type="password"
              placeholder="New Password for this device"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="inputField"
              disabled={loading}
              required
            />
          </div>
          <button id="button" type="submit" disabled={loading}>
            {loading ? "Restoring..." : "Restore & Login"}
          </button>
        </form>
        <div className="signupContainer">
          <p>Remember your password?</p>
          <Link to="/login">Login instead</Link>
        </div>
      </div>
    </div>
  );
}
