import { useEffect, useState } from "react";
import { Message, MessageStatus } from "@store/conversation";
import { useAuthStore } from "@store/auth";
import classNames from "classnames";
import { FaCheck, FaCheckDouble } from "react-icons/fa";
import { FiClock } from "react-icons/fi";
import FileAttachment from "./FileAttachment";
import LinkPreviewCard from "./LinkPreviewCard";
import LazyImage from "./LazyImage";
import { useMessageStore } from "@store/message";
import { formatTime } from "@utils/date";
import MarkdownMessage from "./MarkdownMessage";
import VoiceMessagePlayer from "./VoiceMessagePlayer";
import clsx from 'clsx'; 
import { useUserProfile } from '@hooks/useUserProfile';

const ReplyQuote = ({ message }: { message: Message }) => {
  const profile = useUserProfile(message.sender as any);
  const authorName = profile.name;
  let contentPreview: string;
  if (message.duration) contentPreview = 'Voice Message';
  else if (message.fileName) contentPreview = message.fileName;
  else if (message.fileUrl) contentPreview = 'File';
  else contentPreview = message.content || '...';
  return (
    <div className="mb-1.5 p-2 rounded-lg bg-black/20 border-l-4 border-accent/50">
      <p className="text-xs font-bold text-accent/80">{authorName}</p>
      <div className="text-text-primary/70 truncate text-sm">
        <MarkdownMessage content={contentPreview} />
      </div>
    </div>
  );
};

interface Props {
  message: Message;
  isOwn: boolean;
  // Props lain seperti showAvatar, showName, isGroup tidak lagi dipakai di sini
  // karena Bubble ini hanya merender kontennya saja.
  onImageClick?: (message: Message) => void;
  isLastInSequence?: boolean;
  participants?: any[];
}

export default function MessageBubble({ message, isOwn, onImageClick, isLastInSequence = true, participants = [] }: Props) {
  const { user } = useAuthStore();
  const [timeLeft, setTimeLeft] = useState<string | null>(null);

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
        useMessageStore.getState().removeMessage(message.conversationId, message.id);
        setTimeLeft(null);
      } else {
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        
        if (hours > 0) {
           setTimeLeft(`${hours}h ${minutes}m`);
        } else if (minutes > 0) {
           setTimeLeft(`${minutes}m ${seconds}s`);
        } else {
           setTimeLeft(`${seconds}s`);
        }
      }
    };

    checkExpiration();
    const interval = setInterval(checkExpiration, 1000);
    return () => clearInterval(interval);
  }, [message.expiresAt, message.deletedAt, message.id, message.conversationId]);

  const getStatusIcon = () => {
    if (!isOwn) return null;
    const statuses = message.statuses || [];
    
    // Logic from original code: check if read by ANYONE other than self
    const readCount = statuses.filter((s: MessageStatus) => s.status === 'READ' && s.userId !== user?.id).length;
    const deliveredCount = statuses.filter((s: MessageStatus) => s.status === 'DELIVERED').length;

    // Restore green color for Read status
    if (readCount > 0) return <FaCheckDouble size={14} className="text-green-400" />;
    if (deliveredCount > 0) return <FaCheckDouble size={14} className="text-white/70" />;
    return <FaCheck size={14} className="text-white/70" />;
  };

  const content = message.content || '';
  const isPlaceholder = content === 'waiting_for_key' || content.startsWith('[') || content === 'Decryption failed';
  const isImage = message.fileType?.startsWith('image/');
  const isVoiceMessage = message.fileType?.startsWith('audio/webm');
  const isDeleted = !!message.deletedAt;

  const hasBubbleStyle = !isPlaceholder && !message.fileUrl || message.fileUrl && !isImage && !isVoiceMessage;

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
      
      {isDeleted ? (
        <span className="flex items-center gap-2 opacity-60">
          🚫 Message deleted
        </span>
      ) : (
        <>
          {isVoiceMessage && message.fileUrl && (
            <div className="p-2 w-[250px]">
              <VoiceMessagePlayer message={message} />
            </div>
          )}
          
          {message.fileUrl && isImage && (
            <button onClick={() => onImageClick?.(message)} className="block w-full">
              <LazyImage 
                message={message} 
                alt={message.fileName || 'Image attachment'} 
                className="rounded-lg max-h-80 w-full object-cover cursor-pointer hover:opacity-95" 
              />
            </button>
          )}
          
          {message.fileUrl && !isImage && !isVoiceMessage && (
            <FileAttachment message={message} isOwn={isOwn} />
          )}
          
          {!message.fileUrl && (
            isPlaceholder ? (
              <p className="text-base whitespace-pre-wrap break-words italic text-text-secondary">{content}</p>
            ) : (
              <div className={classNames("text-base whitespace-pre-wrap break-words", { "text-white/95": isOwn, "text-text-primary": !isOwn })}>
                <MarkdownMessage content={content} />
              </div>
            )
          )}

          {message.linkPreview && !message.fileUrl && (
            <div className="mt-2">
              <LinkPreviewCard preview={message.linkPreview} />
            </div>
          )}
        </>
      )}

      {/* Metadata Footer */}
      <div className={clsx("text-xs mt-1.5 flex items-center gap-1.5 select-none", {
        "absolute bottom-2 right-2 bg-black/40 backdrop-blur-sm px-1.5 py-0.5 rounded text-white shadow-sm": isImage && !message.content,
        "justify-end": !isImage || message.content,
        "text-white/80": isOwn && (!isImage || message.content), // Fix contrast for own messages
        "text-text-secondary/80": !isOwn && (!isImage || message.content)
      })}>
        {timeLeft && (
          <span className="flex items-center gap-1 text-[9px] font-bold text-red-500 bg-red-500/10 px-1 rounded animate-pulse mr-1">
            <FiClock size={10} /> {timeLeft}
          </span>
        )}
        <span className="text-[10px] font-medium tracking-wide opacity-90">{formatTime(message.createdAt)}</span>
        {isOwn && !isDeleted && getStatusIcon()}
      </div>
    </div>
  );
}
