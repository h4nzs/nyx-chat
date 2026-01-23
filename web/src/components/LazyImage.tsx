import { useState, useRef, useEffect } from 'react';
import type { Message } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';
import { FiClock, FiAlertTriangle, FiImage } from 'react-icons/fi';

interface LazyImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  message: Message;
}

type DecryptionStatus = 'pending' | 'decrypting' | 'succeeded' | 'failed' | 'waiting_for_key';

export default function LazyImage({ 
  message, 
  alt, 
  className,
  ...props 
}: LazyImageProps) {
  const [decryptionStatus, setDecryptionStatus] = useState<DecryptionStatus>('pending');
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    const handleImageLoad = async () => {
      // 1. Validasi URL Dasar
      if (!message.fileUrl) {
        if (isMounted) {
            setDecryptionStatus('failed');
            setError("No file URL.");
        }
        return;
      }

      // 2. Cek apakah file Terenkripsi (E2EE)
      const isEncrypted = message.fileType?.includes('encrypted') || message.fileKey;

      // --- JIKA TIDAK TERENKRIPSI (Avatar/Public Image) ---
      if (!isEncrypted) {
        if (isMounted) {
          const absoluteUrl = toAbsoluteUrl(message.fileUrl);
          // FIX 1: Handle undefined -> null
          setImageUrl(absoluteUrl || null);
          setDecryptionStatus('succeeded');
        }
        return;
      }

      // --- JIKA TERENKRIPSI (Attachment Chat) ---
      const fileKey = message.fileKey;

      if (!fileKey) {
        if (isMounted) {
          setDecryptionStatus('waiting_for_key');
          setError("Waiting for key...");
        }
        return;
      }

      if (isMounted) {
        setDecryptionStatus('decrypting');
        setError(null);
      }

      try {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) throw new Error("Invalid URL");

        // A. Download Encrypted Blob
        const response = await fetch(absoluteUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        // B. Decrypt Blob
        // FIX 2: Tentukan tipe asli gambar (fallback ke jpeg) dan masukkan ke parameter ke-3
        const originalType = message.fileType?.split(';')[0] || 'image/jpeg';
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setImageUrl(objectUrl);
          setDecryptionStatus('succeeded');
        }
      } catch (e: any) {
        console.error("Image load/decrypt failed:", e);
        if (isMounted) {
          setError("Decryption failed");
          setDecryptionStatus('failed');
        }
      }
    };

    handleImageLoad();

    return () => {
      isMounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.fileUrl, message.fileKey, message.fileType, lastKeychainUpdate]);

  // --- RENDER HELPERS ---

  const renderOverlay = () => {
    if (decryptionStatus === 'succeeded') return null;

    const baseClasses = "absolute inset-0 flex flex-col items-center justify-center rounded-lg backdrop-blur-sm transition-all duration-300";

    if (decryptionStatus === 'decrypting' || decryptionStatus === 'pending') {
      return (
        <div className={`${baseClasses} bg-gray-100/50 dark:bg-gray-800/50`}>
          <Spinner size="sm" />
        </div>
      );
    }
    
    if (decryptionStatus === 'waiting_for_key') {
      return (
        <div className={`${baseClasses} bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 p-2 text-center`}>
          <FiClock className="mb-1 text-2xl" />
          <span className="text-[10px] font-medium">{error || 'Decrypting keys...'}</span>
        </div>
      );
    }

    if (decryptionStatus === 'failed') {
      return (
        <div className={`${baseClasses} bg-red-500/10 text-red-500 p-2 text-center`}>
          <FiAlertTriangle className="mb-1 text-2xl" />
          <span className="text-[10px] font-medium">{error || 'Failed to load'}</span>
        </div>
      );
    }

    return null;
  };

  return (
    <div className={`relative overflow-hidden bg-gray-100 dark:bg-gray-800 rounded-lg ${className || ''}`}>
      {/* Overlay Status (Loading/Error) */}
      {renderOverlay()}

      {/* Gambar Utama */}
      {imageUrl ? (
        <img
          ref={imgRef}
          src={imageUrl}
          alt={alt || "Message attachment"}
          className={`w-full h-full object-cover transition-opacity duration-300 ${
            decryptionStatus === 'succeeded' ? 'opacity-100' : 'opacity-0'
          }`}
          {...props}
        />
      ) : (
        // Placeholder saat belum ada URL (biar layout gak gepeng)
        <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
           <FiImage size={48} />
        </div>
      )}
    </div>
  );
}