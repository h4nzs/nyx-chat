import { useEffect, useRef, useState, memo } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { FiPlay, FiPause, FiAlertTriangle } from 'react-icons/fi';
import { Message } from '@store/conversation';
import { decryptFile } from '@utils/crypto';
import { toAbsoluteUrl } from '@utils/url';
import { Spinner } from './Spinner';
import { useKeychainStore } from '@store/keychain';
import { useTranslation } from 'react-i18next';

interface VoiceMessagePlayerProps {
  message: Message;
}

const VoiceMessagePlayer = ({ message }: VoiceMessagePlayerProps) => {
  const { t } = useTranslation(['chat']);
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isReady, setIsReady] = useState(false);
  
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ✅ OPTIMASI: Kunci agar tidak re-download berkali-kali!
  const hasDecryptedSuccessfully = useRef(false);
  
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  // 1. Decrypt audio and create ObjectURL
  useEffect(() => {
    // Jika sudah sukses terdekripsi, JANGAN PERNAH jalankan effect ini lagi 
    if (hasDecryptedSuccessfully.current) return;

    let objectUrl: string | null = null;
    let isMounted = true;

    const handleDecryption = async () => {
      const rawFileKey = message.fileKey || '';

      if (!message.fileUrl) {
        if (isMounted) setError(t('media.missing_url'));
        return;
      }
      
      // If we don't have the key yet, check if we need to wait or decrypt the message first
      if (!rawFileKey) {
         if (message.content === 'waiting_for_key' || message.content?.startsWith('[')) {
             if (isMounted) setError(message.content);
             return;
         }
         
         if (message.isBlindAttachment) {
             if (isMounted) setIsLoading(true);
             return;
         }
         
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
        if (!absoluteUrl) {
          throw new Error(t('media.invalid_url'));
        }
        
        const response = await fetch(absoluteUrl);
        if (!response.ok) {
          if (response.status === 404) throw new Error(t('media.not_found'));
          throw new Error(`Failed to fetch voice file: ${response.statusText}`);
        }
        const encryptedBlob = await response.blob();
        const decryptedBlob = await decryptFile(encryptedBlob, rawFileKey, 'audio/webm');
        
        if (isMounted) {
          objectUrl = URL.createObjectURL(decryptedBlob);
          setAudioSrc(objectUrl);
          hasDecryptedSuccessfully.current = true; // ✅ KUNCI STATUS SUKSES!
        }
      } catch (e: unknown) {
        console.error("Voice message decryption failed:", e);
        if (isMounted) setError((e instanceof Error ? e.message : 'Unknown error') || t('media.decrypt_voice_failed'));
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    if (message.fileType?.includes('encrypted=true') || message.isBlindAttachment || !message.fileUrl) {
      handleDecryption();
    } else if (message.fileUrl) {
      const absoluteUrl = toAbsoluteUrl(message.fileUrl);
      if (absoluteUrl) {
        setAudioSrc(absoluteUrl);
        hasDecryptedSuccessfully.current = true; // ✅ KUNCI STATUS SUKSES!
      } else {
        setError(t('media.invalid_audio_url'));
      }
    }

    return () => {
      isMounted = false;
      // Jangan revoke URL jika komponen hanya re-render (misal karena parent Virtuoso).
      if (objectUrl && !hasDecryptedSuccessfully.current) {
          URL.revokeObjectURL(objectUrl);
      }
    };
  // ✅ OPTIMASI: Bersihkan dependency array, hapus message.content karena tidak relevan dengan dekripsi URL
  }, [message.fileUrl, message.fileType, message.fileKey, message.isBlindAttachment, lastKeychainUpdate, t]);

  // Clean up Object URL when the component completely unmounts from the DOM
  useEffect(() => {
    return () => {
       if (audioSrc && audioSrc.startsWith('blob:')) {
           URL.revokeObjectURL(audioSrc);
       }
    };
  }, [audioSrc]);


  // 2. Initialize WaveSurfer once we have the audioSrc
  useEffect(() => {
    if (!containerRef.current || !audioSrc) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#4f46e5', // Brand accent color
      progressColor: '#818cf8', // Lighter accent for played portion
      cursorColor: 'transparent',
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      height: 32,
      url: audioSrc,
    });

    wavesurferRef.current = ws;

    ws.on('ready', () => {
      setDuration(ws.getDuration());
      setIsReady(true);
    });

    ws.on('audioprocess', () => {
      setCurrentTime(ws.getCurrentTime());
    });

    ws.on('interaction', () => {
      setCurrentTime(ws.getCurrentTime());
    });

    // CRITICAL FIX: Let WaveSurfer dictate the React state, not the other way around.
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    
    ws.on('finish', () => {
      setIsPlaying(false);
      setCurrentTime(0);
      ws.seekTo(0); // Reset visual cursor to beginning
    });

    return () => {
      ws.destroy();
    };
  }, [audioSrc]);

  const togglePlay = async () => {
    if (wavesurferRef.current) {
      try {
        if (wavesurferRef.current.isPlaying()) {
          wavesurferRef.current.pause();
        } else {
          await wavesurferRef.current.play();
        }
      } catch (e) {
        console.error("Playback failed:", e);
      }
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return '0:00';
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 w-full max-w-[280px] h-[60px] bg-bg-main/50 p-2 rounded-2xl border border-white/5">
        <Spinner size="sm" />
        <span className="text-sm text-text-secondary">{t('media.decrypting')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 w-full max-w-[280px] p-3 bg-destructive/10 rounded-2xl border border-destructive/20">
        <FiAlertTriangle className="text-destructive flex-shrink-0" />
        <p className="text-xs text-destructive italic line-clamp-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 w-[240px] sm:w-[280px] bg-bg-main/50 p-2 rounded-2xl border border-white/5 shadow-inner">
      <button 
        onClick={togglePlay} 
        disabled={!isReady}
        className="w-10 h-10 flex-shrink-0 rounded-full bg-accent text-white flex items-center justify-center disabled:opacity-50 hover:bg-indigo-600 transition-colors shadow-md active:scale-95"
      >
        {isPlaying ? <FiPause size={18} /> : <FiPlay size={18} className="ml-1" />}
      </button>
      
      <div className="flex-1 flex flex-col justify-center overflow-hidden cursor-pointer">
        {/* Waveform Container */}
        <div ref={containerRef} className="w-full relative z-10" />
        
        {/* Timers */}
        <div className="text-[10px] text-text-secondary mt-1 flex justify-between font-mono font-medium">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(message.duration || duration)}</span>
        </div>
      </div>
    </div>
  );
};

export default memo(VoiceMessagePlayer);
