import { useState, useRef, useEffect } from 'react';
import type { Message } from '@store/conversation';
import { decryptFile, decryptMessage } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';

interface LazyImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  message: Message;
}

export default function LazyImage({ 
  message, 
  alt, 
  className,
  ...props 
}: LazyImageProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
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

      if (isMounted) {
        setIsLoading(true);
        setError(null);
      }

      try {
        // If not encrypted, just use the URL
        if (!message.fileType?.includes(';encrypted=true')) {
          if (isMounted) setDecryptedUrl(toAbsoluteUrl(message.fileUrl));
          return;
        }

        // --- Start Decryption Flow ---
        if (!message.fileKey || !message.sessionId) {
          throw new Error("Incomplete image data for decryption.");
        }

        let fileKey = message.fileKey;
        if (!message.optimistic && fileKey.length > 50) {
          fileKey = await decryptMessage(message.fileKey, message.conversationId, message.sessionId);
        }

        if (!fileKey || fileKey.startsWith('[')) {
          throw new Error(fileKey || "Could not retrieve file key.");
        }

        const response = await fetch(toAbsoluteUrl(message.fileUrl));
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("File not found on server.");
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
        }
      } catch (e: any) {
        console.error("Image decryption failed:", e);
        if (isMounted) setError(e.message || "Failed to decrypt image.");
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

  useEffect(() => {
    if (!decryptedUrl) return;

    const img = new Image();
    img.src = decryptedUrl;
    
    img.onload = () => {
      setIsLoading(false);
      if (imgRef.current) {
        imgRef.current.src = decryptedUrl;
      }
    };
    
    img.onerror = () => {
      setIsLoading(false);
      setError("Failed to load image resource.");
    };
  }, [decryptedUrl]);

  return (
    <div className={`relative ${className || ''}`}>
      {isLoading && (
        <div className="absolute inset-0 bg-gray-200 dark:bg-gray-700 animate-pulse rounded flex items-center justify-center">
          <Spinner size="sm" />
        </div>
      )}
      
      {error && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded text-center p-2">
          <span className="text-gray-500 text-xs">⚠️ {error}</span>
        </div>
      )}
      
      <img
        ref={imgRef}
        alt={alt}
        className={`${isLoading || error ? 'opacity-0' : 'opacity-100'} ${className || ''}`}
        {...props}
      />
    </div>
  );
}