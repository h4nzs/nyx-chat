import { useEffect, useState } from 'react';
import type { Message } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';

interface LightboxProps {
  message: Message;
  onClose: () => void;
}

export default function Lightbox({ message, onClose }: LightboxProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Decryption logic
  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    const handleDecryption = async () => {
      if (!message.fileUrl) {
        if (isMounted) setError("No file URL provided.");
        return;
      }

      if (isMounted) {
        setIsLoading(true);
        setError(null);
      }
      
      try {
        if (!message.fileType?.includes(';encrypted=true')) {
          if (isMounted) setDecryptedUrl(toAbsoluteUrl(message.fileUrl));
          return;
        }

        const fileKey = message.content;

        if (!fileKey || fileKey === 'waiting_for_key' || fileKey.startsWith('[')) {
          throw new Error(fileKey || "File key not available yet.");
        }

        const response = await fetch(toAbsoluteUrl(message.fileUrl));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
        }
      } catch (e: any) {
        if (isMounted) setError(e.message || "Failed to decrypt image.");
      } finally {
        if (isMounted) setIsLoading(false);
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

  return (
    <div 
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in p-4 md:p-8"
      onClick={onClose}
    >
      <button 
        className="absolute top-4 right-4 text-white text-3xl hover:opacity-80 transition-opacity z-10"
        onClick={onClose}
      >
        &times;
      </button>
      <div className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {isLoading && <Spinner size="lg" />}
        {error && !isLoading && <div className="text-white text-center p-4 bg-destructive/50 rounded-lg">{error}</div>}
        {!isLoading && !error && decryptedUrl && (
          <img src={decryptedUrl} alt="Lightbox view" className="object-contain max-w-full max-h-full" />
        )}
      </div>
    </div>
  );
}
