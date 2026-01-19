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
  const ephemeralKeyPair = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);

  useEffect(() => {
    let isMounted = true;
    const socket = getSocket();

    const initializeSession = async () => {
      try {
        setStatus('initializing');
        const sodium = await getSodium();
        
        // 1. Generate Ephemeral Keys
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
          setError("Failed to initialize.");
          setStatus('failed');
        }
      }
    };

    initializeSession();

    // --- HANDLE SUKSES SCAN ---
    const handleLinkingSuccess = async (data: any) => {
      if (!isMounted) return;
      console.log("📦 Payload received!");
      setStatus('processing');
      toast.loading("Securing keys...", { id: 'link-process' });

      try {
        const sodium = await getSodium();
        
        // 1. Dekripsi Master Key
        if (!ephemeralKeyPair.current) throw new Error("Keypair lost.");
        const cipherText = sodium.from_base64(data.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        
        const masterSeed = sodium.crypto_box_seal_open(
          cipherText, 
          ephemeralKeyPair.current.publicKey, 
          ephemeralKeyPair.current.privateKey
        );

        // 2. SIMPAN KUNCI (Metode Sederhana & Stabil)
        // Kita generate Random Key 32-byte langsung sebagai "Password Device"
        // Tidak perlu hashing (Argon2) karena ini bukan password manusia.
        const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES || 32;
        const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES || 24;
        const BASE64_VARIANT = sodium.base64_variants.URLSAFE_NO_PADDING;

        // A. Buat Key Unlock Otomatis (Langsung 32 bytes valid)
        const deviceAutoUnlockKey = sodium.randombytes_buf(KEY_BYTES);
        
        // B. Enkripsi MasterSeed
        const nonce = sodium.randombytes_buf(NONCE_BYTES);
        const encryptedSeed = sodium.crypto_secretbox_easy(masterSeed, nonce, deviceAutoUnlockKey);

        // C. Simpan ke LocalStorage
        // Kita simpan 'salt' dummy biar formatnya tetap kompatibel dengan fungsi retrievePrivateKeys lama
        const dummySalt = sodium.randombytes_buf(16); 

        const storageBundle = {
          cipherText: sodium.to_base64(encryptedSeed, BASE64_VARIANT),
          salt: sodium.to_base64(dummySalt, BASE64_VARIANT), // Dummy, tidak dipakai jika auto-unlock
          nonce: sodium.to_base64(nonce, BASE64_VARIANT)
        };
        
        // Hapus yang lama & Simpan baru
        localStorage.removeItem('encryptedPrivateKeys');
        localStorage.setItem('encryptedPrivateKeys', JSON.stringify(storageBundle));
        
        // Simpan kunci pembuka (Base64)
        localStorage.setItem('device_auto_unlock_key', sodium.to_base64(deviceAutoUnlockKey, BASE64_VARIANT));

        console.log("✅ Keys saved successfully.");
        
        // --------------------------------------------------

        setStatus('success');
        toast.success("Success! Redirecting to Login...", { id: 'link-process' });

        // Redirect ke Login setelah jeda singkat
        setTimeout(() => {
          navigate('/login', { replace: true });
        }, 2000);

      } catch (err: any) {
        console.error("Linking failed:", err);
        toast.error("Error: " + err.message, { id: 'link-process' });
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

        {/* CONTAINER UI (Berubah sesuai status) */}
        <div className="bg-white p-4 rounded-xl inline-block mb-8 shadow-inner min-w-[250px] min-h-[250px] flex items-center justify-center">
          
          {status === 'success' ? (
            // TAMPILAN SUKSES (Ceklis Besar)
            <div className="flex flex-col items-center animate-bounce-in">
              <FiCheckCircle size={100} className="text-green-500 mb-4" />
              <p className="text-green-600 font-bold text-lg">Paired!</p>
            </div>
          ) : qrData ? (
            // TAMPILAN QR
            <QRCode value={qrData} size={220} level="M" />
          ) : (
            // TAMPILAN LOADING / ERROR
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