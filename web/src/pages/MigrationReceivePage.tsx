import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '@store/auth';
// Obati isu impor Vite (CommonJS ke ESM)
import QRCodeRaw from 'react-qr-code';
const QRCode = (
  (QRCodeRaw as unknown as { default?: { default?: typeof QRCodeRaw } }).default?.default ||
  (QRCodeRaw as unknown as { default?: typeof QRCodeRaw }).default ||
  QRCodeRaw
) as typeof QRCodeRaw;

import { FiDownloadCloud, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi';
import { transportClient, connectSocket } from '@lib/transportClient';
import { getSodium } from '@lib/sodiumInitializer';
import { worker_file_decrypt } from '@lib/crypto-worker-proxy';
import { importDatabaseFromJson } from '@lib/keychainDb';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function MigrationReceivePage() {
  const { t } = useTranslation(['common', 'auth']);
  const tRef = useRef(t);
  tRef.current = t;
  const { user, accessToken } = useAuthStore();
  const [qrData, setQrData] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [status, setStatus] = useState<'waiting' | 'receiving' | 'decrypting' | 'success'>('waiting');
  const navigate = useNavigate();
  
  const keysRef = useRef<{ publicKey: Uint8Array, privateKey: Uint8Array } | null>(null);
  const chunksRef = useRef<string[]>([]);
  const metaRef = useRef<{ roomId: string, totalChunks: number, sealedKey: string } | null>(null);
  const migrationStartedRef = useRef(false);

  // SECURE GUARD: Only authenticated users can receive migration data
  useEffect(() => {
    if (!accessToken || !user) {
        navigate('/login');
    }
  }, [accessToken, user, navigate]);

  useEffect(() => {
    if (!accessToken) return;
    let isMounted = true;
    
    const init = async () => {
      const sodium = await getSodium();
      if (!isMounted) return;
      
      const keypair = sodium.crypto_box_keypair();
      keysRef.current = keypair;
      
      const roomId = `mig_${uuidv4()}`;
      const pubKeyB64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      if (!transportClient.connected) connectSocket();
      
      transportClient.sendEvent('migration:join', roomId);
      setQrData(JSON.stringify({ roomId, pubKey: pubKeyB64 }));

      // Listeners
      transportClient.on('migration:start', (payload) => {
        const data = payload as { roomId: string; totalChunks: number; sealedKey: string; };
        metaRef.current = data;
        chunksRef.current = new Array(data.totalChunks);
        migrationStartedRef.current = false;
        setStatus('receiving');
        toast.loading(tRef.current('common:migration.receiving_data', 'Menerima data...'), { id: 'mig' });
      });

      transportClient.on('migration:chunk', async (payload) => {
        const data = payload as { chunkIndex: number; chunk: string; };
        chunksRef.current[data.chunkIndex] = data.chunk;
        const receivedCount = chunksRef.current.filter(Boolean).length;
        const total = metaRef.current?.totalChunks || 1;
        setProgress(Math.round((receivedCount / total) * 100));

        if (receivedCount === total && !migrationStartedRef.current) {
          migrationStartedRef.current = true;
          setStatus('decrypting');
          toast.loading(tRef.current('common:migration.decrypting_vault', 'Mendekripsi brankas...'), { id: 'mig' });
          await processMigration(sodium);
        }
      });
    };
    init();
    
    return () => {
      isMounted = false;
      transportClient.off('migration:start');
      transportClient.off('migration:chunk');
    };
  }, [accessToken]);

  const processMigration = async (sodium: typeof import('libsodium-wrappers')) => {
    try {
      const { sealedKey } = metaRef.current!;
      const sealedKeyBytes = sodium.from_base64(sealedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      // 1. Decrypt the AES Key using our Private Key
      const aesKey = sodium.crypto_box_seal_open(sealedKeyBytes, keysRef.current!.publicKey, keysRef.current!.privateKey);
      
      // 2. Reassemble chunks
      const chunksDecoded = chunksRef.current.map(c => sodium.from_base64(c, sodium.base64_variants.URLSAFE_NO_PADDING));
      const totalLength = chunksDecoded.reduce((acc, val) => acc + val.byteLength, 0);
      const combinedCiphertext = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunksDecoded) {
        combinedCiphertext.set(chunk, offset);
        offset += chunk.byteLength;
      }

      // 3. Prepare payload for worker (IV + Ciphertext)
      const workerPayload = new Uint8Array(combinedCiphertext.length);
      workerPayload.set(combinedCiphertext);

      // 4. Decrypt via Worker
      const decryptedBuffer = await worker_file_decrypt(workerPayload.buffer, aesKey);
      const jsonString = new TextDecoder().decode(decryptedBuffer);

      // 5. Import to IDB
      await importDatabaseFromJson(jsonString);
      
      // ✅ OPSI A: FORCE NEW IDENTITY FOR NEW DEVICE
      // After importing the vault (which contains the old deviceId and keys),
      // we MUST clear them so that on the next reload, the app detects
      // it has no local identity keys and performs a NEW DEVICE BOOTSTRAP.
      localStorage.removeItem('deviceId');
      
      transportClient.sendEvent('migration:ack', { roomId: metaRef.current!.roomId, success: true });

      setStatus('success');
      toast.success(tRef.current('common:migration.complete', 'Migrasi Selesai!'), { id: 'mig' });
      
      // Hard reload to apply the imported state and trigger key regeneration
      setTimeout(() => window.location.href = '/', 2500); 
    } catch (e) {
      console.error(e);
      toast.error(tRef.current('common:migration.decryption_failed', 'Gagal mendekripsi data.'), { id: 'mig' });
      
      if (metaRef.current?.roomId) {
         transportClient.sendEvent('migration:ack', { roomId: metaRef.current.roomId, success: false });
      }

      setStatus('waiting');
      migrationStartedRef.current = false;
    }
  };

  if (!accessToken) return null;

  return (
    <div className="min-h-screen bg-bg-main text-text-primary flex flex-col items-center justify-center p-4">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-black uppercase tracking-widest text-text-primary">{t('common:migration.receive_title', 'Terima Data')}</h1>
        <p className="text-xs text-text-secondary mt-2">{t('common:migration.receive_desc', 'Pindai QR ini dari perangkat lama Anda')}</p>
      </div>

      <div className="bg-white p-4 rounded-2xl shadow-neumorphic-convex border-4 border-bg-main mb-8 relative text-center">
        {status === 'success' ? (
          <div className="w-[250px] h-[250px] flex flex-col items-center justify-center text-green-500 p-4">
            <FiCheckCircle size={60} className="animate-bounce-in mb-4" />
            <p className="text-xs font-bold uppercase text-bg-main">{t('common:migration.syncing_hardware', 'Menyelaraskan Hardware...')}</p>
          </div>
        ) : qrData ? (
          <QRCode value={qrData} size={250} level="M" />
        ) : (
          <div className="w-[250px] h-[250px] bg-gray-200 animate-pulse rounded-xl"></div>
        )}
        
        {status === 'receiving' && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center rounded-xl text-accent backdrop-blur-sm">
             <FiDownloadCloud size={40} className="mb-2 animate-bounce" />
             <span className="font-bold font-mono">{progress}%</span>
          </div>
        )}
      </div>

      <div className="max-w-xs text-center mb-8">
          <div className="flex items-center justify-center gap-2 text-amber-500 mb-2">
              <FiAlertTriangle size={16} />
              <span className="text-[10px] font-bold uppercase tracking-widest">{t('common:migration.important_note', 'Penting')}</span>
          </div>
          <p className="text-[10px] text-text-secondary leading-relaxed uppercase opacity-60">
              {t('common:migration.identity_regen_notice', 'Setelah transfer selesai, perangkat ini akan menghasilkan identitas unik baru untuk menjamin keamanan maksimal.')}
          </p>
      </div>

      <Link to="/settings" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest">
        {t('common:actions.cancel_bracket', '[ BATAL ]')}
      </Link>
    </div>
  );
}
