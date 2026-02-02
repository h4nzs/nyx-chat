import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '@store/conversation';
import { decryptFile, decryptMessage } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { useConversationStore } from '@store/conversation';
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
    // Lock scroll when open
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
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
        // Cek apakah file terenkripsi
        const isEncrypted = message.fileType?.includes('encrypted=true') || message.fileKey;

        if (!isEncrypted) {
          const absoluteUrl = toAbsoluteUrl(message.fileUrl);
          if (isMounted) {
            if (absoluteUrl) {
              setDecryptedUrl(absoluteUrl);
            } else {
              throw new Error("Invalid image URL.");
            }
          }
          return;
        }

        // Ambil kunci file yang terenkripsi
        const encryptedFileKey = message.fileKey || message.content;

        if (!encryptedFileKey || encryptedFileKey === 'waiting_for_key' || encryptedFileKey.startsWith('[')) {
          if (isMounted) {
            setError(encryptedFileKey || "File key not available yet.");
            setIsLoading(false);
          }
          return;
        }

        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) {
          throw new Error("File URL is invalid.");
        }

        const response = await fetch(absoluteUrl);
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("File not found on server.");
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const encryptedBlob = await response.blob();

        // Dekripsi kunci file terlebih dahulu
        const conversation = useConversationStore.getState().conversations.find(c => c.id === message.conversationId);
        const isGroup = conversation?.isGroup || false;

        const keyResult = await decryptMessage(
          encryptedFileKey,
          message.conversationId,
          isGroup,
          message.sessionId
        );

        if (keyResult.status === 'pending') {
          if (isMounted) {
            setError(keyResult.reason || "Waiting for key...");
            setIsLoading(false);
          }
          return;
        }

        if (keyResult.status === 'error') {
          throw keyResult.error || new Error("Failed to decrypt file key.");
        }

        const rawFileKey = keyResult.value;

        // Dekripsi file blob
        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, originalType);

        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
        }
      } catch (e: any) {
        console.error("Lightbox decryption failed:", e);
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

  const content = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 backdrop-blur-xl animate-fade-in p-4 md:p-8"
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
        {error && !isLoading && (
          <div className="text-white text-center p-4 bg-destructive/50 rounded-lg">
            <p>{error}</p>
            <button
              className="mt-2 px-4 py-2 bg-accent rounded-lg"
              onClick={() => window.location.reload()}
            >
              Refresh Page
            </button>
          </div>
        )}
        {!isLoading && !error && decryptedUrl && (
          <img
            src={decryptedUrl}
            alt={message.fileName || "Lightbox view"}
            className="object-contain max-w-full max-h-[90vh] select-none shadow-2xl rounded-lg"
            onError={() => {
              setError("Failed to load image.");
              setIsLoading(false);
            }}
          />
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}