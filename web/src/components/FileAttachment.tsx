import { useState, useEffect, useRef } from 'react';
import type { Message } from "@store/conversation";
import { toAbsoluteUrl } from "@utils/url";
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Spinner } from "./Spinner";
import { decryptFile, decryptMessage } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { useConversationStore } from '@store/conversation';
import { FiAlertTriangle, FiFile, FiDownload, FiMusic, FiVideo, FiImage, FiRefreshCw } from 'react-icons/fi';
import { getSocket } from '@lib/socket';
import { useTranslation } from 'react-i18next';

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

function formatBytes(bytes: number, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

interface FileAttachmentProps {
  message: Message;
  isOwn?: boolean;
}

export default function FileAttachment({ message, isOwn }: FileAttachmentProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'decrypting' | 'waiting' | 'error' | 'success'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);

  const hasDecryptedSuccessfully = useRef(false);
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);
  
  const isGroup = useConversationStore(s => 
    s.conversations.find(c => c.id === message.conversationId)?.isGroup || false
  );

  // ✅ FIX: Pindahkan getFileType ke atas agar bisa digunakan oleh useEffect
  const getFileType = (): string => {
    if (message.fileType && message.fileType.trim() !== '') {
      return message.fileType.split(';')[0];
    }
    if (message.fileName) {
      const ext = message.fileName.split('.').pop()?.toLowerCase();
      if (ext === 'pdf') return 'application/pdf';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext!)) return 'image/' + ext!;
      if (['mp4', 'webm', 'ogg', 'mov'].includes(ext!)) return 'video/' + ext!;
      if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext!)) return 'audio/' + ext!;
    }
    return 'application/octet-stream';
  };

  useEffect(() => {
    if (hasDecryptedSuccessfully.current) return;

    let objectUrl: string | null = null;
    let isMounted = true;
    let retryTimeout: NodeJS.Timeout;

    const handleDecryption = async () => {
      if (!message.fileUrl) {
        if (isMounted) setStatus('error');
        return;
      }

      const isEncrypted = message.fileType?.includes('encrypted=true') || message.isBlindAttachment || !message.fileUrl;
      
      if (!isEncrypted) {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (isMounted) {
          setDecryptedUrl(absoluteUrl || null);
          setStatus('success');
          hasDecryptedSuccessfully.current = true; 
        }
        return;
      }

      if (!message.isBlindAttachment) {
         if(isMounted) setStatus('waiting');
         return;
      }

      if (isMounted) {
        setStatus('decrypting');
        setErrorMsg(null);
      }

      try {
        let rawFileKey: string;

        if (message.fileKey) {
             rawFileKey = message.fileKey;
        } else if (message.isBlindAttachment) {
             rawFileKey = ''; 
        } else {
            const keyResult = await decryptMessage('', message.conversationId, isGroup, '');

            if (keyResult.status === 'pending') {
                if (isMounted) {
                    setStatus('waiting');
                    const socket = getSocket();
                    if (socket?.connected && message.sessionId) {
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

            if (keyResult.status === 'error') throw keyResult.error;
            rawFileKey = keyResult.value;
        }

        if (!rawFileKey) {
             if(isMounted) setStatus('waiting');
             return;
        }

        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) throw new Error("Invalid file URL");
        
        const response = await fetch(absoluteUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        // ✅ FIX UTAMA: Gunakan getFileType() untuk menentukan MIME Type asli dari Blob
        // Ini mencegah browser mengira video sebagai 'application/octet-stream'
        const originalType = getFileType(); 
        const decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, originalType);

        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
          setStatus('success');
          hasDecryptedSuccessfully.current = true;
        }
      } catch (e: unknown) {
        console.error("Decrypt failed:", e);
        if (isMounted) {
            const errorMessage = e instanceof Error ? e.message : t('chat:media.default_error', 'Failed to decrypt file');
            setErrorMsg(errorMessage);
            setStatus('error');
        }
      }
    };

    handleDecryption();

    return () => {
      isMounted = false;
      if (objectUrl && !hasDecryptedSuccessfully.current) {
         URL.revokeObjectURL(objectUrl);
      }
    };
  // Tambahkan getFileType ke dependency array eslint jika diminta (opsional)
  }, [message, lastKeychainUpdate, retryCount, isGroup, t]);

  useEffect(() => {
    return () => {
       if (decryptedUrl && decryptedUrl.startsWith('blob:')) {
           setTimeout(() => {
               URL.revokeObjectURL(decryptedUrl);
           }, 10000);
       }
    };
  }, [decryptedUrl]);

  // Eksekusi ulang setelah getFileType dipindahkan ke atas
  const fileType = getFileType();
  const isPdf = fileType === 'application/pdf';
  const isImage = fileType.startsWith('image/');
  const isVideo = fileType.startsWith('video/');
  const isAudio = fileType.startsWith('audio/');

  const containerClass = `flex flex-col gap-2 p-3 rounded-lg my-2 max-w-sm transition-colors ${
    isOwn ? 'bg-primary-dark/20' : 'bg-gray-100 dark:bg-gray-800'
  }`;

  if (status === 'decrypting') {
    return <div className={containerClass}><Spinner size="sm" /><span className="text-sm">{t('chat:media.decrypting')}</span></div>;
  }

  if (status === 'waiting') {
    return (
        <div className={`${containerClass} border border-yellow-500/30 text-yellow-600`}>
            <FiRefreshCw className="animate-spin" />
            <span className="text-sm">{t('chat:media.waiting_key')}</span>
        </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        className={`${containerClass} border border-red-500/30 text-red-500 cursor-pointer hover:bg-red-500/10`}
        onClick={() => {
            hasDecryptedSuccessfully.current = false; // Buka kunci agar bisa retry
            setRetryCount(c => c + 1);
        }}
      >
        <FiAlertTriangle />
        <span className="text-sm">{t('chat:media.decrypt_failed', { error: errorMsg })}. {t('chat:media.retry')}</span>
      </div>
    );
  }

  if (!decryptedUrl) return null;

  if (isPdf) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiFile className="text-red-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || t('chat:media.document_placeholder', 'Document.pdf')}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : t('common:defaults.unknown', 'Unknown')}</p>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden">
          <Document
            file={decryptedUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<div className="p-4 text-center"><Spinner size="sm" /></div>}
            error={<div className="p-4 text-center text-red-500">{t('chat:media.pdf_failed')}</div>}
          >
            <Page pageNumber={1} width={300} renderTextLayer={false} renderAnnotationLayer={false} />
          </Document>
          {numPages && numPages > 1 && (
            <div className="p-2 text-center text-xs text-gray-500">
              {numPages} {t('chat:media.pages', 'pages')}
            </div>
          )}
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'document.pdf'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          {t('chat:media.download_x', { type: 'PDF' })}
        </a>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiImage className="text-blue-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || t('chat:media.image_placeholder', 'Image')}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : t('common:defaults.unknown', 'Unknown')}</p>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden max-h-64">
          <img 
            src={decryptedUrl} 
            alt={message.fileName || t('chat:media.image_alt', 'Image attachment')} 
            className="w-full h-auto object-contain max-h-64"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.onerror = null; // Prevent infinite loop
              target.src = '/fallback-image.svg'; // Fallback image
            }}
          />
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'image'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          {t('chat:media.download_x', { type: 'Image' })}
        </a>
      </div>
    );
  }

  if (isVideo) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiVideo className="text-purple-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || t('chat:media.video_placeholder', 'Video')}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : t('common:defaults.unknown', 'Unknown')}</p>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden">
          <video 
            src={decryptedUrl} 
            controls 
            className="w-full max-h-64"
            onError={(e) => {
              const target = e.target as HTMLVideoElement;
              target.onerror = null;
              console.error("Video failed to load:", e);
            }}
          >
            {t('chat:media.browser_unsupported', { type: 'video' })}
          </video>
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'video'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          {t('chat:media.download_x', { type: 'Video' })}
        </a>
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiMusic className="text-green-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || t('chat:media.audio_placeholder', 'Audio')}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : t('common:defaults.unknown', 'Unknown')}</p>
          </div>
        </div>
        <div className="mt-2">
          <audio 
            src={decryptedUrl} 
            controls 
            className="w-full"
            onError={(e) => {
              const target = e.target as HTMLAudioElement;
              target.onerror = null;
              console.error("Audio failed to load:", e);
            }}
          >
            {t('chat:media.browser_unsupported', { type: 'audio' })}
          </audio>
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'audio'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          {t('chat:media.download_x', { type: 'Audio' })}
        </a>
      </div>
    );
  }

  return (
    <a 
      href={decryptedUrl} 
      download={message.fileName || 'download'} 
      className={`${containerClass} flex items-center gap-3`}
    >
      <div className="p-3 bg-gray-200 dark:bg-gray-700 rounded-full text-gray-500 dark:text-gray-300">
        <FiFile size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{message.fileName || t('chat:media.file_placeholder', 'File')}</p>
        <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : t('common:defaults.unknown', 'Unknown')}</p>
      </div>
      <div className="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10">
        <FiDownload size={18} />
      </div>
    </a>
  );
}
