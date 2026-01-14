import { useState, useRef, useEffect } from 'react';
import { FiPlay, FiPause, FiDownload, FiAlertTriangle } from 'react-icons/fi';
import { motion } from 'framer-motion';
import { Message } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { toAbsoluteUrl } from '@utils/url';
import { useKeychainStore } from '@store/keychain';
import { Spinner } from './Spinner';

interface VoiceMessagePlayerProps {
  message: Message;
}

export default function VoiceMessagePlayer({ message }: VoiceMessagePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  const duration = message.duration || 0;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    const handleDecryption = async () => {
      // The decrypted file key is now expected to be in message.content
      const fileKey = message.content;

      if (!message.fileUrl || !fileKey) {
        if (isMounted) setError("Incomplete message data for decryption.");
        return;
      }
      
      // Handle pending/error states passed from the store
      if (fileKey === 'waiting_for_key' || fileKey.startsWith('[')) {
        if (isMounted) setError(fileKey);
        return;
      }

      if (isMounted) {
        setIsLoading(true);
        setError(null);
      }

      try {
        const absoluteUrl = toAbsoluteUrl(message.fileUrl);
        if (!absoluteUrl) {
          throw new Error("File URL is invalid.");
        }
        // 1. Fetch the encrypted file
        const response = await fetch(absoluteUrl);
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("File not found on server.");
          }
          throw new Error(`Failed to fetch voice file: ${response.statusText}`);
        }
        const encryptedBlob = await response.blob();

        // 2. Decrypt the file blob
        const decryptedBlob = await decryptFile(encryptedBlob, fileKey, 'audio/webm');
        
        if (isMounted) {
          // 3. Create a playable URL
          objectUrl = URL.createObjectURL(decryptedBlob);
          setAudioSrc(objectUrl);
        }
      } catch (e: any) {
        console.error("Voice message decryption failed:", e);
        if (isMounted) setError(e.message || "Failed to decrypt voice message.");
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    if (message.fileType?.includes('encrypted=true')) {
      handleDecryption();
    } else if (message.fileUrl) {
      const absoluteUrl = toAbsoluteUrl(message.fileUrl);
      if (absoluteUrl) {
        // For optimistic messages with blob URLs
        setAudioSrc(absoluteUrl);
      } else {
        setError("Invalid audio file URL.");
      }
    }

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [message, lastKeychainUpdate]); // Re-run when a new key might have arrived

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleCanPlay = () => setIsLoaded(true);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [audioSrc]); // Re-attach listeners if src changes

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const formatTime = (timeInSeconds: number) => {
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 w-full max-w-[250px] h-[60px]">
        <Spinner size="sm" />
        <span className="text-sm text-text-secondary">Decrypting...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 w-full max-w-[250px] p-2 bg-destructive/10 rounded-lg">
        <FiAlertTriangle className="text-destructive flex-shrink-0" />
        <p className="text-xs text-destructive italic">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 w-full max-w-[250px] p-1">
      {audioSrc && <audio ref={audioRef} src={audioSrc} preload="metadata" />}
      <button 
        onClick={togglePlay} 
        disabled={!isLoaded}
        className="p-3 rounded-full bg-bg-surface text-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed disabled:opacity-50 transition-all"
        aria-label={isPlaying ? 'Pause voice message' : 'Play voice message'}
      >
        <motion.div
          key={isPlaying ? 'pause' : 'play'}
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
        >
          {isPlaying ? <FiPause size={18} /> : <FiPlay size={18} className="ml-0.5" />}
        </motion.div>
      </button>
      <div className="flex-1 flex flex-col justify-center gap-1.5">
        <div className="w-full h-1.5 bg-black/20 shadow-neumorphic-concave rounded-full overflow-hidden">
          <div 
            className="h-full bg-accent rounded-full relative"
            style={{ width: `${progress}%` }}
          >
            <div className="w-3 h-3 bg-white rounded-full absolute top-1/2 right-0 -translate-y-1/2 translate-x-1/2 shadow-lg" />
          </div>
        </div>
        <span className="text-xs text-text-secondary/80 font-mono self-end">
          {formatTime(isPlaying ? currentTime : duration)}
        </span>
      </div>
    </div>
  );
}