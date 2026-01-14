import { useState, useEffect, useRef } from 'react';
import type { Message } from "@store/conversation";
import { toAbsoluteUrl } from "@utils/url";
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Spinner } from "./Spinner";
import { decryptFile } from '@utils/crypto';
import { useKeychainStore } from '@store/keychain';
import { FiAlertTriangle } from 'react-icons/fi';

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
  onImageClick?: () => void;
}

export default function FileAttachment({ message }: FileAttachmentProps) {
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    const handleDecryption = async () => {
      // The decrypted file key is now expected to be in message.content
      const fileKey = message.content;

      if (!message.fileUrl || !fileKey) {
        if (isMounted) setError("Incomplete file data.");
        return;
      }
      
      // Handle pending/error states passed from the store
      if (fileKey === 'waiting_for_key' || fileKey.startsWith('[')) {
        if (isMounted) setError(fileKey);
        return;
      }

      if (isMounted) {
        setIsDecrypting(true);
        setError(null);
      }

      try {
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

        const originalType = message.fileType?.split(';')[0] || 'application/octet-stream';
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, originalType);
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setDecryptedUrl(objectUrl);
        }
      } catch (e: any) {
        console.error("File decryption failed:", e);
        if (isMounted) setError(e.message || "Failed to decrypt file.");
      } finally {
        if (isMounted) setIsDecrypting(false);
      }
    };

    if (message.fileType?.includes(';encrypted=true')) {
      handleDecryption();
    } else if (message.fileUrl) {
      const absoluteUrl = toAbsoluteUrl(message.fileUrl);
      if (absoluteUrl) {
        // For non-encrypted files (e.g. optimistic blob URLs)
        setDecryptedUrl(absoluteUrl);
      } else {
        setError("Invalid file URL.");
      }
    }

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [message, lastKeychainUpdate]);

  if (isDecrypting) {
    return (
      <div className="flex items-center gap-3 p-3 rounded-lg bg-black/20 my-2 max-w-sm">
        <Spinner size="sm" />
        <span className="text-sm text-gray-300">Decrypting file...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 p-3 rounded-lg bg-destructive/20 my-2 max-w-sm text-destructive">
        <FiAlertTriangle />
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  if (!decryptedUrl) return null;

  const fileType = message.fileType?.split(';')[0] || '';

  if (fileType === 'application/pdf') {
    return (
      <a href={decryptedUrl} target="_blank" rel="noopener noreferrer" download={message.fileName || 'download.pdf'} className="block p-2 rounded-lg bg-black/20 hover:bg-black/30 transition-colors my-2 max-w-sm">
        <div className="bg-white rounded-md overflow-hidden pointer-events-none"><Document file={decryptedUrl} loading={<div className="flex justify-center items-center h-40"><Spinner /></div>}><Page pageNumber={1} width={300} /></Document></div>
        <div className="mt-2 px-1"><p className="font-semibold text-white truncate">{message.fileName || 'File'}</p></div>
      </a>
    );
  }

  if (fileType.startsWith('video/')) {
    return (
      <div className="my-2 max-w-sm">
        <video controls className="w-full rounded-lg"><source src={decryptedUrl} type={fileType} />Your browser does not support the video tag.</video>
        <p className="text-xs text-text-secondary mt-1 px-1">{message.fileName}</p>
      </div>
    );
  }

  if (fileType.startsWith('audio/') && !message.duration) { // Exclude voice messages
    return (
      <div className="my-2 w-full max-w-sm">
        <p className="text-sm text-text-primary font-semibold mb-1 px-1">{message.fileName}</p>
        <audio controls className="w-full"><source src={decryptedUrl} type={fileType} />Your browser does not support the audio element.</audio>
      </div>
    );
  }

  // Generic file download link
  return (
    <a href={decryptedUrl} download={message.fileName || 'download'} className="flex items-center gap-3 p-3 rounded-lg bg-black/20 hover:bg-black/30 transition-colors my-2 max-w-sm">
      <div className="flex-shrink-0 p-2 bg-gray-600 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg></div>
      <div className="min-w-0"><p className="font-semibold text-white truncate">{message.fileName || 'File'}</p>{message.fileSize && <p className="text-xs text-gray-400">{formatBytes(message.fileSize)}</p>}</div>
      <div className="ml-auto p-2 text-gray-400"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="m8 12 4 4 4-4"/></svg></div>
    </a>
  );
}
