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
import { openSealedForDevice } from '@lib/pqBoxSeal';
import { libsodiumBackupCrypto } from '@lib/backupFormat';
import { libsodiumBackupValueCodec } from '@lib/backupPayload';
import { restoreFramedBackup, liveBackupStore, formatBackupSize } from '@lib/backupRestore';
const uuidv4 = () => crypto.randomUUID();
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
  
  const keysRef = useRef<{ pqPublicKey: Uint8Array, pqPrivateKey: Uint8Array } | null>(null);
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
      
      // [PQ-only 2026-10-23] QR migrasi hanya membawa kunci X-Wing. Pasangan
      // `crypto_box` v1 tidak dibuat lagi; kunci klasik tidak dipakai di mana pun.
      const pqKeypair = sodium.crypto_kem_xwing_keypair();
      keysRef.current = { pqPublicKey: pqKeypair.publicKey, pqPrivateKey: pqKeypair.privateKey };
      
      const roomId = `mig_${uuidv4()}`;
      const pqPubKeyB64 = sodium.to_base64(pqKeypair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      if (!transportClient.connected) connectSocket();
      
      transportClient.sendEvent('migration:join', roomId);
      setQrData(JSON.stringify({ roomId, pqPubKey: pqPubKeyB64 }));

      // Listeners
      transportClient.on('migration:start', (payload) => {
        const data = payload as { roomId: string; totalChunks: number; sealedKey: string; };
        metaRef.current = data;
        chunksRef.current = Array.from({ length: data.totalChunks }, () => '');
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
          toast.loading(tRef.current('common:migration.restoring_data', 'Memulihkan basis data...'), { id: 'mig' });
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
      
      // 1. Buka kunci arsip 32 byte memakai private key perangkat ini.
      // [docs/35 Fase 1.5] v2 (X-Wing murni) dideteksi dari magic envelope; QR
      // v1 lama (tanpa pqPubKey) tetap dibuka lewat jalur X25519.
      const key = await openSealedForDevice(sealedKeyBytes, keysRef.current!.pqPrivateKey);
      
      // 2. Rakit ulang chunk base64 menjadi arsip ber-frame utuh.
      const chunksDecoded = chunksRef.current.map(c => sodium.from_base64(c, sodium.base64_variants.URLSAFE_NO_PADDING));
      const totalLength = chunksDecoded.reduce((acc, val) => acc + val.byteLength, 0);
      const archiveBytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunksDecoded) {
        archiveBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      // 3. Verifikasi + dekripsi + tulis per frame (AAD menolak tamper/terpotong).
      const crypto = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
      const codec = libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);
      const store = await liveBackupStore();

      const report = await restoreFramedBackup({
        store,
        bytes: archiveBytes,
        key,
        crypto,
        codec,
        onProgress: (done, total) => setProgress(Math.round((done / total) * 100)),
      });
      
      // ✅ OPSI A: FORCE NEW IDENTITY FOR NEW DEVICE
      // After importing the vault (which contains the old deviceId),
      // we MUST clear it so that on the next reload, the app detects
      // it has no local identity keys and performs a NEW DEVICE BOOTSTRAP.
      localStorage.removeItem('deviceId');
      
      transportClient.sendEvent('migration:ack', { roomId: metaRef.current!.roomId, success: true });

      setStatus('success');
      toast.success(
        tRef.current('common:migration.restore_summary', 'Dipulihkan {{records}} catatan · {{size}}', {
          records: report.records,
          size: formatBackupSize(report.size),
        }),
        { id: 'mig', duration: 4000 }
      );
      toast.success(tRef.current('common:migration.complete', 'Migrasi Selesai!'), { id: 'mig-done' });
      
      // Hard reload to apply the imported state and trigger key regeneration
      setTimeout(() => window.location.href = '/', 2500); 
    } catch (e) {
      console.error(e);
      toast.error(tRef.current('common:migration.restore_failed', 'Restore gagal: data mungkin rusak atau kunci salah.'), { id: 'mig' });
      
      if (metaRef.current?.roomId) {
         transportClient.sendEvent('migration:ack', { roomId: metaRef.current.roomId, success: false });
      }

      setStatus('waiting');
      setProgress(0);
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
          <div className="w-[250px] h-[250px] bg-bg-surface animate-pulse rounded-xl"></div>
        )}
        
        {(status === 'receiving' || status === 'decrypting') && (
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
