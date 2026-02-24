*"Kita akan mengimplementasikan fitur 'Zero-Knowledge Device Migration' menggunakan QR Code dan Socket Tunneling. Kita akan menggunakan arsitektur Pre-fetching di perangkat pengirim dan payload chunking agar bisa mengirim file Vault berukuran besar melalui Socket.io tanpa membebani server.*

*Tolong eksekusi 4 langkah ini secara presisi:*

### 1. Update Backend Socket (`server/src/socket.ts` atau file pengatur socket)

*Tambahkan event listener baru di dalam koneksi socket untuk menangani relay data migrasi (Tunneling):*

```typescript
    // === DEVICE MIGRATION TUNNEL ===
    socket.on('migration:join', (roomId: string) => {
      socket.join(roomId);
    });

    socket.on('migration:start', (data: { roomId: string, totalChunks: number, sealedKey: string, iv: string }) => {
      socket.to(data.roomId).emit('migration:start', data);
    });

    socket.on('migration:chunk', (data: { roomId: string, chunkIndex: number, chunk: any }) => {
      socket.to(data.roomId).emit('migration:chunk', data);
    });

```

### 2. Buat Halaman Penerima (`web/src/pages/MigrationReceivePage.tsx`)

*Halaman ini akan diakses dari perangkat BARU. Ia akan membuat Ephemeral Keypair, menampilkan QR Code, lalu menunggu pecahan chunk dari socket.*

```tsx
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
  const metaRef = useRef<{ totalChunks: number, sealedKey: string, iv: string } | null>(null);

  useEffect(() => {
    const init = async () => {
      const sodium = await getSodium();
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
        setStatus('receiving');
        toast.loading('Connection established. Receiving data...', { id: 'mig' });
      });

      socket.on('migration:chunk', async (data) => {
        chunksRef.current[data.chunkIndex] = data.chunk;
        const receivedCount = chunksRef.current.filter(Boolean).length;
        const total = metaRef.current?.totalChunks || 1;
        setProgress(Math.round((receivedCount / total) * 100));

        if (receivedCount === total) {
          setStatus('decrypting');
          toast.loading('Data received. Decrypting vault...', { id: 'mig' });
          await processMigration(sodium);
        }
      });
    };
    init();
    
    return () => {
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
      
      setStatus('success');
      toast.success('Migration Complete! Welcome back.', { id: 'mig' });
      setTimeout(() => window.location.href = '/', 2000); // Hard reload to clear RAM
    } catch (e) {
      console.error(e);
      toast.error('Decryption failed. Data might be corrupted.', { id: 'mig' });
      setStatus('waiting');
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

```

### 3. Buat Halaman Pengirim (`web/src/pages/MigrationSendPage.tsx`)

*Halaman ini diakses dari perangkat LAMA. Ia menerapkan PRE-FETCHING data vault sebelum kamera melakukan scan, lalu melakukan enkripsi AES dan chunking Socket.*

```tsx
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
    );

    return () => {
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

```

### 4. Tambahkan Rute ke App dan Navigation

*1. Di **`web/src/App.tsx`**, tambahkan import dan route:*

```tsx
const MigrationReceivePage = lazy(() => import('./pages/MigrationReceivePage'));
const MigrationSendPage = lazy(() => import('./pages/MigrationSendPage'));

// ... Di dalam Routes:
<Route path="/migrate-receive" element={<PageWrapper><MigrationReceivePage /></PageWrapper>} />
<Route path="/settings/migrate-send" element={<PageWrapper><MigrationSendPage /></PageWrapper>} />

```

*2. Di halaman **`web/src/pages/Login.tsx`** (atau Landing Page), tambahkan tombol/link kecil di bawah untuk:*
`<Link to="/migrate-receive">Transfer from Old Device</Link>`
*3. Di halaman **`web/src/pages/SettingsPage.tsx`**, tambahkan tombol di area Vault Actions:*
`<button onClick={() => navigate('/settings/migrate-send')}>Transfer to New Device</button>`

*Eksekusi seluruh perubahan ini agar NYX memiliki fitur Zero-Knowledge Device Migration yang seamless.*"
