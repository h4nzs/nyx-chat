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
import { FiAlertTriangle, FiFile, FiDownload, FiMusic, FiRefreshCw } from 'react-icons/fi';
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

  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);
  const conversations = useConversationStore(s => s.conversations);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;
    let retryTimeout: NodeJS.Timeout;

    const handleDecryption = async () => {
      // ... (Validasi URL & Cek Encrypted sama seperti LazyImage) ...
      if (!message.fileUrl) { if(isMounted) setStatus('error'); return; }
      
      const isEncrypted = message.fileType?.includes('encrypted') || message.fileKey;
      if (!isEncrypted) {
        if (isMounted) {
           setDecryptionUrl(toAbsoluteUrl(message.fileUrl) || null);
           setStatus('success');
        }
        return;
      }

      if (!message.fileKey) {
         if(isMounted) setStatus('waiting');
         return;
      }

      if (isMounted) setStatus('decrypting');

      try {
        const conversation = conversations.find(c => c.id === message.conversationId);
        const isGroup = conversation ? conversation.isGroup : false;

        const keyResult = await decryptMessage(
            message.fileKey,
            message.conversationId,
            isGroup,
            message.sessionId
        );

        if (keyResult.status === 'pending') {
            if (isMounted) {
                setStatus('waiting');
                // Request Key via Socket
                const socket = getSocket();
                if (socket?.connected && message.sessionId) {
                    socket.emit('session:request_key', {
                        conversationId: message.conversationId,
                        sessionId: message.sessionId
                    });
                }
                // Auto Retry
                retryTimeout = setTimeout(() => {
                    if (isMounted) setRetryCount(c => c + 1);
                }, 3000);
            }
            return;
        }

        if (keyResult.status === 'error') throw keyResult.error;

        // Decrypt File Blob
        const response = await fetch(toAbsoluteUrl(message.fileUrl)!);
        if (!response.ok) throw new Error("Network error");
        const blob = await response.blob();
        
        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(blob, keyResult.value, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
          setStatus('success');
        }
      } catch (e: any) {
        console.error("Decrypt failed:", e);
        if (isMounted) {
            setErrorMsg("Failed");
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

  // Helper setDecryptionUrl (karena typo di logic atas)
  const setDecryptionUrl = (url: string | null) => setDecryptedUrl(url);

  // --- RENDER ---
  const containerClass = `flex items-center gap-3 p-3 rounded-lg my-2 max-w-sm transition-colors ${
    isOwn ? 'bg-primary-dark/20' : 'bg-gray-100 dark:bg-gray-800'
  }`;

  if (status === 'decrypting') {
    return <div className={containerClass}><Spinner size="sm" /><span className="text-sm">Decrypting...</span></div>;
  }

  if (status === 'waiting') {
    return (
        <div className={`${containerClass} border border-yellow-500/30 text-yellow-600`}>
            <FiRefreshCw className="animate-spin-slow" />
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
        <span className="text-sm">Decrypt Failed. Retry?</span>
      </div>
    );
  }

  if (!decryptedUrl) return null;

  const fileType = message.fileType?.split(';')[0] || '';

  // ... (SISA KODE RENDER PDF/VIDEO/AUDIO SAMA SEPERTI SEBELUMNYA) ...
  // Paste logika render PDF/Video/Audio dari kode sebelumnya di sini
  // ...
  
  // Generic File
  return (
    <a href={decryptedUrl} download={message.fileName || 'download'} className={containerClass}>
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