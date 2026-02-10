import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiChevronLeft, FiCheckCircle, FiXCircle, FiCamera, FiRefreshCw } from 'react-icons/fi';
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
        throw new Error("Invalid QR Code. Not a recognized Nyx code.");
      }

      const { roomId, linkingPubKey } = data;

      if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
        throw new Error('Missing or invalid roomId in QR code data.');
      }

      if (!linkingPubKey || typeof linkingPubKey !== 'string' || !linkingPubKey.trim()) {
        throw new Error('Missing or invalid linkingPubKey in QR code data.');
      }

      const sodium = await getSodium();

      let linkingPubKeyBytes;
      try {
        linkingPubKeyBytes = sodium.from_base64(linkingPubKey, sodium.base64_variants.URLSAFE_NO_PADDING);
        if (!linkingPubKeyBytes || linkingPubKeyBytes.length === 0) {
          throw new Error('Invalid linkingPubKey format in QR code data.');
        }
      } catch (e) {
        throw new Error("Invalid linkingPubKey format. Failed to decode Base64.");
      }

      const masterSeed = await getMasterSeed();
      if (!masterSeed) {
        throw new Error("Your keys are locked. Please log in again to unlock them.");
      }

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
    if (!qrcodeRegionRef.current) return;
    
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
      <header className="p-4 flex items-center justify-between border-b border-white/10 dark:border-black/10 shadow-neu-flat-light dark:shadow-neu-flat-dark z-10">
        <Link 
          to="/settings" 
          className="
            p-3 rounded-xl bg-bg-main text-text-secondary
            shadow-neu-flat-light dark:shadow-neu-flat-dark
            active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
            transition-all
          "
        >
          <FiChevronLeft size={20} />
        </Link>
        <h1 className="text-sm font-black uppercase tracking-widest text-text-primary">Optical Scanner</h1>
        <div className="w-10"></div> {/* Spacer for balance */}
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        {/* Scanner Housing */}
        <div className="
          relative w-full max-w-sm aspect-square 
          bg-black/90 rounded-3xl overflow-hidden
          shadow-neu-pressed-light dark:shadow-neu-pressed-dark
          border-4 border-bg-main
        ">
          {/* Camera Feed */}
          <div id="qr-code-scanner-region" ref={qrcodeRegionRef} className="w-full h-full opacity-80" />

          {/* HUD Overlay */}
          <div className="absolute inset-0 pointer-events-none p-6">
             <div className="w-full h-full border-2 border-accent/30 rounded-2xl relative">
                {/* Corners */}
                <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-accent"></div>
                <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-accent"></div>
                <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-accent"></div>
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-accent"></div>
                
                {/* Scan Line */}
                {status === 'scanning' && (
                   <div className="w-full h-0.5 bg-red-500 absolute top-1/2 shadow-[0_0_10px_red] animate-scan-line"></div>
                )}
             </div>
          </div>
        </div>

        {/* Status Deck */}
        <div className="mt-8 w-full max-w-sm">
           <div className="
             p-4 rounded-2xl bg-bg-main
             shadow-neu-flat-light dark:shadow-neu-flat-dark
             flex flex-col items-center text-center
           ">
              {status === 'scanning' && (
                <>
                  <div className="flex items-center gap-2 text-accent mb-2">
                     <FiCamera className="animate-pulse" />
                     <span className="font-mono text-xs uppercase tracking-wider">Acquiring Target</span>
                  </div>
                  <p className="text-xs text-text-secondary">Align QR Code within the viewfinder.</p>
                </>
              )}

              {status === 'processing' && (
                <div className="flex flex-col items-center gap-3">
                   <Spinner size="md" />
                   <span className="font-mono text-xs uppercase tracking-wider text-text-primary">Decrypting Handshake...</span>
                </div>
              )}

              {status === 'success' && (
                <div className="flex flex-col items-center gap-2 text-green-500">
                   <FiCheckCircle size={32} className="animate-bounce-in" />
                   <span className="font-bold uppercase tracking-wide">Uplink Established</span>
                </div>
              )}

              {status === 'failed' && (
                <div className="flex flex-col items-center gap-3">
                   <div className="flex items-center gap-2 text-red-500">
                      <FiXCircle size={24} />
                      <span className="font-bold uppercase">{error || 'Connection Failed'}</span>
                   </div>
                   <button 
                     onClick={handleRetry}
                     className="
                       flex items-center gap-2 px-4 py-2 rounded-lg 
                       bg-bg-main text-text-primary text-xs font-bold uppercase
                       shadow-neu-flat-light dark:shadow-neu-flat-dark
                       active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                     "
                   >
                      <FiRefreshCw /> Retry
                   </button>
                </div>
              )}
           </div>
        </div>
      </main>
    </div>
  );
}