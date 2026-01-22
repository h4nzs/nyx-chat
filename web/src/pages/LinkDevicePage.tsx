import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiCheckCircle, FiXCircle, FiChevronLeft, FiSmartphone } from 'react-icons/fi';
import { Spinner } from '@components/Spinner';
import { getSocket, connectSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { reEncryptBundleFromMasterKey } from '@lib/crypto-worker-proxy'; // Import fungsi ini!
import toast from 'react-hot-toast';
import { useAuthStore } from '@store/auth';

export default function LinkDevicePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<'initializing' | 'waiting' | 'processing' | 'success' | 'failed'>('initializing');
  const [error, setError] = useState<string | null>(null);
  
  const navigate = useNavigate();
  // Kita tidak butuh login otomatis dari store, user akan login manual
  
  const ephemeralKeyPair = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);

  // Inisialisasi Sesi (Socket & QR)
  useEffect(() => {
    let isMounted = true;
    const socket = getSocket();

    const initializeSession = async () => {
      try {
        setStatus('initializing');
        const sodium = await getSodium();
        
        // 1. Generate Ephemeral Keys (Untuk handshake aman)
        const keyPair = sodium.crypto_box_keypair();
        ephemeralKeyPair.current = keyPair;
        
        const pubKeyB64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        // 2. Connect Socket (Guest Mode)
        if (!socket.connected) connectSocket();

        // 3. Minta Room ID ke Server
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
          setError("Failed to initialize.");
          setStatus('failed');
        }
      }
    };

    initializeSession();
  }, []);

  // Handler saat Scan Berhasil
  const handleLinkingSuccess = useCallback(async (data: any) => {
    console.log("📦 Payload received!");
    setStatus('processing');
    toast.loading("Processing keys...", { id: 'link-process' });

    try {
      const sodium = await getSodium();
      
      // 1. Dekripsi Master Key (Layer Transport)
      if (!ephemeralKeyPair.current) throw new Error("Keypair lost.");
      if (!data.encryptedMasterKey) throw new Error("Invalid payload.");

      const cipherText = sodium.from_base64(data.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      const masterSeed = sodium.crypto_box_seal_open(
        cipherText, 
        ephemeralKeyPair.current.publicKey, 
        ephemeralKeyPair.current.privateKey
      );

      // 2. RE-ENKRIPSI MENGGUNAKAN WORKER (PENTING!)
      // Generate password acak mesin (32 bytes)
      const devicePasswordBytes = sodium.randombytes_buf(32);
      const devicePassword = sodium.to_base64(devicePasswordBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

      // Panggil Worker untuk mengenkripsi ulang dengan format yang benar
      // Ini akan menghasilkan format Base64 yang valid, bukan JSON
      const result = await reEncryptBundleFromMasterKey(masterSeed, devicePassword);

      // 3. Simpan ke LocalStorage
      // Bersihkan data lama
      localStorage.removeItem('encryptedPrivateKeys');
      
      // Simpan data baru (String Base64 dari worker)
      localStorage.setItem('encryptedPrivateKeys', result.encryptedPrivateKeys);
      
      // Simpan Public Keys untuk identitas
      if (result.encryptionPublicKeyB64) localStorage.setItem('publicKey', result.encryptionPublicKeyB64);
      if (result.signingPublicKeyB64) localStorage.setItem('signingPublicKey', result.signingPublicKeyB64);

      // Simpan kunci pembuka otomatis (untuk digunakan saat login di perangkat baru)
      localStorage.setItem('device_auto_unlock_key', devicePassword);

      console.log("✅ Keys re-encrypted by worker and saved.");
      
      // 4. Sukses & Redirect
      setStatus('success');
      toast.success("Paired! Redirecting to Login...", { id: 'link-process' });

      // Redirect ke Login Manual (User tinggal klik login, kunci otomatis terbuka)
      setTimeout(() => {
        navigate('/login', { replace: true });
      }, 2000);

    } catch (err: any) {
      console.error("Linking failed:", err);
      toast.error("Error: " + err.message, { id: 'link-process' });
      setStatus('failed');
      setError(err.message);
    }
  }, [navigate]);

  // Pasang Listener Socket
  useEffect(() => {
    const socket = getSocket();
    socket.on('auth:linking_success', handleLinkingSuccess);
    return () => {
      socket.off('auth:linking_success', handleLinkingSuccess);
    };
  }, [handleLinkingSuccess]);

  return (
    <div className="relative flex flex-col items-center justify-center h-screen bg-bg-main text-text-primary p-4 overflow-hidden">
      <Link to="/auth/login" className="absolute top-6 left-6 touch-target p-3 rounded-full bg-bg-surface shadow-neumorphic-convex text-text-secondary hover:text-text-primary">
        <FiChevronLeft size={24} />
      </Link>

      <div className="card-neumorphic p-10 text-center max-w-md w-full">
        <h1 className="text-3xl font-bold mb-2 bg-gradient-to-r from-text-primary to-text-secondary bg-clip-text text-transparent">Link Device</h1>
        <p className="text-text-secondary text-sm mb-8">
          Go to Settings &gt; Link Device on your phone
        </p>

        {/* CONTAINER UI */}
        <div className="bg-white p-4 rounded-xl inline-block mb-8 shadow-inner min-w-[250px] min-h-[250px] flex items-center justify-center">

          {status === 'success' ? (
            <div className="flex flex-col items-center animate-bounce-in">
              <FiCheckCircle size={100} className="text-green-500 mb-4" />
              <p className="text-green-600 font-bold text-lg">Paired!</p>
            </div>
          ) : qrData ? (
            <QRCode value={qrData} size={220} level="M" />
          ) : (
            <div className="flex items-center justify-center">
              {status === 'failed' ? <FiXCircle size={60} className="text-red-400" /> : <Spinner size="lg" />}
            </div>
          )}

        </div>

        {/* STATUS TEXT */}
        <div className="h-8 flex justify-center">
          {status === 'initializing' && <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> Preparing...</div>}
          {status === 'waiting' && <div className="flex items-center gap-2 text-accent animate-pulse"><FiSmartphone /> Scan with mobile app</div>}
          {status === 'processing' && <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> Securing keys...</div>}
          {status === 'success' && <div className="text-green-500 font-medium">Redirecting to login...</div>}
          {status === 'failed' && <div className="text-red-500 text-sm">{error}</div>}
        </div>
      </div>
    </div>
  );
}