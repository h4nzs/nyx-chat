import { useEffect, useState } from "react";
import { Message, MessageStatus } from "@store/conversation";
import { useAuthStore } from "@store/auth";
import { FaCheck, FaCheckDouble } from "react-icons/fa";
import { FiClock, FiEyeOff, FiCamera, FiVideo, FiMic, FiEye, FiVolumeX } from "react-icons/fi";
import FileAttachment from "./FileAttachment";
import LinkPreviewCard from "./LinkPreviewCard";
import LazyImage from "./LazyImage";
import { formatTime } from "@utils/date";
import MarkdownMessage from "./MarkdownMessage";
import VoiceMessagePlayer from "./VoiceMessagePlayer";
import clsx from 'clsx'; 
import { useUserProfile } from '@hooks/useUserProfile';
import { useSettingsStore } from '@store/settings';
import { useMessageStore } from "@store/message";
import { useTranslation } from 'react-i18next';

const ReplyQuote = ({ message }: { message: Message }) => {
  const profile = useUserProfile(message.sender as { id: string; encryptedProfile?: string | null });
  const currentUser = useAuthStore.getState().user;
  const isMe = message.senderId === currentUser?.id;
  const authorName = isMe ? 'You' : (profile.name || 'Unknown');
  let contentPreview: string;
  
  if (message.duration) contentPreview = 'Voice Message';
  else if (message.fileName) contentPreview = message.fileName;
  else if (message.fileUrl) contentPreview = 'File';
  else contentPreview = message.content || '...';
  
  return (
    <div className="mb-1.5 p-2 rounded-lg bg-black/20 border-l-4 border-accent/50">
      <p className="text-xs font-bold text-accent/80">{authorName}</p>
      <div className="text-text-primary/70 truncate text-sm">
        <MarkdownMessage content={contentPreview} isOwn={isMe} />
      </div>
    </div>
  );
};

interface Props {
  message: Message;
  isOwn: boolean;
  onImageClick?: (message: Message) => void;
  isLastInSequence?: boolean;
}

