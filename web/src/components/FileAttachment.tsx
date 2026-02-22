import { useState, useEffect } from 'react';
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

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

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
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'decrypting' | 'waiting' | 'error' | 'success'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);

  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);
  const conversations = useConversationStore(s => s.conversations);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;
    let retryTimeout: NodeJS.Timeout;

    const handleDecryption = async () => {
      if (!message.fileUrl) {
        if (isMounted) setStatus('error');
        return;
      }

      // Cek apakah file terenkripsi
      const isEncrypted = message.fileType?.includes('encrypted=true') || message.fileKey;
      
      if (!isEncrypted) {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (isMounted) {
          setDecryptedUrl(absoluteUrl || null);
          setStatus('success');
        }
        return;
      }

      if (!message.fileKey) {
         if(isMounted) setStatus('waiting');
         return;
      }

      if (isMounted) {
        setStatus('decrypting');
        setErrorMsg(null);
      }

      try {
        let rawFileKey: string;

        if (message.isBlindAttachment) {
             rawFileKey = message.fileKey;
        } else {
            const conversation = conversations.find(c => c.id === message.conversationId);
            const isGroup = conversation?.isGroup || false;

            const keyResult = await decryptMessage(
              message.fileKey,
              message.conversationId,
              isGroup,
              message.sessionId
            );

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

        // Decrypt File Blob
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) throw new Error("Invalid file URL");
        
        const response = await fetch(absoluteUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        // Use rawFileKey which is now populated correctly
        const decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, originalType);

        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
          setStatus('success');
        }
      } catch (e: any) {
        console.error("Decrypt failed:", e);
        if (isMounted) {
            setErrorMsg(e.message || "Failed to decrypt file");
            setStatus('error');
        }
      }
    };

    handleDecryption();

    return () => {
      isMounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      clearTimeout(retryTimeout);
    };
  }, [message, lastKeychainUpdate, retryCount]);

  // Determine file type for rendering
  const getFileType = (): string => {
    if (message.fileType) {
      return message.fileType.split(';')[0];
    }
    if (message.fileName) {
      const ext = message.fileName.split('.').pop()?.toLowerCase();
      if (ext === 'pdf') return 'application/pdf';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext!)) return 'image/' + ext!;
      if (['mp4', 'webm', 'ogg'].includes(ext!)) return 'video/' + ext!;
      if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext!)) return 'audio/' + ext!;
    }
    return 'application/octet-stream';
  };

  const fileType = getFileType();
  const isPdf = fileType === 'application/pdf';
  const isImage = fileType.startsWith('image/');
  const isVideo = fileType.startsWith('video/');
  const isAudio = fileType.startsWith('audio/');

  const containerClass = `flex flex-col gap-2 p-3 rounded-lg my-2 max-w-sm transition-colors ${
    isOwn ? 'bg-primary-dark/20' : 'bg-gray-100 dark:bg-gray-800'
  }`;

  if (status === 'decrypting') {
    return <div className={containerClass}><Spinner size="sm" /><span className="text-sm">Decrypting...</span></div>;
  }

  if (status === 'waiting') {
    return (
        <div className={`${containerClass} border border-yellow-500/30 text-yellow-600`}>
            <FiRefreshCw className="animate-spin" />
            <span className="text-sm">Waiting for key...</span>
        </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        className={`${containerClass} border border-red-500/30 text-red-500 cursor-pointer hover:bg-red-500/10`}
        onClick={() => setRetryCount(c => c + 1)}
      >
        <FiAlertTriangle />
        <span className="text-sm">Decrypt Failed: {errorMsg}. Retry?</span>
      </div>
    );
  }

  if (!decryptedUrl) return null;

  // PDF Rendering
  if (isPdf) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiFile className="text-red-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || 'Document.pdf'}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : 'Unknown'}</p>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden">
          <Document
            file={decryptedUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            loading={<div className="p-4 text-center"><Spinner size="sm" /></div>}
            error={<div className="p-4 text-center text-red-500">Failed to load PDF</div>}
          >
            <Page pageNumber={1} width={300} renderTextLayer={false} renderAnnotationLayer={false} />
          </Document>
          {numPages && numPages > 1 && (
            <div className="p-2 text-center text-xs text-gray-500">
              {numPages} pages
            </div>
          )}
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'document.pdf'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          Download PDF
        </a>
      </div>
    );
  }

  // Image Rendering
  if (isImage) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiImage className="text-blue-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || 'Image'}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : 'Unknown'}</p>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden max-h-64">
          <img 
            src={decryptedUrl} 
            alt={message.fileName || 'Image attachment'} 
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
          Download Image
        </a>
      </div>
    );
  }

  // Video Rendering
  if (isVideo) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiVideo className="text-purple-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || 'Video'}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : 'Unknown'}</p>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden">
          <video 
            src={decryptedUrl} 
            controls 
            className="w-full max-h-64"
            onError={(e) => {
              const target = e.target as HTMLVideoElement;
              target.onerror = null; // Prevent infinite loop
              console.error("Video failed to load:", e);
            }}
          >
            Your browser does not support the video tag.
          </video>
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'video'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          Download Video
        </a>
      </div>
    );
  }

  // Audio Rendering
  if (isAudio) {
    return (
      <div className={containerClass}>
        <div className="flex items-center gap-2">
          <FiMusic className="text-green-500" size={20} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{message.fileName || 'Audio'}</p>
            <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : 'Unknown'}</p>
          </div>
        </div>
        <div className="mt-2">
          <audio 
            src={decryptedUrl} 
            controls 
            className="w-full"
            onError={(e) => {
              const target = e.target as HTMLAudioElement;
              target.onerror = null; // Prevent infinite loop
              console.error("Audio failed to load:", e);
            }}
          >
            Your browser does not support the audio element.
          </audio>
        </div>
        <a 
          href={decryptedUrl} 
          download={message.fileName || 'audio'} 
          className="flex items-center gap-2 text-sm text-blue-500 hover:underline mt-2"
        >
          <FiDownload size={16} />
          Download Audio
        </a>
      </div>
    );
  }

  // Generic File Download (fallback)
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
        <p className="font-medium text-sm truncate">{message.fileName || 'File'}</p>
        <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : 'Unknown'}</p>
      </div>
      <div className="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10">
        <FiDownload size={18} />
      </div>
    </a>
  );
}