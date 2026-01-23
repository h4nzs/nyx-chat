import { useState, useEffect } from 'react';
import type { Message } from "@store/conversation";
import { toAbsoluteUrl } from "@utils/url";
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Spinner } from "./Spinner"; 
import { decryptFile } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { FiAlertTriangle, FiFile, FiDownload, FiPlayCircle, FiMusic } from 'react-icons/fi';

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
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    const handleDecryption = async () => {
      // 1. Validasi URL
      if (!message.fileUrl) {
        if (isMounted) setError("No file URL.");
        return;
      }

      // 2. Cek apakah Encrypted
      const isEncrypted = message.fileType?.includes('encrypted') || message.fileKey;

      if (!isEncrypted) {
        if (isMounted) {
           const url = toAbsoluteUrl(message.fileUrl);
           // FIX 1: Handle undefined -> null
           setDecryptedUrl(url || null);
        }
        return;
      }

      // 3. Ambil Kunci 
      const fileKey = message.fileKey;

      if (!fileKey) {
        if (isMounted) setError("Waiting for key...");
        return;
      }

      if (isMounted) {
        setIsDecrypting(true);
        setError(null);
      }

      try {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) throw new Error("Invalid URL");

        const response = await fetch(absoluteUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const encryptedBlob = await response.blob();

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        
        // FIX 2: Tambahkan parameter ke-3 (originalType)
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
        }
      } catch (e: any) {
        console.error("File decryption failed:", e);
        if (isMounted) setError("Decryption failed");
      } finally {
        if (isMounted) setIsDecrypting(false);
      }
    };

    handleDecryption();

    return () => {
      isMounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.fileUrl, message.fileKey, message.fileType, lastKeychainUpdate]);

  // --- RENDERING STATES ---

  const containerClass = `flex items-center gap-3 p-3 rounded-lg my-2 max-w-sm transition-colors ${
    isOwn ? 'bg-primary-dark/20 hover:bg-primary-dark/30' : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'
  }`;

  if (isDecrypting) {
    return (
      <div className={containerClass}>
        <Spinner size="sm" />
        <span className="text-sm opacity-70">Decrypting...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${containerClass} border border-red-500/30`}>
        <FiAlertTriangle className="text-red-500" />
        <span className="text-sm text-red-500">{error}</span>
      </div>
    );
  }

  if (!decryptedUrl) return null;

  const fileType = message.fileType?.split(';')[0] || '';

  // 1. PDF PREVIEW
  if (fileType === 'application/pdf') {
    return (
      <a href={decryptedUrl} target="_blank" rel="noopener noreferrer" download={message.fileName} className="block group">
        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 relative">
            <Document file={decryptedUrl} loading={<div className="h-40 flex items-center justify-center"><Spinner /></div>}>
                <Page pageNumber={1} width={250} renderTextLayer={false} renderAnnotationLayer={false} />
            </Document>
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none" />
        </div>
        <div className="flex items-center gap-2 mt-1 px-1">
            <FiFile className="text-red-500" />
            <span className="text-sm truncate max-w-[200px]">{message.fileName}</span>
        </div>
      </a>
    );
  }

  // 2. VIDEO PLAYER
  if (fileType.startsWith('video/')) {
    return (
      <div className="my-2 max-w-sm rounded-lg overflow-hidden bg-black">
        <video controls className="w-full max-h-[300px]" preload="metadata">
            <source src={decryptedUrl} type={fileType} />
            Your browser does not support the video tag.
        </video>
      </div>
    );
  }

  // 3. AUDIO PLAYER (Non-Voice Message)
  if (fileType.startsWith('audio/') && !message.duration) { 
    return (
      <div className={containerClass + " flex-col items-start"}>
        <div className="flex items-center gap-2 w-full">
            <FiMusic className="text-blue-500" />
            <span className="text-sm font-medium truncate">{message.fileName}</span>
        </div>
        <audio controls className="w-full h-8 mt-1">
            <source src={decryptedUrl} type={fileType} />
        </audio>
      </div>
    );
  }

  // 4. GENERIC FILE DOWNLOAD
  return (
    <a href={decryptedUrl} download={message.fileName || 'download'} className={containerClass}>
      <div className="p-3 bg-gray-200 dark:bg-gray-700 rounded-full text-gray-500 dark:text-gray-300">
        <FiFile size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{message.fileName || 'File'}</p>
        <p className="text-xs opacity-60">{message.fileSize ? formatBytes(message.fileSize) : 'Unknown size'}</p>
      </div>
      <div className="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10">
        <FiDownload size={18} />
      </div>
    </a>
  );
}