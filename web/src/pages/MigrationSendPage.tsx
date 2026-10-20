import { useEffect, useState, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FiUploadCloud } from 'react-icons/fi';
import { Html5Qrcode } from 'html5-qrcode';
import { transportClient, connectSocket } from '@lib/transportClient';
import { getSodium } from '@lib/sodiumInitializer';
import { sealForDevice } from '@lib/pqBoxSeal';
import { libsodiumBackupCrypto } from '@lib/backupFormat';
import { libsodiumBackupValueCodec } from '@lib/backupPayload';
import { createFramedBackup, formatBackupSize, liveBackupStore } from '@lib/backupRestore';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const CHUNK_SIZE = 500 * 1024; // 500 KB per chunk

interface PreparedArchive {
  bytes: Uint8Array;
  /** Kunci arsip 32 byte — di-seal ke kunci publik penerima (QR), bukan dikirim polos. */
  key: Uint8Array;
  frameCount: number;
  size: number;
  records: number;
}

export default function MigrationSendPage() {
  const { t } = useTranslation(['common']);
  const tRef = useRef(t);
  
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const [status, setStatus] = useState<'prefetching' | 'scanning' | 'encrypting' | 'sending' | 'success'>('prefetching');
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const navigate = useNavigate();
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const archiveRef = useRef<PreparedArchive | null>(null);

  // PRE-FETCHING LOGIC (WITH STATE FREEZING)
  useEffect(() => {
    const prefetch = async () => {
      try {
        const socket = transportClient;
        if (socket?.connected) {
            transportClient.disconnect();
            console.log("System Frozen: Socket disconnected to prevent Ratchet Race Condition.");
        }

        // [docs/31 §31.6c] Arsip ber-frame `.nyxbak`: kunci acak disegel ke
        // penerima lewat QR. Bentuk byte identik dengan berkas manual, tapi
        // TIDAK butuh recovery phrase di perangkat lama.
        const sodium = await getSodium();
        const crypto = libsodiumBackupCrypto(sodium as unknown as Parameters<typeof libsodiumBackupCrypto>[0]);
        const codec = libsodiumBackupValueCodec(sodium as unknown as Parameters<typeof libsodiumBackupValueCodec>[0]);
        const key = sodium.randombytes_buf(32);
        const store = await liveBackupStore();

        const report = await createFramedBackup({ store, key, crypto, codec });
        archiveRef.current = {
          bytes: report.bytes,
          key,
          frameCount: report.frameCount,
          size: report.size,
          records: report.records,
        };
        setSummary(
          tRef.current('common:migration.archive_summary', '{{frames}} frame · {{size}}', {
            frames: report.frameCount,
            size: formatBackupSize(report.size),
          })
        );
        setStatus('scanning');
        
        connectSocket();

        // [NEW] Signal Migration Mode to server to prevent L1/L2 kicks during transfer
        // We call it immediately; transportClient will queue it if not yet connected
        transportClient.sendEvent('migration:prepare', {});
      } catch (e) {
        console.error(e);
        toast.error(tRef.current('common:migration.read_vault_failed', 'Gagal membaca brankas data.'));
      }
    };
    prefetch();

    return () => {
      // [NEW] Disable Migration Mode on exit to restore full security
      if (transportClient.connected) {
         transportClient.sendEvent('migration:cancel', {});
      }

      if (!transportClient?.connected) {
        connectSocket();
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
    toast.loading(t('common:migration.tunneling', 'Menyalurkan data ke perangkat baru...'), { id: 'send' });
    
    try {
      const prepared = archiveRef.current;
      if (!prepared) throw new Error(t('common:migration.read_vault_failed', 'Gagal membaca brankas data.'));

      const { roomId, pubKey, pqPubKey } = JSON.parse(qrText) as { roomId: string; pubKey: string; pqPubKey?: string };
      const sodium = await getSodium();
      const receiverPubKeyBytes = sodium.from_base64(pubKey, sodium.base64_variants.URLSAFE_NO_PADDING);

      // 1. Seal the backup key using Receiver's Public Key (arsip tetap ber-frame).
      // [docs/35 Fase 1.5] Bila QR penerima memuat kunci PQ, pakai choke point
      // v1/v2 (v2 = X-Wing murni saat VITE_PQ_V2 aktif); QR v1 lama jatuh ke
      // jalur X25519 klasik.
      const sealedKeyBytes = pqPubKey
        ? await sealForDevice(
            prepared.key,
            sodium.from_base64(pqPubKey, sodium.base64_variants.URLSAFE_NO_PADDING),
            receiverPubKeyBytes
          )
        : sodium.crypto_box_seal(prepared.key, receiverPubKeyBytes);
      const sealedKey = sodium.to_base64(sealedKeyBytes, sodium.base64_variants.URLSAFE_NO_PADDING);

      setStatus('sending');

      // 2. Chunking & Socket Emission — chunk dikirim sebagai base64 (bukan
      // ArrayBuffer) karena transport men-serialize payload dengan JSON.
      const bytes = prepared.bytes;
      const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE);

      transportClient.sendEvent('migration:start', { roomId, totalChunks, sealedKey });

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);
        const chunk = bytes.subarray(start, end);
        const chunkB64 = sodium.to_base64(chunk, sodium.base64_variants.URLSAFE_NO_PADDING);

        transportClient.sendEvent('migration:chunk', { roomId, chunkIndex: i, chunk: chunkB64 });
        setProgress(Math.round(((i + 1) / totalChunks) * 100));
        
        await new Promise(r => setTimeout(r, 50));
      }

      toast.loading(t('common:migration.waiting_receiver', 'Menunggu penerima...'), { id: 'send' });

      // Wait for ACK
      const ackResult = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000); // 30s timeout
        transportClient.once('migration:ack', (payload) => {
           const data = payload as { roomId: string, success: boolean };
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

      {summary && status === 'scanning' && (
        <p className="mb-6 font-mono text-[10px] uppercase tracking-widest text-text-secondary">
          {summary}
        </p>
      )}

      <Link to="/settings" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest">
        {t('common:actions.cancel_bracket', '[ BATAL ]')}
      </Link>
    </div>
  );
}
