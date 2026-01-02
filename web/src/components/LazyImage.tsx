import { useState, useRef, useEffect } from 'react';
import type { Message } from '@store/conversation';
import { decryptFile, decryptMessage } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';
import { FiClock, FiAlertTriangle } from 'react-icons/fi';

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

    const handleDecryption = async () => {
      if (!message.fileUrl) {
        if (isMounted) setError("No file URL provided.");
        return;
      }
      
      if (!message.fileType?.includes(';encrypted=true')) {
        if (isMounted) {
          const absoluteUrl = toAbsoluteUrl(message.fileUrl);
          if (absoluteUrl) {
            setImageUrl(absoluteUrl);
            setDecryptionStatus('succeeded');
          } else {
            setError("Invalid image URL.");
            setDecryptionStatus('failed');
          }
        }
        return;
      }

      const fileKey = message.content;

      if (!fileKey) {
        if (isMounted) {
          setDecryptionStatus('waiting_for_key');
          setError("File key not available yet.");
        }
        return;
      }
      
      if (fileKey === 'waiting_for_key' || fileKey.startsWith('[')) {
        if (isMounted) {
          setDecryptionStatus('waiting_for_key');
          setError(fileKey);
        }
        return;
      }

      if (isMounted) {
        setDecryptionStatus('decrypting');
        setError(null);
      }

      try {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) {
          throw new Error("File URL is invalid.");
        }
        const response = await fetch(absoluteUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setImageUrl(objectUrl);
          setDecryptionStatus('succeeded');
        }
      } catch (e: any) {
        console.error("Image decryption failed:", e);
        if (isMounted) {
          setError(e.message || "Failed to decrypt image.");
          setDecryptionStatus('failed');
        }
      }
    };

    handleDecryption();

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [message, lastKeychainUpdate]);

  const renderOverlay = () => {
    if (decryptionStatus === 'decrypting') {
      return (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded">
          <Spinner size="sm" />
        </div>
      );
    }
    if (decryptionStatus === 'waiting_for_key') {
      return (
        <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center rounded p-2 text-center text-white">
          <FiClock className="mb-1" />
          <span className="text-xs">{error || 'Requesting key...'}</span>
        </div>
      );
    }
    if (decryptionStatus === 'failed') {
      return (
        <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center rounded p-2 text-center text-red-400">
          <FiAlertTriangle className="mb-1" />
          <span className="text-xs">{error || 'Failed to load'}</span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`relative ${className || ''}`}>
      {renderOverlay()}
      <img
        ref={imgRef}
        src={imageUrl || undefined}
        alt={alt}
        className={`w-full h-full object-cover ${decryptionStatus !== 'succeeded' ? 'opacity-0' : 'opacity-100'} ${className || ''}`}
        {...props}
      />
    </div>
  );
}
