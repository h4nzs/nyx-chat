import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiChevronLeft, FiCheckCircle, FiXCircle } from 'react-icons/fi';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@store/auth';
import { getSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { Html5Qrcode } from 'html5-qrcode';

const qrcodeRegionId = "qr-code-scanner-region";

export default function DeviceScannerPage() {
  const [status, setStatus] = useState<'scanning' | 'processing' | 'success' | 'failed'>('scanning');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const getMasterSeed = useAuthStore(s => s.getMasterSeed);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const processQrCode = useCallback(async (decodedText: string) => {
    setStatus('processing');
    toast.loading('QR Code scanned, processing...', { id: 'linking-toast' });

    try {
      const { roomId, linkingPubKey } = JSON.parse(decodedText);
      if (!roomId || !linkingPubKey) throw new Error('Invalid QR code format.');

      const masterSeed = await getMasterSeed();
      if (!masterSeed) throw new Error("Could not retrieve master key. Password prompt might have been cancelled or key is missing.");

      const sodium = await getSodium();
      const linkingPubKeyBytes = sodium.from_base64(linkingPubKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      const encryptedPayload = sodium.crypto_box_seal(masterSeed, linkingPubKeyBytes);
      const encryptedPayloadB64 = sodium.to_base64(encryptedPayload, sodium.base64_variants.URLSAFE_NO_PADDING);

      const socket = getSocket();
      console.log(`[Scanner] Emitting payload to roomId: ${roomId}`);
      socket.emit('linking:send_payload', { 
        roomId, 
        encryptedMasterKey: encryptedPayloadB64 
      });

      setStatus('success');
      toast.success('Device link initiated! Check your new device.', { id: 'linking-toast' });
      setTimeout(() => navigate('/settings/sessions'), 2000);

    } catch (err: any) {
      console.error("Linking error:", err);
      setError(err.message || 'Failed to process QR code.');
      setStatus('failed');
      toast.error(err.message || 'Failed to link device.', { id: 'linking-toast' });
    }
  }, [getMasterSeed, navigate]);

  // Expose a self-contained function to the window for manual testing
  useEffect(() => {
    (window as any).testScan = async (data: string) => {
      if (scannerRef.current?.isScanning) {
        await scannerRef.current.stop();
      }
      processQrCode(data);
    };
  }, [processQrCode]);

  useEffect(() => {  
    if (status !== 'scanning') return;

    // Prevent multiple initializations
    if (scannerRef.current) return;

    const html5QrCode = new Html5Qrcode(qrcodeRegionId);
    scannerRef.current = html5QrCode;

    const qrCodeSuccessCallback = (decodedText: string) => {
      // Stop scanning first
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().then(() => {
          processQrCode(decodedText);
        }).catch(err => {
          console.error("Failed to stop scanner after success, but proceeding anyway.", err);
          processQrCode(decodedText);
        });
      }
    };

    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      qrCodeSuccessCallback,
      (errorMessage) => { /* ignore parse errors */ }
    ).catch(err => {
      setError('Could not start QR scanner. Please grant camera permission.');
      setStatus('failed');
      toast.error('Camera permission denied.');
    });

    return () => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(err => {
          console.error("Failed to stop QR scanner on cleanup.", err);
        });
      }
    };
  }, [status, processQrCode]);

  return (
    <div className="flex flex-col h-screen bg-background text-text-primary">
      <header className="p-4 border-b border-border flex items-center gap-4 flex-shrink-0">
        <Link to="/settings" className="btn btn-secondary p-2 h-10 w-10 rounded-full justify-center">
          <FiChevronLeft size={24} />
        </Link>
        <h1 className="text-xl font-bold text-text-primary">Scan QR Code</h1>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center p-4">
        <div className="bg-bg-surface p-6 rounded-xl shadow-neumorphic-convex text-center max-w-md w-full">
          <div id={qrcodeRegionId} className="w-full h-64 bg-black rounded-lg overflow-hidden" />

          {status === 'processing' && <p className="text-text-secondary mt-4">Processing...</p>}
          {status === 'success' && (
            <div className="flex flex-col items-center justify-center mt-4 text-green-500">
              <FiCheckCircle size={48} />
              <p className="mt-2">Link Initiated!</p>
            </div>
          )}
          {status === 'failed' && (
            <div className="flex flex-col items-center justify-center mt-4 text-red-500">
              <FiXCircle size={48} />
              <p className="mt-2 font-semibold">Linking Failed</p>
              <p className="text-sm text-text-secondary mt-1">{error}</p>
              <button 
                onClick={() => { setStatus('scanning'); setError(null); }}
                className="btn btn-secondary mt-4"
              >
                Scan Again
              </button>
            </div>
          )}

          {status === 'scanning' && (
            <p className="text-sm text-text-secondary mt-4">
              Position the QR code from your new device within the frame.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