// ✅ OPTIMASI: Hapus 'participants' dari props jika tidak digunakan
export default function MessageBubble({ message, isOwn, onImageClick, isLastInSequence = true }: Props) {
  const { t } = useTranslation('chat');
  // Ambil ID saja secara statis untuk menghindari re-render berlebih
  const myId = useAuthStore.getState().user?.id; 
  
  const privacyCloak = useSettingsStore(s => s.privacyCloak);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [isTextExpanded, setIsTextExpanded] = useState(false);

  const content = message.content || '';
  const isLongMessage = content.length > 800 || content.split('\n').length > 12;
  const isPlaceholder = content === 'waiting_for_key' || content.startsWith('[') || content === 'Decryption failed';

  const cloakClass = privacyCloak ? "blur-[6px] opacity-75 hover:blur-none hover:opacity-100 active:blur-none active:opacity-100 transition-all duration-300 select-none" : "";

  // ✅ OPTIMASI TIMER: Hitung mundur dengan sangat pelan (setiap 60 detik) 
  // atau biarkan backend / efek global yang menghapus pesannya.
  useEffect(() => {
    if (!message.expiresAt || message.deletedAt) {
      setTimeLeft(null);
      return;
    }

    const checkExpiration = () => {
      const expireTime = new Date(message.expiresAt!).getTime();
      const now = Date.now();
      const diff = expireTime - now;

      if (diff <= 0) {
        // Jika sudah habis, minta store untuk menghapusnya
        useMessageStore.getState().removeMessage(message.conversationId, message.id);
        setTimeLeft(null);
      } else {
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        
        // Jangan render detik untuk menghemat CPU
        if (hours > 0) {
           setTimeLeft(`${hours}h ${minutes}m`);
        } else if (minutes > 0) {
           setTimeLeft(`${minutes}m`);
        } else {
           setTimeLeft(`< 1m`);
        }
      }
    };

    checkExpiration(); // Jalankan sekali saat render
    
    // Perbarui hanya setiap 1 Menit (60.000 ms), bukan setiap 1 detik (1.000 ms)!
    const interval = setInterval(checkExpiration, 30000); 
    return () => clearInterval(interval);
  }, [message.expiresAt, message.deletedAt, message.id, message.conversationId]);

  const getStatusIcon = () => {
    if (!isOwn) return null;
    const statuses = message.statuses || [];
    
    const readCount = statuses.filter((s: MessageStatus) => s.status === 'READ' && s.userId !== myId).length;
    const deliveredCount = statuses.filter((s: MessageStatus) => s.status === 'DELIVERED').length;

    if (readCount > 0) return <FaCheckDouble size={14} className="text-green-400" />;
    if (deliveredCount > 0) return <FaCheckDouble size={14} className="text-white/70" />;
    return <FaCheck size={14} className="text-white/70" />;
  };

  const isImage = message.fileType?.startsWith('image/');
  const isVoiceMessage = message.fileType?.startsWith('audio/webm');
  const isDeleted = !!message.deletedAt;

  const hasBubbleStyle = !isPlaceholder && (!message.fileUrl || (message.fileUrl && !isImage && !isVoiceMessage));

  const bubbleClasses = clsx(
    'relative max-w-md md:max-w-lg shadow-neumorphic-bubble rounded-2xl',
    {
      'px-4 py-3': hasBubbleStyle,
      'bg-accent text-accent-foreground': isOwn && !isDeleted,
      'bg-bg-surface text-text-primary': !isOwn && !isDeleted,
      'bg-bg-main text-text-secondary rounded-xl shadow-neumorphic-concave italic text-xs py-2 px-3': isDeleted,
      'rounded-bl-2xl': isOwn, 'rounded-br-2xl': !isOwn,
      'rounded-br-sm': isOwn && isLastInSequence, 'rounded-bl-sm': !isOwn && isLastInSequence,
      'p-1': isImage && !message.content, 
    }
  );

  return (
    <div className={bubbleClasses}>
      {message.repliedTo && <ReplyQuote message={message.repliedTo} />}
      
      <div className={cloakClass}>
        {isDeleted ? (
          <span className="flex items-center gap-2 opacity-60">
            🚫 Message deleted
          </span>
        ) : (
          <>
            {/* ✅ FIX LOGIKA VIEW ONCE: Tidak perlu mensyaratkan message.fileUrl! */}
            {message.isViewOnce ? (
              <div className="p-3 bg-black/20 rounded-xl flex items-center justify-center min-w-[160px] my-1 mx-2 border border-white/5">
                {message.isViewed ? (
                  <div className="flex items-center gap-2 text-text-secondary/50 italic select-none">
                    <FiEyeOff size={18} />
                    <span className="text-sm font-medium">Opened</span>
                  </div>
                ) : (
                  <button 
                    onClick={() => onImageClick?.(message)} 
                    className="flex items-center gap-2 text-accent hover:text-indigo-400 hover:scale-105 active:scale-95 transition-all"
                  >
                    {message.fileType?.startsWith('video/') ? <FiVideo size={20} /> : 
                     message.fileType?.startsWith('audio/') ? <FiMic size={20} /> : 
                     message.fileUrl ? <FiCamera size={20} /> : <FiEye size={20} />}
                    <span className="text-sm font-bold tracking-wider uppercase">{t('messages.view_once', 'View Once')}</span>
                    </button>
                )}
              </div>
            ) : (
              <>
                {/* Rendering Konten Biasa */}
                {isVoiceMessage && message.fileUrl && (
                  <div className="p-2 w-[250px]">
                    <VoiceMessagePlayer message={message} />
                  </div>
                )}
                
                {message.fileUrl && isImage && (
                  <button onClick={() => onImageClick?.(message)} className="block w-full min-w-[200px] sm:min-w-[250px] relative">
                    <LazyImage 
                      message={message} 
                      alt={message.fileName || 'Image attachment'} 
                      className="rounded-lg max-h-[350px] w-full object-cover cursor-pointer hover:opacity-95" 
                    />
                  </button>
                )}
                
                {message.fileUrl && !isImage && !isVoiceMessage && (
                  <FileAttachment message={message} isOwn={isOwn} />
                )}

                {/* Text Content */}
                {!!content && (
                  <div className={message.fileUrl ? "mt-2" : ""}>
                    {isPlaceholder ? (
                      <p className="text-base whitespace-pre-wrap break-words italic text-text-secondary">{content}</p>
                    ) : (
                      <div className={clsx("text-base break-words w-full", { "text-white/95": isOwn, "text-text-primary": !isOwn })}>
                        <div 
                          className={clsx("relative overflow-hidden transition-all duration-300", {
                            "max-h-[250px]": isLongMessage && !isTextExpanded,
                            "max-h-none": !isLongMessage || isTextExpanded
                          })}
                          style={isLongMessage && !isTextExpanded ? { maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)' } : {}}
                        >
                          <MarkdownMessage content={content} isOwn={isOwn} />
                        </div>                  
                        
                        {isLongMessage && (
                          <button
                            onClick={() => setIsTextExpanded(!isTextExpanded)}
                            className={clsx("mt-2 text-xs font-bold uppercase tracking-wider block active:scale-95 transition-all", {
                              "text-white/80 hover:text-white": isOwn,
                              "text-accent hover:text-indigo-400": !isOwn
                            })}
                          >
                            {isTextExpanded ? "Show Less" : "Read More"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}


            {/* Link Preview (Berlaku untuk semua tipe pesan) */}
            {message.linkPreview && !message.fileUrl && !message.isViewOnce && (
              <div className="mt-2">
                <LinkPreviewCard preview={message.linkPreview as { url: string; title: string; description: string; image: string; siteName: string }} />
              </div>
            )}
          </>
        )}
      </div>

      {/* Metadata Footer */}
      <div className={clsx("text-xs mt-1.5 flex items-center gap-1.5 select-none", {
        "absolute bottom-2 right-2 bg-black/40 backdrop-blur-sm px-1.5 py-0.5 rounded text-white shadow-sm": isImage && !message.content && !message.isViewOnce,
        "justify-end": !isImage || message.content || message.isViewOnce,
        "text-white/80": isOwn && (!isImage || message.content || message.isViewOnce),
        "text-text-secondary/80": !isOwn && (!isImage || message.content || message.isViewOnce)
      })}>
        {message.isViewOnce && <FiEye size={12} className="opacity-70" />}
        {message.isSilent && <FiVolumeX size={12} className="opacity-60 text-text-secondary" title="Sent Silently" />}
        {timeLeft && (
          <span className="flex items-center gap-1 text-[9px] font-bold text-red-500 bg-red-500/10 px-1 rounded mr-1">
            <FiClock size={10} /> {timeLeft}
          </span>
        )}
        <span className="text-[10px] font-medium tracking-wide opacity-90">{formatTime(message.createdAt)}</span>
        {message.isEdited && <span className="opacity-70 italic text-[10px]">{t('messages.edited', '(edited)')}</span>}
        {isOwn && !isDeleted && getStatusIcon()}
      </div>
    </div>
  );
}
