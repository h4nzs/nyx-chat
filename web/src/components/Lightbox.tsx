import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { useMessageStore } from '@store/message';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';
import { useTranslation } from 'react-i18next';

interface LightboxProps {
  message: Message;
  onClose: () => void;
}

export default function Lightbox({ message, onClose }: LightboxProps) {
  const { t } = useTranslation(['chat']);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  const handleClose = () => {
    if (message.isViewOnce && !message.isViewed) {
      useMessageStore.getState().updateMessage(message.conversationId, message.id, { isViewed: true });
      import('@lib/socket').then(({ getSocket }) => {
          const socket = getSocket();
          const emitViewedAck = () => {
              socket?.emit('message:view_once_opened', { messageId: message.id, conversationId: message.conversationId });
          };
          if (socket?.connected) {
              emitViewedAck();
          } else {
              // Queue: emit once socket reconnects
              socket?.once('connect', emitViewedAck);
          }
      });
      // Optionally clean up the file object locally so it can't be re-opened:
      useMessageStore.getState().updateMessage(message.conversationId, message.id, { fileUrl: undefined, content: null });
    }
    onClose();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [handleClose]);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    const handleDecryption = async () => {
      if (!message.fileUrl) {
        if (isMounted) setError(t('media.no_url'));
        return;
      }

      const rawFileKey = message.fileKey || '';

      if (!rawFileKey && message.content !== 'waiting_for_key') {
        if (isMounted) {
             setError(t('media.waiting_key'));
             setIsLoading(false);
        }
        return;
      } else if (!rawFileKey) {
        if (isMounted) {
          setError(t('media.waiting_key'));
          setIsLoading(false);
        }
        return;
      }

      if (isMounted) {
        setIsLoading(true);
        setError(null);
      }

      try {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) throw new Error(t('media.invalid_url'));

        const response = await fetch(absoluteUrl);
        if (!response.ok) {
          if (response.status === 404) throw new Error(t('media.not_found'));
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, originalType);

        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
        }
      } catch (e: unknown) {
        console.error("Lightbox decryption failed:", e);
        if (isMounted) setError((e instanceof Error ? e.message : 'Unknown error') || t('media.decrypt_image_failed'));
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    handleDecryption();

    return () => {
      isMounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message, lastKeychainUpdate, t]);

  const isVideo = message.fileType?.startsWith('video/');
  const isAudio = message.fileType?.startsWith('audio/');

  const content = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 backdrop-blur-xl animate-fade-in p-4 md:p-8"
      onClick={handleClose}
    >
      <button
        className="absolute top-4 right-4 text-white text-3xl hover:opacity-80 transition-opacity z-10"
        onClick={handleClose}
      >
        &times;
      </button>
      <div className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {isLoading && <Spinner size="lg" />}
        {error && !isLoading && (
          <div className="text-white text-center p-4 bg-destructive/50 rounded-lg">
            <p>{error}</p>
          </div>
        )}
        {!isLoading && !error && decryptedUrl && (
          isVideo ? (
            <video src={decryptedUrl} autoPlay controls playsInline className="max-w-full max-h-[90vh] shadow-2xl rounded-lg outline-none bg-black" onEnded={handleClose} />
          ) : isAudio ? (
             <div className="bg-bg-surface p-8 rounded-3xl flex flex-col items-center justify-center gap-6 border border-white/10 shadow-2xl min-w-[280px]">
                <div className="w-24 h-24 bg-accent/20 rounded-full flex items-center justify-center relative">
                   <div className="absolute inset-0 rounded-full border-4 border-accent animate-ping opacity-50"></div>
                   <span className="text-4xl text-accent">🎵</span>
                </div>
                <audio src={decryptedUrl} autoPlay controls className="w-full outline-none" onEnded={handleClose} />
                <p className="text-xs text-text-secondary uppercase tracking-widest font-mono">{t('media.view_once_audio')}</p>
             </div>
          ) : (
            <img 
              src={decryptedUrl} 
              alt={message.fileName || t('media.lightbox_view')} 
              className={`object-contain max-w-full max-h-[90vh] select-none shadow-2xl rounded-lg ${message.fileType === 'image/svg+xml' ? 'bg-white/5 p-4' : ''}`} 
              onError={() => { setError(t('media.load_failed')); setIsLoading(false); }} 
            />
          )
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
