import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiChevronLeft, FiCheckCircle, FiXCircle, FiCamera } from 'react-icons/fi';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@store/auth';
import { getSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { Html5Qrcode } from 'html5-qrcode';
import { Spinner } from '@components/Spinner';

const qrcodeRegionId = "qr-code-scanner-region";

export default function DeviceScannerPage() {
  const [status, setStatus] = useState<'scanning' | 'processing' | 'success' | 'failed'>('scanning');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  
  // Ambil fungsi untuk mendapatkan Master Key yang sedang aktif (unlocked)
  const getMasterSeed = useAuthStore(s => s.getMasterSeed);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isProcessingRef = useRef(false);

  const processQrCode = useCallback(async (decodedText: string) => {
    // Mencegah double process
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    setStatus('processing');
    toast.loading('QR Code detected. Synchronizing...', { id: 'linking-toast' });

    try {
      // 1. Parse QR Data
      let data;
      try {
        data = JSON.parse(decodedText);
      } catch (e) {
        throw new Error("Invalid QR Code format. Not a Chat Lite code.");
      }

      const { roomId, linkingPubKey } = data;
      if (!roomId || !linkingPubKey) throw new Error('Invalid QR code data.');

      // 2. Ambil Master Key User (Harus sudah unlock/login)
      const masterSeed = await getMasterSeed();
      if (!masterSeed) {
        throw new Error("Cannot retrieve your encryption keys. Please login again to unlock them.");
      }

      const sodium = await getSodium();
      
      // 3. Enkripsi Master Key menggunakan Public Key Device Baru
      // Kita pakai Sealed Box (Anonymous Encryption) karena device baru belum tau siapa kita
      const linkingPubKeyBytes = sodium.from_base64(linkingPubKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const encryptedPayload = sodium.crypto_box_seal(masterSeed, linkingPubKeyBytes);
      const encryptedPayloadB64 = sodium.to_base64(encryptedPayload, sodium.base64_variants.URLSAFE_NO_PADDING);

      // 4. Kirim ke Server via Socket
      const socket = getSocket();
      
      // Emit event 'linking:send_payload'
      // Server akan menerima ini, membuat AccessToken baru untuk device baru,
      // lalu mem-forward (encryptedMasterKey + AccessToken + UserData) ke RoomID
      socket.emit('linking:send_payload', { 
        roomId, 
        encryptedMasterKey: encryptedPayloadB64 
      });

      setStatus('success');
      toast.success('Device successfully linked!', { id: 'linking-toast' });
      
      // Hentikan scanner dan redirect
      if (scannerRef.current?.isScanning) {
        await scannerRef.current.stop();
      }
      
      setTimeout(() => navigate('/settings/sessions'), 2000);

    } catch (err: any) {
      console.error("Linking error:", err);
      setError(err.message || 'Failed to process linking.');
      setStatus('failed');
      toast.error(err.message || 'Linking failed.', { id: 'linking-toast' });
      isProcessingRef.current = false; // Allow retry
    }
  }, [getMasterSeed, navigate]);

  useEffect(() => {
    // Inisialisasi Scanner
    if (status !== 'scanning') return;
    if (scannerRef.current) return; // Prevent double init

    const html5QrCode = new Html5Qrcode(qrcodeRegionId);
    scannerRef.current = html5QrCode;

    const qrCodeSuccessCallback = (decodedText: string) => {
      // Pause scanner saat sukses baca
      html5QrCode.pause(true);
      processQrCode(decodedText);
    };

    html5QrCode.start(
      { facingMode: "environment" },
      { 
        fps: 10, 
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0 
      },
      qrCodeSuccessCallback,
      (errorMessage) => { 
        // Ignore parse errors on every frame
      }
    ).catch((err) => {
      console.error("Camera start error:", err);
      setError('Could not access camera. Please allow permission.');
      setStatus('failed');
    });

    // Cleanup saat unmount
    return () => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(console.error);
        scannerRef.current.clear();
      }
    };
  }, [status, processQrCode]);

  return (
    <div className="flex flex-col h-screen bg-bg-main text-text-primary">
      <header className="p-4 flex items-center border-b border-border bg-bg-surface">
        <Link to="/settings/link-device" className="p-2 -ml-2 rounded-full hover:bg-bg-main transition-colors">
          <FiChevronLeft size={24} />
        </Link>
        <h1 className="ml-2 text-xl font-bold">Scan QR Code</h1>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4">
        <div className="bg-bg-surface p-6 rounded-2xl shadow-neumorphic-concave text-center max-w-md w-full">
          
          {/* Area Kamera */}
          <div className="relative w-full aspect-square bg-black rounded-xl overflow-hidden shadow-inner mb-4">
            <div id={qrcodeRegionId} className="w-full h-full" />
            
            {/* Overlay Garis Scan */}
            {status === 'scanning' && (
              <div className="absolute inset-0 border-2 border-accent/50 rounded-xl pointer-events-none">
                <div className="absolute top-1/2 left-4 right-4 h-0.5 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-scan-line"></div>
              </div>
            )}
          </div>

          {/* Status Messages */}
          <div className="min-h-[60px]">
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
                <span className="font-bold">Failed</span>
                <span className="text-xs mt-1">{error}</span>
                <button 
                  onClick={() => {
                    setStatus('scanning');
                    isProcessingRef.current = false;
                    scannerRef.current?.resume();
                  }}
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