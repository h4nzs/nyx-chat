import { useEffect, useState } from "react";
import { Message, MessageStatus } from "@store/conversation";
import { useAuthStore } from "@store/auth";
import classNames from "classnames";
import { FaCheck, FaCheckDouble } from "react-icons/fa";
import { FiClock } from "react-icons/fi";
import FileAttachment from "./FileAttachment";
import LinkPreviewCard from "./LinkPreviewCard";
import LazyImage from "./LazyImage";
import { useModalStore } from "@store/modal";
import { useMessageStore } from "@store/message";
import { toAbsoluteUrl } from "@utils/url";
import { formatTime } from "@utils/date";
import MarkdownMessage from "./MarkdownMessage";

interface Props {
  message: Message;
  isOwn: boolean;
  isGroup: boolean;
  showAvatar: boolean;
  showName: boolean;
  onImageClick?: (message: Message) => void;
}

export default function MessageBubble({ message, isOwn, isGroup, showAvatar, showName, onImageClick }: Props) {
  const { user } = useAuthStore();
  const openProfileModal = useModalStore(state => state.openProfileModal);
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

  const handleAvatarClick = () => {
    if (message.sender) {
      openProfileModal(message.sender.id);
    }
  };

  const getStatusIcon = () => {
    if (!isOwn) return null;
    const statuses = message.statuses || [];
    const readCount = statuses.filter((s: MessageStatus) => s.status === 'READ' && s.userId !== user?.id).length;
    const deliveredCount = statuses.filter((s: MessageStatus) => s.status === 'DELIVERED').length;

    if (readCount > 0) return <FaCheckDouble className="text-white/90 text-[10px]" />;
    if (deliveredCount > 0) return <FaCheckDouble className="text-white/60 text-[10px]" />;
    return <FaCheck className="text-white/60 text-[10px]" />;
  };

  const isFile = !!message.fileUrl || !!message.fileKey;
  const isImage = message.fileType?.startsWith('image/');
  const isDeleted = !!message.deletedAt;

  return (
    <div 
      className={classNames("flex items-end gap-3 group mb-3", { 
        "justify-end": isOwn, 
        "justify-start": !isOwn 
      })}
    >
      {/* Avatar (Left - Peer) */}
      {!isOwn && (
        <div className="w-8 h-8 flex-shrink-0">
          {showAvatar && message.sender ? (
            <img
              src={toAbsoluteUrl(message.sender.avatarUrl)}
              alt={message.sender.username}
              onClick={handleAvatarClick}
              className="
                w-8 h-8 rounded-full object-cover cursor-pointer 
                shadow-neumorphic-convex hover:scale-105 transition-transform
              "
            />
          ) : (
            <div className="w-8"></div> 
          )}
        </div>
      )}

      {/* Bubble Container */}
      <div className={classNames("relative max-w-[85%] sm:max-w-[70%]", { "items-end": isOwn, "items-start": !isOwn })}>
        
        {/* Sender Name (Group) */}
        {!isOwn && isGroup && showName && message.sender && (
          <span 
            onClick={handleAvatarClick}
            className="text-[10px] font-bold text-accent ml-3 mb-1 block cursor-pointer hover:underline uppercase tracking-wide"
          >
            {message.sender.name || message.sender.username}
          </span>
        )}

        {/* Bubble Body */}
        <div
          className={classNames(
            "relative px-4 py-3 text-sm break-words transition-all shadow-neumorphic-convex",
            {
              // Own Message
              "bg-accent text-white rounded-2xl rounded-tr-none": isOwn && !isDeleted,
              
              // Peer Message
              "bg-bg-surface text-text-primary rounded-2xl rounded-tl-none border border-black/5 dark:border-white/5": !isOwn && !isDeleted,
              
              // Deleted Message
              "bg-bg-main text-text-secondary rounded-xl shadow-neumorphic-concave italic text-xs py-2 px-3": isDeleted,
              
              "p-1": isImage && !message.content, 
            }
          )}
        >
          {/* Reply Context */}
          {message.repliedTo && (
            <div className={classNames("mb-2 p-2 rounded-lg text-xs border-l-2 cursor-pointer bg-black/5 dark:bg-white/5", {
              "border-white/50 text-white/90": isOwn,
              "border-accent text-text-secondary": !isOwn
            })}>
              <p className="font-bold uppercase tracking-wider text-[10px]">{message.repliedTo.sender?.username || 'Unknown'}</p>
              <p className="truncate opacity-80">{message.repliedTo.content || 'Attachment'}</p>
            </div>
          )}

          {/* Content */}
          {isDeleted ? (
            <span className="flex items-center gap-2 opacity-60">
              🚫 Message deleted
            </span>
          ) : (
            <>
              {isFile && (
                isImage ? (
                  <LazyImage 
                    message={message} 
                    alt="Attachment"
                    className="rounded-xl max-h-64 w-auto object-cover cursor-pointer mb-1 hover:opacity-95"
                    onClick={() => onImageClick?.(message)}
                  />
                ) : (
                  <FileAttachment 
                    message={message} 
                    isOwn={isOwn} 
                  />
                )
              )}
              
              {message.content && (
                <div className={classNames("markdown-content leading-relaxed", { "text-white drop-shadow-sm": isOwn, "text-text-primary": !isOwn })}>
                  <MarkdownMessage content={message.content} />
                </div>
              )}

              {message.linkPreview && !isFile && (
                <div className="mt-2">
                  <LinkPreviewCard preview={message.linkPreview} />
                </div>
              )}
            </>
          )}

          {/* Metadata Footer */}
          <div className={classNames("flex items-center gap-1.5 justify-end mt-1.5 select-none", {
            "text-white/80": isOwn,
            "text-text-secondary": !isOwn,
            "absolute bottom-2 right-2 bg-black/40 backdrop-blur-sm px-1.5 py-0.5 rounded text-white shadow-sm": isImage && !message.content 
          })}>
            {timeLeft && (
              <span className="flex items-center gap-1 text-[9px] font-bold text-red-500 bg-red-500/10 px-1 rounded animate-pulse">
                <FiClock size={10} /> {timeLeft}
              </span>
            )}
            <span className="text-[9px] font-medium tracking-wide opacity-80">{formatTime(message.createdAt)}</span>
            {isOwn && !isDeleted && getStatusIcon()}
          </div>
        </div>
      </div>
    </div>
  );
}