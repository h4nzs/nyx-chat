import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiCheckCircle, FiXCircle, FiChevronLeft, FiSmartphone, FiCpu } from 'react-icons/fi';
import { Spinner } from '@components/Spinner';
import { getSocket, connectSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { reEncryptBundleFromMasterKey } from '@lib/crypto-worker-proxy';
import { saveEncryptedKeys, setDeviceAutoUnlockReady } from '@lib/keyStorage';
import toast from 'react-hot-toast';
import { useAuthStore } from '@store/auth';

export default function LinkDevicePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<'initializing' | 'waiting' | 'processing' | 'success' | 'failed'>('initializing');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const ephemeralKeyPair = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);

  useEffect(() => {
    const isMounted = true;
    const socket = getSocket();

    const initializeSession = async () => {
      try {
        setStatus('initializing');
        const sodium = await getSodium();
        const keyPair = sodium.crypto_box_keypair();
        ephemeralKeyPair.current = keyPair;
        
        const pubKeyB64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        if (!socket.connected) connectSocket();

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

  const handleLinkingSuccess = useCallback(async (data: any) => {
    setStatus('processing');
    toast.loading("Processing keys...", { id: 'link-process' });

    try {
      const sodium = await getSodium();
      
      if (!ephemeralKeyPair.current) throw new Error("Keypair lost.");
      if (!data.encryptedMasterKey) throw new Error("Invalid payload.");

      const cipherText = sodium.from_base64(data.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      const masterSeed = sodium.crypto_box_seal_open(
        cipherText, 
        ephemeralKeyPair.current.publicKey, 
        ephemeralKeyPair.current.privateKey
      );

      const devicePasswordBytes = sodium.randombytes_buf(32);
      const devicePassword = sodium.to_base64(devicePasswordBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

      const result = await reEncryptBundleFromMasterKey(masterSeed, devicePassword);

      // Save the new encrypted bundle
      await saveEncryptedKeys(result.encryptedPrivateKeys);
      
      // Set auto-unlock ready status
      await setDeviceAutoUnlockReady(true);

      setStatus('success');
      toast.success("Paired! Redirecting to Login...", { id: 'link-process' });

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

  useEffect(() => {
    const socket = getSocket();
    socket.on('auth:linking_success', handleLinkingSuccess);
    return () => {
      socket.off('auth:linking_success', handleLinkingSuccess);
    };
  }, [handleLinkingSuccess]);

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-bg-main text-text-primary p-4 overflow-hidden">
      
      <Link 
        to="/auth/login" 
        className="
          absolute top-6 left-6 
          p-3 rounded-full 
          bg-bg-main text-text-secondary
          shadow-neu-flat-light dark:shadow-neu-flat-dark
          active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
          hover:text-accent transition-all
        "
      >
        <FiChevronLeft size={24} />
      </Link>

      <div className="text-center mb-10">
         <div className="inline-flex items-center justify-center p-4 rounded-full bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark mb-4 text-accent">
            <FiCpu size={32} />
         </div>
         <h1 className="text-3xl font-black uppercase tracking-widest text-text-primary">Device Pairing</h1>
         <p className="font-mono text-xs text-text-secondary mt-2 tracking-wide uppercase">Secure Handshake Protocol v2.1</p>
      </div>

      <div className="
        relative p-8 rounded-3xl
        bg-bg-main
        shadow-neu-flat-light dark:shadow-neu-flat-dark
        border border-white/20 dark:border-black/20
        flex flex-col items-center
      ">
        {/* QR Slot */}
        <div className="
          relative bg-white p-4 rounded-xl 
          shadow-[inset_0_2px_10px_rgba(0,0,0,0.2)] 
          border-4 border-bg-main
          mb-8
        ">
          <div className="w-[220px] h-[220px] flex items-center justify-center">
             {status === 'success' ? (
                <div className="flex flex-col items-center animate-bounce-in text-green-500">
                  <FiCheckCircle size={80} />
                </div>
              ) : qrData ? (
                <QRCode value={qrData} size={220} level="M" />
              ) : (
                <div className="flex items-center justify-center text-accent">
                  {status === 'failed' ? <FiXCircle size={60} className="text-red-400" /> : <Spinner size="lg" />}
                </div>
              )}
          </div>
          
          {/* Scan Line Animation */}
          {status === 'waiting' && (
             <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-lg">
                <div className="w-full h-1 bg-accent/50 absolute top-0 animate-scan-line shadow-[0_0_10px_rgba(var(--accent),0.5)]"></div>
             </div>
          )}
        </div>

        {/* Status Display */}
        <div className="w-full h-12 flex items-center justify-center rounded-xl bg-bg-surface font-mono text-xs uppercase tracking-wider shadow-inner px-4">
          {status === 'initializing' && <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> <span>Initializing Uplink...</span></div>}
          {status === 'waiting' && <div className="flex items-center gap-2 text-accent animate-pulse"><FiSmartphone /> <span>Scan with Host Device</span></div>}
          {status === 'processing' && <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> <span>Exchanging Keys...</span></div>}
          {status === 'success' && <div className="text-green-500 font-bold">Link Established. Redirecting...</div>}
          {status === 'failed' && <div className="text-red-500 font-bold">{error || "Handshake Failed"}</div>}
        </div>

      </div>
      
      <p className="mt-8 text-xs text-text-secondary/50 font-mono text-center max-w-sm">
         Go to Settings &gt; Link Device on your primary mobile device to authorize this connection.
      </p>
    </div>
  );
}