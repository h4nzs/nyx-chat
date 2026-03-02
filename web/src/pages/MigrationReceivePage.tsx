import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FiSmartphone, FiDownloadCloud, FiCheckCircle } from 'react-icons/fi';
import { getSocket, connectSocket } from '@lib/socket';
import { getSodium } from '@lib/sodiumInitializer';
import { worker_file_decrypt } from '@lib/crypto-worker-proxy';
import { importDatabaseFromJson } from '@lib/keychainDb';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';

export default function MigrationReceivePage() {
  const [qrData, setQrData] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [status, setStatus] = useState<'waiting' | 'receiving' | 'decrypting' | 'success'>('waiting');
  const navigate = useNavigate();
  
  const keysRef = useRef<{ publicKey: Uint8Array, privateKey: Uint8Array } | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const metaRef = useRef<{ roomId: string, totalChunks: number, sealedKey: string, iv: string } | null>(null);
  const migrationStartedRef = useRef(false);

  useEffect(() => {
    let isMounted = true;
    
    const init = async () => {
      const sodium = await getSodium();
      if (!isMounted) return;
      
      const keypair = sodium.crypto_box_keypair();
      keysRef.current = keypair;
      
      const roomId = `mig_${uuidv4()}`;
      const pubKeyB64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      const socket = getSocket();
      if (!socket.connected) connectSocket();
      
      socket.emit('migration:join', roomId);
      setQrData(JSON.stringify({ roomId, pubKey: pubKeyB64 }));

      // Listeners
      socket.on('migration:start', (data) => {
        metaRef.current = data;
        chunksRef.current = new Array(data.totalChunks);
        migrationStartedRef.current = false;
        setStatus('receiving');
        toast.loading('Connection established. Receiving data...', { id: 'mig' });
      });

      socket.on('migration:chunk', async (data) => {
        chunksRef.current[data.chunkIndex] = data.chunk;
        const receivedCount = chunksRef.current.filter(Boolean).length;
        const total = metaRef.current?.totalChunks || 1;
        setProgress(Math.round((receivedCount / total) * 100));

        if (receivedCount === total && !migrationStartedRef.current) {
          migrationStartedRef.current = true;
          setStatus('decrypting');
          toast.loading('Data received. Decrypting vault...', { id: 'mig' });
          await processMigration(sodium);
        }
      });
    };
    init();
    
    return () => {
      isMounted = false;
      const socket = getSocket();
      socket.off('migration:start');
      socket.off('migration:chunk');
    };
  }, []);

  const processMigration = async (sodium: any) => {
    try {
      const { sealedKey, iv } = metaRef.current!;
      const sealedKeyBytes = sodium.from_base64(sealedKey, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      // 1. Decrypt the AES Key using our Private Key
      const aesKey = sodium.crypto_box_seal_open(sealedKeyBytes, keysRef.current!.publicKey, keysRef.current!.privateKey);
      
      // 2. Reassemble chunks
      const totalLength = chunksRef.current.reduce((acc, val) => acc + val.byteLength, 0);
      const combinedCiphertext = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunksRef.current) {
        combinedCiphertext.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }

      // 3. Prepare payload for worker (IV + Ciphertext)
      const ivBytes = sodium.from_base64(iv, sodium.base64_variants.URLSAFE_NO_PADDING);
      const workerPayload = new Uint8Array(ivBytes.length + combinedCiphertext.length);
      workerPayload.set(ivBytes);
      workerPayload.set(combinedCiphertext, ivBytes.length);

      // 4. Decrypt via Worker
      const decryptedBuffer = await worker_file_decrypt(workerPayload.buffer, aesKey);
      const jsonString = new TextDecoder().decode(decryptedBuffer);

      // 5. Import to IDB
      await importDatabaseFromJson(jsonString);
      
      const socket = getSocket();
      socket.emit('migration:ack', { roomId: metaRef.current!.roomId, success: true });

      setStatus('success');
      toast.success('Migration Complete! Welcome back.', { id: 'mig' });
      setTimeout(() => window.location.href = '/', 2000); // Hard reload to clear RAM
    } catch (e) {
      console.error(e);
      toast.error('Decryption failed. Data might be corrupted.', { id: 'mig' });
      
      const socket = getSocket();
      if (metaRef.current?.roomId) {
         socket.emit('migration:ack', { roomId: metaRef.current.roomId, success: false });
      }

      setStatus('waiting');
      migrationStartedRef.current = false;
    }
  };

  return (
    <div className="min-h-screen bg-bg-main text-text-primary flex flex-col items-center justify-center p-4">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-black uppercase tracking-widest text-text-primary">Migrate Device</h1>
        <p className="text-xs text-text-secondary mt-2">Scan this QR from your old device</p>
      </div>

      <div className="bg-white p-4 rounded-2xl shadow-neumorphic-convex border-4 border-bg-main mb-8 relative">
        {status === 'success' ? (
          <div className="w-[250px] h-[250px] flex items-center justify-center text-green-500">
            <FiCheckCircle size={80} className="animate-bounce-in" />
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

      <Link to="/login" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest">
        [ CANCEL ]
      </Link>
    </div>
  );
}
