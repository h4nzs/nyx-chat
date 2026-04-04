import { useState, useRef, useEffect } from 'react';
import type { Message } from '@store/conversation';
import { decryptFile, decryptMessage } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { useConversationStore } from '@store/conversation';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';
import { FiAlertTriangle, FiImage, FiRefreshCw } from 'react-icons/fi';
import { getSocket } from '@lib/socket'; 

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
  const [retryCount, setRetryCount] = useState(0); 
  
  // ✅ OPTIMASI 1: Kunci agar tidak re-download berkali-kali!
  const hasDecryptedSuccessfully = useRef(false);
  const lastAttachmentKey = useRef('');

  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);
  
  // ✅ OPTIMASI 2: Surgical Subscription (Hanya pantau boolean isGroup)
  const isGroup = useConversationStore(s => 
    s.conversations.find(c => c.id === message.conversationId)?.isGroup || false
  );

  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const attachmentKey = [
      message.conversationId,
      message.sessionId ?? '',
      message.fileUrl ?? '',
      message.isBlindAttachment ? 'blind' : 'normal',
    ].join('|');

    // Jika sidik jarinya BERBEDA dengan yang sebelumnya, barulah kita reset statusnya
    if (lastAttachmentKey.current !== attachmentKey) {
      hasDecryptedSuccessfully.current = false;
      lastAttachmentKey.current = attachmentKey;
    }

    // Jika sudah sukses untuk sidik jari ini, JANGAN eksekusi ulang!
    if (hasDecryptedSuccessfully.current) return;

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
      const isEncrypted = message.fileType?.includes('encrypted') || message.isBlindAttachment || !message.fileUrl;

      if (!isEncrypted) {
        if (isMounted) {
          const absoluteUrl = toAbsoluteUrl(message.fileUrl);
          setImageUrl(absoluteUrl || null);
          setDecryptionStatus('succeeded');
          hasDecryptedSuccessfully.current = true;
        }
        return;
      }

      // 3. Ambil Kunci
      const encryptedFileKey = message.fileKey || ''; // Menggunakan fileKey dari message
      
      // Jika ini bukan blind attachment dan tidak ada kunci, maka tunggu kunci
      if (!message.isBlindAttachment && !encryptedFileKey) {
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
             rawFileKey = encryptedFileKey; // Untuk V2 blind attachment
        } else {
            // DEKRIPSI KUNCI (DENGAN AUTO-RETRY LOGIC)
            const MAX_KEY_RETRIES = 5;

            const keyResult = await decryptMessage(
                encryptedFileKey,
                message.conversationId,
                isGroup,
                message.sessionId || ''
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

        // DEKRIPSI FILE BLOB
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
          hasDecryptedSuccessfully.current = true; // KUNCI!
        }
      } catch (e: unknown) {
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
      // Jangan revoke URL jika komponen hanya re-render karena Virtuoso
      if (objectUrl && !hasDecryptedSuccessfully.current) {
          URL.revokeObjectURL(objectUrl);
      }
      clearTimeout(retryTimeout);
    };
  // ✅ OPTIMASI 3: Bersihkan dependency array
  }, [message.fileUrl, message.fileType, message.fileKey, message.sessionId, lastKeychainUpdate, retryCount, message.conversationId, message.isBlindAttachment, isGroup]);

  // Clean up Object URL when the component completely unmounts from the DOM
  useEffect(() => {
    return () => {
       if (imageUrl && imageUrl.startsWith('blob:')) {
           URL.revokeObjectURL(imageUrl);
       }
    };
  }, [imageUrl]);

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
            onClick={() => {
                hasDecryptedSuccessfully.current = false; // Buka kunci
                setRetryCount(c => c + 1); // Coba lagi
            }}
        >
          <FiAlertTriangle className="mb-1 text-xl" />
          <span className="text-[10px] font-medium">Failed. Click to retry.</span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`relative overflow-hidden bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center min-w-[200px] min-h-[150px] ${className || ''}`}>
      {renderOverlay()}
      {imageUrl ? (
        <img
          ref={imgRef}
          src={imageUrl}
          alt={alt || "Message attachment"}
          className={`w-full h-full transition-opacity duration-300 ${decryptionStatus === 'succeeded' ? 'opacity-100' : 'opacity-0'} ${message.fileType === 'image/svg+xml' ? 'object-contain bg-white/5 p-2' : 'object-cover'}`}
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
