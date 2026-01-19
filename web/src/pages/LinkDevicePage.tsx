import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiCheckCircle, FiXCircle, FiChevronLeft, FiSmartphone } from 'react-icons/fi';
import { Spinner } from '@components/Spinner';
import { getSocket, connectSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import toast from 'react-hot-toast';

export default function LinkDevicePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<'initializing' | 'waiting' | 'processing' | 'success' | 'failed'>('initializing');
  const [error, setError] = useState<string | null>(null);
  
  const navigate = useNavigate();
  
  // Simpan key sementara untuk dekripsi nanti
  const ephemeralKeyPair = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);

  useEffect(() => {
    let isMounted = true;
    const socket = getSocket();

    const initializeSession = async () => {
      try {
        setStatus('initializing');
        
        // 1. Pastikan Sodium Siap
        const sodium = await getSodium();
        
        // 2. Generate Ephemeral Keys
        const keyPair = sodium.crypto_box_keypair();
        ephemeralKeyPair.current = keyPair;
        
        const pubKeyB64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        console.log("🔑 Ephemeral Public Key generated");

        // 3. Connect Socket (Guest Mode)
        if (!socket.connected) {
          connectSocket();
        }

        // 4. Request Linking Room ID
        socket.emit('auth:request_linking_qr', { publicKey: pubKeyB64 }, (response: any) => {
          if (!isMounted) return;

          if (response?.error) {
            setError(response.error);
            setStatus('failed');
            return;
          }

          if (response?.token) {
            setQrData(JSON.stringify({
              roomId: response.token,
              linkingPubKey: pubKeyB64
            }));
            setStatus('waiting');
          }
        });

      } catch (err: any) {
        console.error("Linking init error:", err);
        if (isMounted) {
          setError("Failed to initialize security engine.");
          setStatus('failed');
        }
      }
    };

    initializeSession();

    // --- HANDLE SUKSES SCAN ---
    const handleLinkingSuccess = async (data: any) => {
      if (!isMounted) return;
      
      console.log("📦 Payload received!", data);
      setStatus('processing');
      toast.loading("Securing connection...", { id: 'link-process' });

      try {
        const sodium = await getSodium();
        
        // Validasi Payload
        if (!data.encryptedMasterKey) throw new Error("Missing encrypted master key.");
        if (!ephemeralKeyPair.current) throw new Error("Ephemeral key pair lost. Please refresh.");

        // 1. Dekripsi Master Key
        let masterSeed: Uint8Array;
        try {
            const cipherText = sodium.from_base64(data.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
            
            masterSeed = sodium.crypto_box_seal_open(
              cipherText, 
              ephemeralKeyPair.current.publicKey, 
              ephemeralKeyPair.current.privateKey
            );
        } catch (cryptoErr) {
            console.error("Crypto operation failed:", cryptoErr);
            throw new Error("Failed to decrypt secure payload. Keys do not match.");
        }

        if (!masterSeed) throw new Error("Decryption produced empty result.");
        console.log("🔓 Master Key decrypted successfully. Preparing storage...");

        // 2. ENKRIPSI & SIMPAN (Dengan Fallback Konstanta)
        
        // KONSTANTA FALLBACK (Standard Libsodium Defaults)
        // Kita pakai ini jika properti di object sodium undefined (sering terjadi di wrapper tertentu)
        const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES || 16;
        const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES || 32;
        const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES || 24;
        const OPS_LIMIT = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE || 2;
        const MEM_LIMIT = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE || 67108864;
        const ALG = sodium.crypto_pwhash_ALG_DEFAULT || 2;
        const BASE64_VARIANT = sodium.base64_variants.URLSAFE_NO_PADDING;

        // A. Generate Password Device (Auto-Unlock)
        const devicePasswordBytes = sodium.randombytes_buf(16);
        const devicePassword = sodium.to_base64(devicePasswordBytes, BASE64_VARIANT);
        
        // B. Generate Salt
        const salt = sodium.randombytes_buf(SALT_BYTES);
        
        // C. Hash Password (Argon2) -> Key
        // PENTING: Pastikan semua parameter terisi nilai valid (bukan undefined)
        const keyHash = sodium.crypto_pwhash(
          KEY_BYTES,        // output length
          devicePasswordBytes, // password (buffer)
          salt,             // salt
          OPS_LIMIT,        // opslimit
          MEM_LIMIT,        // memlimit
          ALG               // algorithm
        );

        // D. Enkripsi MasterSeed
        const nonce = sodium.randombytes_buf(NONCE_BYTES);
        const encryptedSeed = sodium.crypto_secretbox_easy(masterSeed, nonce, keyHash);

        // E. Simpan ke LocalStorage
        const storageBundle = {
          cipherText: sodium.to_base64(encryptedSeed, BASE64_VARIANT),
          salt: sodium.to_base64(salt, BASE64_VARIANT),
          nonce: sodium.to_base64(nonce, BASE64_VARIANT)
        };
        
        // Bersihkan & Simpan
        localStorage.removeItem('encryptedPrivateKeys');
        localStorage.setItem('encryptedPrivateKeys', JSON.stringify(storageBundle));
        localStorage.setItem('device_auto_unlock_key', devicePassword);

        console.log("✅ Secure storage ready. Redirecting...");
        // --------------------------------------------------

        toast.success("Device paired! Please login to finish.", { id: 'link-process' });
        setStatus('success');

        // 3. Redirect ke Login Manual
        setTimeout(() => {
          navigate('/login', { state: { fromLinking: true } });
        }, 1500);

      } catch (err: any) {
        console.error("Linking handshake failed:", err);
        toast.error("Linking failed: " + err.message, { id: 'link-process' });
        setStatus('failed');
        setError(err.message);
      }
    };

    socket.on('auth:linking_success', handleLinkingSuccess);

    return () => {
      isMounted = false;
      socket.off('auth:linking_success', handleLinkingSuccess);
    };
  }, [navigate]);

  const renderStatus = () => {
    switch (status) {
      case 'initializing':
        return <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> Preparing...</div>;
      case 'waiting':
        return <div className="flex items-center gap-2 text-accent animate-pulse"><FiSmartphone /> Scan with mobile app</div>;
      case 'processing':
        return <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> Securing keys...</div>;
      case 'success':
        return <div className="flex items-center gap-2 text-green-500 font-bold"><FiCheckCircle /> Paired! Redirecting to Login...</div>;
      case 'failed':
        return <div className="flex items-center gap-2 text-red-500"><FiXCircle /> Error: {error}</div>;
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center h-screen bg-bg-main text-text-primary p-4 overflow-hidden">
      <Link to="/auth/login" className="absolute top-6 left-6 p-3 rounded-full bg-bg-surface shadow-neumorphic-convex text-text-secondary hover:text-text-primary">
        <FiChevronLeft size={24} />
      </Link>

      <div className="bg-bg-surface p-10 rounded-2xl shadow-neumorphic-flat text-center max-w-md w-full border border-white/5">
        <h1 className="text-3xl font-bold mb-2 bg-gradient-to-r from-text-primary to-text-secondary bg-clip-text text-transparent">Link Device</h1>
        <p className="text-text-secondary text-sm mb-8">
          Go to Settings &gt; Link Device on your phone
        </p>

        <div className="bg-white p-4 rounded-xl inline-block mb-8 shadow-inner">
          {qrData ? (
            <QRCode value={qrData} size={220} level="M" />
          ) : (
            <div className="w-[220px] h-[220px] flex items-center justify-center">
              {status === 'failed' ? <FiXCircle size={40} className="text-red-300" /> : <Spinner size="lg" />}
            </div>
          )}
        </div>

        <div className="h-8 flex justify-center">
          {renderStatus()}
        </div>
      </div>
    </div>
  );
}