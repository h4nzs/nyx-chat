import { useState, useRef, useEffect } from 'react';
import type { Message } from '@store/conversation';
import { decryptFile, decryptMessage } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { useConversationStore } from '@store/conversation';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';
import { FiClock, FiAlertTriangle, FiImage, FiRefreshCw } from 'react-icons/fi';
import { getSocket } from '@lib/socket'; // Pastikan import socket helper

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
  const [retryCount, setRetryCount] = useState(0); // State untuk memaksa re-run useEffect
  
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);
  const conversations = useConversationStore(s => s.conversations);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;
    let retryTimeout: NodeJS.Timeout;

    const handleImageLoad = async () => {
      // 1. Validasi URL
      if (!message.fileUrl) {
        if (isMounted) { setDecryptionStatus('failed'); setError("No file URL."); }
        return;
      }

      // 2. Cek Enkripsi
      const isEncrypted = message.fileType?.includes('encrypted') || message.fileKey;

      if (!isEncrypted) {
        if (isMounted) {
          const absoluteUrl = toAbsoluteUrl(message.fileUrl);
          setImageUrl(absoluteUrl || null);
          setDecryptionStatus('succeeded');
        }
        return;
      }

      // 3. Ambil Kunci
      const encryptedFileKey = message.fileKey;
      if (!encryptedFileKey) {
        if (isMounted) { setDecryptionStatus('waiting_for_key'); setError("Waiting for key..."); }
        return;
      }

      if (isMounted) {
        setDecryptionStatus('decrypting');
        setError(null);
      }

      try {
        let rawFileKey: string;

        // CHECK BLIND ATTACHMENT (Raw Key)
        if (message.isBlindAttachment) {
             rawFileKey = encryptedFileKey;
        } else {
            // LEGACY: DEKRIPSI KUNCI (DENGAN AUTO-RETRY LOGIC)
            const conversation = conversations.find(c => c.id === message.conversationId);
            const isGroup = conversation ? conversation.isGroup : false;
            
            // [FIX] Max Retry Limit
            const MAX_KEY_RETRIES = 5;

            const keyResult = await decryptMessage(
                encryptedFileKey,
                message.conversationId,
                isGroup,
                message.sessionId
            );

            if (keyResult.status === 'pending') {
                if (isMounted) {
                    if (retryCount >= MAX_KEY_RETRIES) {
                        setDecryptionStatus('failed');
                        setError("Key not received after retries");
                        return; // Stop retrying
                    }

                    setDecryptionStatus('waiting_for_key');
                    setError(keyResult.reason || "Key not found yet");
                    
                    const socket = getSocket();
                    if (socket && socket.connected && message.sessionId) {
                        socket.emit('session:request_key', {
                            conversationId: message.conversationId,
                            sessionId: message.sessionId
                        });
                    }

                    retryTimeout = setTimeout(() => {
                        if (isMounted) setRetryCount(c => c + 1);
                    }, 3000);
                }
                return;
            }

            if (keyResult.status === 'error') {
                throw keyResult.error || new Error("Failed to decrypt file key");
            }
            rawFileKey = keyResult.value;
        }

        // B. DEKRIPSI FILE BLOB
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) throw new Error("Invalid URL");

        const response = await fetch(absoluteUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'image/jpeg';
        const decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, originalType);
        
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
      clearTimeout(retryTimeout);
    };
  }, [message.fileUrl, message.fileKey, message.fileType, message.sessionId, lastKeychainUpdate, retryCount]); // Tambah retryCount

  // --- RENDER HELPERS ---
  const renderOverlay = () => {
    if (decryptionStatus === 'succeeded') return null;

    const baseClasses = "absolute inset-0 flex flex-col items-center justify-center rounded-lg backdrop-blur-sm transition-all duration-300 z-10 p-2 text-center";

    if (decryptionStatus === 'decrypting' || decryptionStatus === 'pending') {
      return <div className={`${baseClasses} bg-gray-100/50 dark:bg-gray-800/50`}><Spinner size="sm" /></div>;
    }
    
    if (decryptionStatus === 'waiting_for_key') {
      return (
        <div className={`${baseClasses} bg-yellow-500/20 text-yellow-600 dark:text-yellow-400`}>
          <FiRefreshCw className="mb-1 text-xl animate-spin-slow" />
          <span className="text-[10px] font-medium">Waiting for key...</span>
        </div>
      );
    }

    if (decryptionStatus === 'failed') {
      return (
        <div 
            className={`${baseClasses} bg-red-500/10 text-red-500 cursor-pointer`}
            onClick={() => setRetryCount(c => c + 1)} // Manual Retry Click
        >
          <FiAlertTriangle className="mb-1 text-xl" />
          <span className="text-[10px] font-medium">Failed. Click to retry.</span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`relative overflow-hidden bg-gray-100 dark:bg-gray-800 rounded-lg ${className || ''}`}>
      {renderOverlay()}
      {imageUrl ? (
        <img
          ref={imgRef}
          src={imageUrl}
          alt={alt || "Message attachment"}
          className={`w-full h-full object-cover transition-opacity duration-300 ${decryptionStatus === 'succeeded' ? 'opacity-100' : 'opacity-0'}`}
          {...props}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600 min-h-[150px]">
           <FiImage size={48} />
        </div>
      )}
    </div>
  );
}