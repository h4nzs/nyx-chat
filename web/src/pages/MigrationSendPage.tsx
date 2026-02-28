import { useEffect, useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FiChevronLeft, FiCamera, FiUploadCloud } from 'react-icons/fi';
import { Html5Qrcode } from 'html5-qrcode';
import { getSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { worker_file_encrypt } from '@lib/crypto-worker-proxy';
import { exportDatabaseToJson } from '@lib/keychainDb';
import toast from 'react-hot-toast';

const CHUNK_SIZE = 500 * 1024; // 500 KB per chunk

export default function MigrationSendPage() {
  const [status, setStatus] = useState<'prefetching' | 'scanning' | 'encrypting' | 'sending' | 'success'>('prefetching');
  const [progress, setProgress] = useState(0);
  const navigate = useNavigate();
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const vaultDataRef = useRef<ArrayBuffer | null>(null);

  // PRE-FETCHING LOGIC
  useEffect(() => {
    const prefetch = async () => {
      try {
        const jsonString = await exportDatabaseToJson();
        vaultDataRef.current = new TextEncoder().encode(jsonString).buffer;
        setStatus('scanning');
      } catch (e) {
        toast.error("Failed to read local vault.");
      }
    };
    prefetch();
  }, []);

  // SCANNER LOGIC
  useEffect(() => {
    if (status !== 'scanning') return;
    
    // Html5Qrcode needs an element with id to attach to.
    // We start it after a short delay to ensure DOM is ready
    const timer = setTimeout(() => {
        scannerRef.current = new Html5Qrcode('migration-reader');
        scannerRef.current.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (decodedText) => {
            if (scannerRef.current) {
              await scannerRef.current.stop();
            }
            processMigration(decodedText);
          },
          () => {}
        ).catch(err => {
            console.error("Camera start failed", err);
            toast.error("Camera access denied or unavailable.");
        });
    }, 100);

    return () => {
      clearTimeout(timer);
      if (scannerRef.current?.isScanning) scannerRef.current.stop();
    };
  }, [status]);

  const processMigration = async (qrText: string) => {
    setStatus('encrypting');
    toast.loading('Encrypting vault data...', { id: 'send' });
    
    try {
      const { roomId, pubKey } = JSON.parse(qrText);
      const sodium = await getSodium();
      const receiverPubKeyBytes = sodium.from_base64(pubKey, sodium.base64_variants.URLSAFE_NO_PADDING);

      // 1. Encrypt Huge Vault using AES-GCM (Worker)
      const { encryptedData, iv, key: aesKey } = await worker_file_encrypt(vaultDataRef.current!);
      
      // 2. Seal the AES Key using Receiver's Public Key
      const sealedKeyBytes = sodium.crypto_box_seal(aesKey, receiverPubKeyBytes);
      const sealedKey = sodium.to_base64(sealedKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
      const ivB64 = sodium.to_base64(iv, sodium.base64_variants.URLSAFE_NO_PADDING);

      setStatus('sending');
      toast.loading('Tunneling data to new device...', { id: 'send' });

      // 3. Chunking & Socket Emission
      const socket = getSocket();
      const totalChunks = Math.ceil(encryptedData.byteLength / CHUNK_SIZE);
      
      socket.emit('migration:start', { roomId, totalChunks, sealedKey, iv: ivB64 });

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, encryptedData.byteLength);
        const chunk = encryptedData.slice(start, end);
        
        socket.emit('migration:chunk', { roomId, chunkIndex: i, chunk });
        setProgress(Math.round(((i + 1) / totalChunks) * 100));
        
        // Small delay to prevent socket buffer overflow
        await new Promise(r => setTimeout(r, 50));
      }

      setStatus('success');
      toast.success('Transfer Complete!', { id: 'send' });
      setTimeout(() => navigate('/settings'), 2000);

    } catch (e) {
      console.error(e);
      toast.error('Migration failed. Invalid QR or Network error.', { id: 'send' });
      setStatus('scanning');
    }
  };

  return (
    <div className="min-h-screen bg-bg-main text-text-primary flex flex-col items-center justify-center p-4">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-black uppercase tracking-widest text-text-primary">Transfer Vault</h1>
        <p className="text-xs text-text-secondary mt-2">Send data to your new device</p>
      </div>

      <div className="w-full max-w-sm aspect-square bg-black/90 rounded-3xl overflow-hidden shadow-neumorphic-pressed relative mb-8">
        {status === 'prefetching' && (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-accent">
              <FiUploadCloud size={40} className="animate-pulse mb-2" />
              <span className="font-mono text-xs uppercase">Preparing Vault...</span>
           </div>
        )}
        
        <div id="migration-reader" className="w-full h-full opacity-80" />
        
        {(status === 'encrypting' || status === 'sending') && (
           <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center text-accent z-10">
              <FiUploadCloud size={40} className="animate-bounce mb-2" />
              <span className="font-bold font-mono text-xl">{progress}%</span>
              <span className="font-mono text-[10px] uppercase mt-2">Tunneling...</span>
           </div>
        )}
      </div>

      <Link to="/settings" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest">
        [ CANCEL ]
      </Link>
    </div>
  );
}
