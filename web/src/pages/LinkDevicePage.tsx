import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiRefreshCw, FiCheckCircle, FiXCircle, FiChevronLeft } from 'react-icons/fi';
import { Spinner } from '@components/Spinner';
import { getSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { v4 as uuidv4 } from 'uuid';
import { useAuthStore } from '@store/auth';
import toast from 'react-hot-toast';
import { worker_crypto_box_seal_open, reEncryptBundleFromMasterKey } from '@lib/crypto-worker-proxy';
import { Html5Qrcode } from 'html5-qrcode';

const qrcodeRegionId = "qr-code-scanner-region";

export default function LinkDevicePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'generating' | 'waiting' | 'processing' | 'success' | 'failed' | 'scanning' | 'linked'>('generating');
  const [error, setError] = useState<string | null>(null);
    const navigate = useNavigate();
    const getMasterSeed = useAuthStore(s => s.getMasterSeed);
    const scannerRef = useRef<Html5Qrcode | null>(null);
    const processingRef = useRef(false);
  
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
        if (processingRef.current) return;
        processingRef.current = true;
        // Stop scanning first
        if (scannerRef.current?.isScanning) {
          scannerRef.current.stop().then(() => {
            processQrCode(decodedText);
          }).catch((err: any) => {
            console.error("Failed to stop scanner after success, but proceeding anyway.", err);
            processQrCode(decodedText);
          });
        } else {
          processQrCode(decodedText);
        }
      };
  
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        qrCodeSuccessCallback,
        (errorMessage: string) => { /* ignore parse errors */ }
      ).catch((err: any) => {
        setError('Could not start QR scanner. Please grant camera permission.');
        setStatus('failed');
        toast.error('Camera permission denied.');
      });
  
      return () => {
        if (scannerRef.current?.isScanning) {
          scannerRef.current.stop().catch((err: any) => {
            console.error("Failed to stop QR scanner on cleanup.", err);
          });
        }
      };
    }, [status, processQrCode]);
  
    const renderStatusMessage = () => {
      const messageClasses = "flex items-center gap-2";
      switch (status) {
        case 'generating':
          return <div className={`${messageClasses} text-text-secondary`}><Spinner size="sm" /> Generating QR Code...</div>;
        case 'waiting':
          return <div className={`${messageClasses} text-text-secondary`}><FiRefreshCw className="animate-spin" /> Waiting for scan...</div>;
        case 'linked':
        case 'success':
          return <div className={`${messageClasses} text-green-500`}><FiCheckCircle /> Device Linked! Redirecting...</div>;
        case 'failed':
          return <div className={`${messageClasses} text-red-500`}><FiXCircle /> Linking Failed: {error}</div>;
        case 'processing':
            return <div className={`${messageClasses} text-text-secondary`}><Spinner size="sm" /> Processing...</div>;
        default:
          return null;
      }
    };
  
    return (
      <div className="relative flex flex-col items-center justify-center h-screen bg-bg-main text-text-primary p-4">
        <Link to="/login" aria-label="Go back to login" className="btn btn-secondary p-2 h-10 w-10 rounded-full justify-center absolute top-4 left-4">
          <FiChevronLeft size={24} />
        </Link>
        <div className="bg-bg-surface p-8 rounded-xl shadow-neumorphic-convex text-center max-w-md w-full">
          <h1 className="text-2xl font-bold mb-4">Link a New Device</h1>
          <p className="text-text-secondary mb-6">
            Scan this QR code with an already logged-in device to securely link this new device.
          </p>
  
          {qrData && status !== 'generating' ? (
            <div className="bg-white p-2 rounded-lg inline-block mb-6">
              <QRCode value={qrData} size={256} level="H" />
            </div>
          ) : (
            <div className="w-64 h-64 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded-lg mb-6">
              <Spinner size="lg" />
            </div>
          )}
  
          <div className="mb-6 h-6">
            {renderStatusMessage()}
          </div>
  
          {status !== 'generating' && status !== 'linked' && status !== 'success' && (
            <Link to="/login" className="text-text-secondary hover:text-text-primary mt-4 block">
              Cancel and Login Manually
            </Link>
          )}
        </div>
      </div>
    );
  }