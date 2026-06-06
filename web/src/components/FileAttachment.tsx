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
import { transportClient, } from '@lib/transportClient';
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
  const getFileType = () => {
    if (message.fileType && !message.fileType.includes('application/octet-stream')) {
      return message.fileType;
    }
    if (message.fileName) {
      const ext = message.fileName.split('.').pop()?.toLowerCase();
      if (ext === 'pdf') return 'application/pdf';
      if (ext === 'svg') return 'image/svg+xml';
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

      // 1. Cek apakah ini file terenkripsi (E2EE)
      const isEncrypted = !!message.fileKey || message.fileType?.includes('encrypted=true') || message.isBlindAttachment || !message.fileUrl;
      
      if (!isEncrypted) {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (isMounted) {
          setDecryptedUrl(absoluteUrl || null);
          setStatus('success');
          hasDecryptedSuccessfully.current = true; 
        }
        return;
      }

      // ✅ FIX: Hapus blok `if (!message.isBlindAttachment)` yang menjebak status menjadi 'waiting' selamanya!

      if (isMounted) {
        setStatus('decrypting');
        setErrorMsg(null);
      }

      try {
        let rawFileKey: string | undefined = message.fileKey || undefined;

        // 2. Fallback: Jika tidak ada fileKey tapi ini adalah Blind Attachment, coba minta dari sesi ratchet
        if (!rawFileKey && message.isBlindAttachment) {
            const targetSessionId = isGroup ? message.senderId : message.sessionId;
            const keyResult = await decryptMessage('', message.conversationId, isGroup, targetSessionId);

            if (keyResult.status === 'pending') {
                if (isMounted) {
                    setStatus('waiting');
                    const socket = transportClient;
                    if (socket?.connected && targetSessionId) {
                        transportClient.sendEvent('session:request_key', {
                            conversationId: message.conversationId,
                            sessionId: targetSessionId
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

        // Jika setelah semua usaha tetap tidak ada kunci, maka gagal.
        if (!rawFileKey) {
             if(isMounted) setStatus('waiting');
             return;
        }

        // 3. Check OPFS Cache first!
        const { getEncryptedFromOPFS, saveEncryptedToOPFS } = await import('@lib/opfsStorage');
        let encryptedBlob = await getEncryptedFromOPFS(rawFileKey);

        if (!encryptedBlob) {
            // Not in cache, download from server R2
            const absoluteUrl = toAbsoluteUrl(message.fileUrl);
            if (!absoluteUrl) throw new Error("Invalid file URL");
            
            const response = await fetch(absoluteUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            encryptedBlob = await response.blob();
            
            // Save ciphertext to OPFS for future reads
            saveEncryptedToOPFS(rawFileKey, encryptedBlob).catch(console.warn);
        }

        // 4. Dekripsi file dengan kunci yang valid
        const originalType = getFileType(); // Fungsi getFileType() yang sudah kita buat sebelumnya
        let decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, originalType);

        // ✅ SECURITY: Sanitize SVG files to prevent XSS if opened directly
        if (originalType === 'image/svg+xml') {
            const svgText = await decryptedBlob.text();
            const DOMPurify = (await import('dompurify')).default;
            const sanitizedSvg = DOMPurify.sanitize(svgText, { USE_PROFILES: { svg: true } });
            decryptedBlob = new Blob([sanitizedSvg], { type: 'image/svg+xml' });
        }

        // 5. Render ke layar!
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

  const renderHeader = (icon: React.ReactNode, colorClass: string, label: string) => (
    <div className="flex items-center gap-2 mb-1">
      <div className={`${colorClass} p-1.5 rounded-lg bg-current/10`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{message.fileName || label}</p>
        <p className="text-[10px] opacity-60 uppercase font-bold tracking-tight">
            {message.fileSize ? formatBytes(message.fileSize) : t('common:defaults.unknown', 'Unknown')}
        </p>
      </div>
      {decryptedUrl && (
        <a
          href={decryptedUrl}
          download={message.fileName || 'file'}
          className="p-1.5 bg-accent/10 hover:bg-accent/20 text-accent rounded-full transition-all active:scale-90"
          title={t('chat:media.download', 'Download')}
        >
          <FiDownload size={16} />
        </a>
      )}
    </div>
  );

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
        {renderHeader(<FiFile size={18} />, "text-red-500", t('chat:media.document_placeholder', 'Document.pdf'))}
        <div className="mt-1 border rounded overflow-hidden">
          <Document
            file={decryptedUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<div className="p-4 text-center"><Spinner size="sm" /></div>}
            error={<div className="p-4 text-center text-red-500">{t('chat:media.pdf_failed')}</div>}
          >
            <Page pageNumber={1} width={300} renderTextLayer={false} renderAnnotationLayer={false} />
          </Document>
          {numPages && numPages > 1 && (
            <div className="p-2 text-center text-[10px] text-text-secondary uppercase font-bold tracking-widest bg-black/5 dark:bg-white/5">
              {numPages} {t('chat:media.pages', 'pages')}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className={containerClass}>
        {renderHeader(<FiImage size={18} />, "text-blue-500", t('chat:media.image_placeholder', 'Image'))}
        <div className="mt-1 border rounded overflow-hidden max-h-64">
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
      </div>
    );
  }

  if (isVideo) {
    return (
      <div className={containerClass}>
        {renderHeader(<FiVideo size={18} />, "text-purple-500", t('chat:media.video_placeholder', 'Video'))}
        <div className="mt-1 border rounded overflow-hidden">
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
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className={containerClass}>
        {renderHeader(<FiMusic size={18} />, "text-green-500", t('chat:media.audio_placeholder', 'Audio'))}
        <div className="mt-1">
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
      </div>
    );
  }

  return (
    <div className={containerClass}>
       {renderHeader(<FiFile size={18} />, "text-gray-500", t('chat:media.file_placeholder', 'File'))}
    </div>
  );
}
