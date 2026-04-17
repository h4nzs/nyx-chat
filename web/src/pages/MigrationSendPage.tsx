import { useEffect, useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FiUploadCloud } from 'react-icons/fi';
import { Html5Qrcode } from 'html5-qrcode';
import { getSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { worker_file_encrypt } from '@lib/crypto-worker-proxy';
import { exportDatabaseToJson } from '@lib/keychainDb';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const CHUNK_SIZE = 500 * 1024; // 500 KB per chunk

export default function MigrationSendPage() {
  const { t } = useTranslation(['common']);
  const tRef = useRef(t);
  
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const [status, setStatus] = useState<'prefetching' | 'scanning' | 'encrypting' | 'sending' | 'success'>('prefetching');
  const [progress, setProgress] = useState(0);
  const navigate = useNavigate();
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const vaultDataRef = useRef<ArrayBuffer | null>(null);

  // PRE-FETCHING LOGIC (WITH STATE FREEZING)
  useEffect(() => {
    const prefetch = async () => {
      try {
        const socket = getSocket();
        if (socket?.connected) {
            socket.disconnect();
            console.log("System Frozen: Socket disconnected to prevent Ratchet Race Condition.");
        }

        const jsonString = await exportDatabaseToJson();
        vaultDataRef.current = new TextEncoder().encode(jsonString).buffer;
        setStatus('scanning');
        
        socket.connect();
      } catch (e) {
        toast.error(tRef.current('common:migration.read_vault_failed', 'Gagal membaca brankas data.'));
      }
    };
    prefetch();

    return () => {
      if (getSocket()?.disconnected) {
        getSocket().connect();
      }
    };
  }, []);

  // SCANNER LOGIC
  useEffect(() => {
    if (status !== 'scanning') return;
    
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
            toast.error(tRef.current('common:migration.camera_denied', 'Akses kamera ditolak atau tidak ditemukan.'));
        });
    }, 100);

    return () => {
      clearTimeout(timer);
      if (scannerRef.current?.isScanning) scannerRef.current.stop();
    };
  }, [status]);

  const processMigration = async (qrText: string) => {
    setStatus('encrypting');
    toast.loading(t('common:migration.encrypting_vault', 'Mengenknripsi brankas...'), { id: 'send' });
    
    try {
      const { roomId, pubKey } = JSON.parse(qrText);
      const sodium = await getSodium();
      const receiverPubKeyBytes = sodium.from_base64(pubKey, sodium.base64_variants.URLSAFE_NO_PADDING);

      // 1. Encrypt Huge Vault using AES-GCM (Worker)
      const { combinedData, key: aesKey } = await worker_file_encrypt(vaultDataRef.current!);

      // 2. Seal the AES Key using Receiver's Public Key      const sealedKeyBytes = sodium.crypto_box_seal(aesKey, receiverPubKeyBytes);
      const sealedKey = sodium.to_base64(sealedKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

      setStatus('sending');
      toast.loading(t('common:migration.tunneling', 'Membangun terowongan aman...'), { id: 'send' });

      // 3. Chunking & Socket Emission
      const socket = getSocket();
      const totalChunks = Math.ceil(combinedData.byteLength / CHUNK_SIZE);

// Hapus iv dari socket.emit
      socket.emit('migration:start', { roomId, totalChunks, sealedKey });

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, combinedData.byteLength);
        const chunk = combinedData.slice(start, end);
        
        socket.emit('migration:chunk', { roomId, chunkIndex: i, chunk });
        setProgress(Math.round(((i + 1) / totalChunks) * 100));
        
        await new Promise(r => setTimeout(r, 50));
      }

      toast.loading(t('common:migration.waiting_receiver', 'Menunggu penerima...'), { id: 'send' });

      // Wait for ACK
      const ackResult = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000); // 30s timeout
        socket.once('migration:ack', (data: { roomId: string, success: boolean }) => {
           if (data.roomId === roomId) {
               clearTimeout(timeout);
               resolve(data.success);
           }
        });
      });

      if (ackResult) {
        setStatus('success');
        toast.success(t('common:migration.transfer_complete', 'Transfer selesai!'), { id: 'send' });
        setTimeout(() => navigate('/settings'), 2000);
      } else {
        throw new Error(t('common:migration.receiver_failed', 'Penerima gagal mendekripsi atau kehabisan waktu'));
      }

    } catch (e) {
      console.error(e);
      toast.error(t('common:migration.failed_generic', 'Proses migrasi gagal.'), { id: 'send' });
      setStatus('scanning');
    }
  };

  return (
    <div className="min-h-screen bg-bg-main text-text-primary flex flex-col items-center justify-center p-4">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-black uppercase tracking-widest text-text-primary">{t('common:migration.send_title', 'Kirim Data')}</h1>
        <p className="text-xs text-text-secondary mt-2">{t('common:migration.send_desc', 'Pindai QR code di perangkat baru')}</p>
      </div>

      <div className="w-full max-w-sm aspect-square bg-black/90 rounded-3xl overflow-hidden shadow-neumorphic-pressed relative mb-8">
        {status === 'prefetching' && (
           <div className="absolute inset-0 flex flex-col items-center justify-center text-accent">
              <FiUploadCloud size={40} className="animate-pulse mb-2" />
              <span className="font-mono text-xs uppercase">{t('common:migration.preparing', 'Menyiapkan Data...')}</span>
           </div>
        )}
        
        <div id="migration-reader" className="w-full h-full opacity-80" />
        
        {(status === 'encrypting' || status === 'sending') && (
           <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center text-accent z-10">
              <FiUploadCloud size={40} className="animate-bounce mb-2" />
              <span className="font-bold font-mono text-xl">{progress}%</span>
              <span className="font-mono text-[10px] uppercase mt-2">{t('common:migration.status_tunneling', 'Mengirim Data...')}</span>
           </div>
        )}
      </div>

      <Link to="/settings" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest">
        {t('common:actions.cancel_bracket', '[ BATAL ]')}
      </Link>
    </div>
  );
}
