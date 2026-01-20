import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiCheckCircle, FiXCircle, FiChevronLeft, FiSmartphone } from 'react-icons/fi';
import { Spinner } from '@components/Spinner';
import { getSocket, connectSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import toast from 'react-hot-toast';
import { useAuthStore, type User } from '@store/auth';

export default function LinkDevicePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<'initializing' | 'waiting' | 'processing' | 'success' | 'failed'>('initializing');
  const [error, setError] = useState<string | null>(null);
  
  const navigate = useNavigate();
  
  const ephemeralKeyPair = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);
  const handlerRef = useRef<(data: any) => void>();

  const handleLinkingSuccess = useCallback(async (data: {user: User, accessToken: string, encryptedMasterKey: string}) => {
    setStatus('processing');
    toast.loading("Secure payload received. Preparing device...", { id: 'link-process' });

    try {
      const sodium = await getSodium();
      
      if (!data.encryptedMasterKey || !data.user || !data.accessToken) {
        throw new Error("Incomplete payload received from server.");
      }
      if (!ephemeralKeyPair.current) {
        throw new Error("Ephemeral keys lost. Please refresh the page and try again.");
      }

      // 1. Decrypt the master seed using the ephemeral private key
      const cipherText = sodium.from_base64(data.encryptedMasterKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const masterSeed = sodium.crypto_box_seal_open(
        cipherText, 
        ephemeralKeyPair.current.publicKey, 
        ephemeralKeyPair.current.privateKey
      );

      if (!masterSeed || masterSeed.length === 0) {
        throw new Error("Failed to decrypt the payload. QR code may be invalid or expired.");
      }
      
      // 2. Re-encrypt the master seed for local storage with a new one-time auto-unlock key
      const autoUnlockKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      const encryptedSeed = sodium.crypto_secretbox_easy(masterSeed, nonce, autoUnlockKey);
      
      // FIX: The worker's `retrievePrivateKeys` function expects a `salt` property, even if unused in auto-unlock.
      // We'll add a dummy salt to match the expected data shape and prevent a parsing error.
      const dummySalt = sodium.randombytes_buf(16);

      const storageBundle = {
        cipherText: sodium.to_base64(encryptedSeed, sodium.base64_variants.URLSAFE_NO_PADDING),
        nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
        salt: sodium.to_base64(dummySalt, sodium.base64_variants.URLSAFE_NO_PADDING),
      };
      
      // 3. Persist everything to localStorage for the bootstrap process on the next page
      localStorage.setItem('encryptedPrivateKeys', JSON.stringify(storageBundle));
      localStorage.setItem('device_auto_unlock_key', sodium.to_base64(autoUnlockKey, sodium.base64_variants.URLSAFE_NO_PADDING));
      localStorage.setItem('linking_user', JSON.stringify(data.user));
      localStorage.setItem('linking_accessToken', data.accessToken);
      
      toast.success("Device successfully paired! Please wait.", { id: 'link-process' });
      setStatus('success');

      // 4. Navigate to the login page where the bootstrap process will take over
      setTimeout(() => {
        navigate('/login', { state: { fromLinking: true }, replace: true });
      }, 1500);

    } catch (err: any) {
      console.error("Linking handshake failed:", err);
      const errorMessage = err.message || "An unknown error occurred during decryption.";
      toast.error(`Linking failed: ${errorMessage}`, { id: 'link-process', duration: 4000 });
      setStatus('failed');
      setError(errorMessage);
    }
  }, [navigate]);
  
  useEffect(() => {
    handlerRef.current = handleLinkingSuccess;
  }, [handleLinkingSuccess]);

  useEffect(() => {
    const socket = getSocket();
    let isSubscribed = true;

    const initialize = async () => {
      try {
        const sodium = await getSodium();
        
        const keyPair = sodium.crypto_box_keypair();
        ephemeralKeyPair.current = keyPair;
        
        const pubKeyB64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);

        if (!socket.connected) {
          connectSocket();
        }

        socket.emit('auth:request_linking_qr', { publicKey: pubKeyB64 }, (response: {token?: string, error?: string}) => {
          if (!isSubscribed) return;
          if (response?.error) {
            throw new Error(response.error);
          }
          if (response?.token) {
            setQrData(JSON.stringify({
              roomId: response.token,
              linkingPubKey: pubKeyB64
            }));
            setStatus('waiting');
          } else {
            throw new Error("Did not receive a valid token from server.");
          }
        });

      } catch (err: any) {
        console.error("Linking init error:", err);
        if (isSubscribed) {
          setError(err.message || "Failed to initialize security session.");
          setStatus('failed');
        }
      }
    };

    initialize();

    const onLinkingSuccess = (data: any) => {
      if (handlerRef.current) {
        handlerRef.current(data);
      }
    };
    
    socket.on('auth:linking_success', onLinkingSuccess);

    return () => {
      isSubscribed = false;
      socket.off('auth:linking_success', onLinkingSuccess);
    };
  }, []);

  return (
    <div className="relative flex flex-col items-center justify-center h-screen bg-bg-main text-text-primary p-4 overflow-hidden">
      <Link to="/login" className="absolute top-6 left-6 p-3 rounded-full bg-bg-surface shadow-neumorphic-convex text-text-secondary hover:text-text-primary">
        <FiChevronLeft size={24} />
      </Link>

      <div className="bg-bg-surface p-10 rounded-2xl shadow-neumorphic-flat text-center max-w-md w-full border border-white/5">
        <h1 className="text-3xl font-bold mb-2 bg-gradient-to-r from-text-primary to-text-secondary bg-clip-text text-transparent">Link Another Device</h1>
        <p className="text-text-secondary text-sm mb-8">
          On an existing logged-in device, go to <br/> Settings &gt; Link Device and scan this code.
        </p>

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

        <div className="h-10 flex justify-center items-center">
          {status === 'initializing' && <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> Preparing secure session...</div>}
          {status === 'waiting' && <div className="flex items-center gap-2 text-accent animate-pulse"><FiSmartphone /> Waiting for scan...</div>}
          {status === 'processing' && <div className="flex items-center gap-2 text-text-secondary"><Spinner size="sm" /> Finalizing connection...</div>}
          {status === 'success' && <div className="text-green-500 font-medium">Redirecting to login...</div>}
          {status === 'failed' && <div className="flex flex-col items-center gap-2 text-red-500"><FiXCircle /> <span>Error: {error}</span></div>}
        </div>
      </div>
    </div>
  );
}