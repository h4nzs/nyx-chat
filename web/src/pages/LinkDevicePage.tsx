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
  
  // Kita HAPUS useAuthStore karena kita tidak akan melakukan auto-login di sini.
  // Biarkan user login manual di halaman login setelah kunci tersimpan.
  
  const ephemeralKeyPair = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);

  useEffect(() => {
    let isMounted = true;
    const socket = getSocket();

    const initializeSession = async () => {
      try {
        setStatus('initializing');
        const sodium = await getSodium();
        
        // 1. Generate Ephemeral Keys (Sekali pakai buat handshake)
        const keyPair = sodium.crypto_box_keypair();
        ephemeralKeyPair.current = keyPair;
        const pubKeyB64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        // 2. Connect Socket (Guest Mode)
        if (!socket.connected) connectSocket();

        // 3. Request Room ID
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
        console.error("Init error:", err);
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
        
        // 1. Decrypt Master Key (Pakai Ephemeral Key)
        if (!ephemeralKeyPair.current) throw new Error("Ephemeral key lost.");
        const cipherText = sodium.from_base64(data.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        const masterSeed = sodium.crypto_box_seal_open(
          cipherText, 
          ephemeralKeyPair.current.publicKey, 
          ephemeralKeyPair.current.privateKey
        );

        if (!masterSeed) throw new Error("Failed to decrypt Master Key.");

        // --- PERUBAHAN UTAMA DI SINI ---
        // Kita TIDAK memanggil setUser/setAccessToken (Login Otomatis)
        // Kita hanya fokus menyimpan kunci, lalu lempar user ke halaman Login.

        // 2. ENKRIPSI & SIMPAN KEYS
        
        // A. Generate Password Acak untuk Device Ini (Auto-Unlock)
        const devicePasswordBytes = sodium.randombytes_buf(16);
        const devicePassword = sodium.to_base64(devicePasswordBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        // B. Siapkan Salt & Hash Password
        const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
        const keyHash = sodium.crypto_pwhash(
          sodium.crypto_secretbox_KEYBYTES,
          devicePasswordBytes,
          salt,
          sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
          sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
          sodium.crypto_pwhash_ALG_DEFAULT
        );

        // C. Enkripsi MasterSeed
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        const encryptedSeed = sodium.crypto_secretbox_easy(masterSeed, nonce, keyHash);

        // D. Simpan Bundle ke LocalStorage (Gunakan nama standard: 'encryptedPrivateKeys')
        const storageBundle = {
          cipherText: sodium.to_base64(encryptedSeed, sodium.base64_variants.URLSAFE_NO_PADDING),
          salt: sodium.to_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING),
          nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING)
        };
        
        // Bersihkan storage lama biar bersih
        localStorage.removeItem('encryptedPrivateKeys');
        localStorage.removeItem('encrypted_private_keys');
        
        // Simpan yang baru
        localStorage.setItem('encryptedPrivateKeys', JSON.stringify(storageBundle));
        // Simpan kunci pembuka otomatis
        localStorage.setItem('device_auto_unlock_key', devicePassword);

        // --------------------------------------------------

        toast.success("Device paired! Please login to finish.", { id: 'link-process' });
        setStatus('success');

        // Redirect ke Login (Bukan Chat)
        // Delay sedikit untuk memastikan LocalStorage tertulis sempurna
        setTimeout(() => {
          navigate('/login');
        }, 1500);

      } catch (err: any) {
        console.error("Linking failed:", err);
        toast.error("Handshake failed: " + err.message, { id: 'link-process' });
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
        return <div className="flex items-center gap-2 text-green-500 font-bold"><FiCheckCircle /> Linked! Redirecting to Login...</div>;
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