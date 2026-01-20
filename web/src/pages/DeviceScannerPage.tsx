import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiChevronLeft, FiCheckCircle, FiXCircle } from 'react-icons/fi';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@store/auth';
import { getSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode';
import { Spinner } from '@components/Spinner';

export default function DeviceScannerPage() {
  const [status, setStatus] = useState<'scanning' | 'processing' | 'success' | 'failed'>('scanning');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const getMasterSeed = useAuthStore(s => s.getMasterSeed);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const qrcodeRegionRef = useRef<HTMLDivElement>(null);
  const isProcessingRef = useRef(false);

  const processQrCode = useCallback(async (decodedText: string) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    setStatus('processing');
    toast.loading('QR Code detected. Synchronizing...', { id: 'linking-toast' });
    
    if (scannerRef.current?.isScanning) {
      scannerRef.current.pause(true);
    }

    try {
      let data;
      try {
        data = JSON.parse(decodedText);
      } catch (e) {
        throw new Error("Invalid QR Code. Not a recognized Chat Lite code.");
      }

      const { roomId, linkingPubKey } = data;
      if (!roomId || !linkingPubKey) throw new Error('Invalid QR code data.');

      const masterSeed = await getMasterSeed();
      if (!masterSeed) {
        throw new Error("Your keys are locked. Please log in again to unlock them.");
      }

      const sodium = await getSodium();
      
      const linkingPubKeyBytes = sodium.from_base64(linkingPubKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const encryptedPayload = sodium.crypto_box_seal(masterSeed, linkingPubKeyBytes);
      const encryptedPayloadB64 = sodium.to_base64(encryptedPayload, sodium.base64_variants.URLSAFE_NO_PADDING);

      const socket = getSocket();
      socket.emit('linking:send_payload', { 
        roomId, 
        encryptedMasterKey: encryptedPayloadB64 
      });

      setStatus('success');
      toast.success('Device successfully linked!', { id: 'linking-toast' });
      
      if (scannerRef.current?.isScanning) {
        await scannerRef.current.stop();
      }
      
      setTimeout(() => navigate('/settings/sessions'), 2000);

    } catch (err: any) {
      console.error("Linking error:", err);
      setError(err.message || 'Failed to process linking.');
      setStatus('failed');
      toast.error(err.message || 'Linking failed.', { id: 'linking-toast' });
    }
  }, [getMasterSeed, navigate]);

  useEffect(() => {
    if (!qrcodeRegionRef.current) {
      console.error("QR Code region ref is not available.");
      return;
    }
    
    const html5QrCode = new Html5Qrcode(qrcodeRegionRef.current.id);
    scannerRef.current = html5QrCode;

    const startScanner = async () => {
      try {
        await html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
          (decodedText) => {
            if (!isProcessingRef.current) {
              processQrCode(decodedText);
            }
          },
          (errorMessage) => { /* ignore frame parse errors */ }
        );
      } catch (err: any) {
        console.error("Camera start error:", err);
        setError('Could not access camera. Please check permissions and refresh the page.');
        setStatus('failed');
      }
    };

    startScanner();

    return () => {
      const stopAndClear = async () => {
        if (scannerRef.current) {
          try {
            const state = scannerRef.current.getState();
            if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
              await scannerRef.current.stop();
            }
            scannerRef.current.clear();
          } catch (e) {
            console.error("Failed to cleanly stop scanner", e);
          }
        }
      };
      stopAndClear();
    };
  }, [processQrCode]);

  const handleRetry = () => {
    if (scannerRef.current) {
      scannerRef.current.resume();
    }
    setStatus('scanning');
    setError(null);
    isProcessingRef.current = false;
  };

  return (
    <div className="flex flex-col h-screen bg-bg-main text-text-primary">
      <header className="p-4 flex items-center border-b border-border bg-bg-surface">
        <Link to="/settings" className="p-2 -ml-2 rounded-full hover:bg-bg-main transition-colors">
          <FiChevronLeft size={24} />
        </Link>
        <h1 className="ml-2 text-xl font-bold">Scan QR Code</h1>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4">
        <div className="bg-bg-surface p-6 rounded-2xl shadow-neumorphic-concave text-center max-w-md w-full">
          
          <div className="relative w-full aspect-square bg-black rounded-xl overflow-hidden shadow-inner mb-4">
            <div id="qr-code-scanner-region" ref={qrcodeRegionRef} className="w-full h-full" />
            
            {status === 'scanning' && (
              <div className="absolute inset-0 border-2 border-accent/50 rounded-xl pointer-events-none">
                <div className="absolute top-1/2 left-4 right-4 h-0.5 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-scan-line"></div>
              </div>
            )}
          </div>

          <div className="min-h-[80px]">
            {status === 'scanning' && (
              <p className="text-text-secondary text-sm">
                Point your camera at the QR code shown on the new device.
              </p>
            )}

            {status === 'processing' && (
              <div className="flex items-center justify-center gap-2 text-accent">
                <Spinner size="sm" />
                <span className="font-medium">Securely verifying...</span>
              </div>
            )}

            {status === 'success' && (
              <div className="flex flex-col items-center text-green-500 animate-bounce-in">
                <FiCheckCircle size={40} className="mb-2" />
                <span className="font-bold">Linked Successfully!</span>
              </div>
            )}

            {status === 'failed' && (
              <div className="flex flex-col items-center text-red-500">
                <FiXCircle size={40} className="mb-2" />
                <span className="font-bold">{error ? 'Error' : 'Failed'}</span>
                <span className="text-xs mt-1 text-text-secondary">{error || 'An unknown error occurred.'}</span>
                <button 
                  onClick={handleRetry}
                  className="mt-4 px-4 py-2 bg-bg-main rounded-lg shadow-neumorphic-convex active:shadow-neumorphic-pressed text-sm font-medium text-text-primary"
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}