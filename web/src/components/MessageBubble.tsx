import { Message } from "@store/conversation";
import { useAuthStore } from "@store/auth";
import classNames from "classnames";
import { FaCheck, FaCheckDouble } from "react-icons/fa";
import Reactions from "./Reactions";
import FileAttachment from "./FileAttachment";
import LinkPreviewCard from "./LinkPreviewCard";
import { useModalStore } from "@store/modal";
import { toAbsoluteUrl } from "@utils/url";
import { formatTime } from "@utils/date";
import MarkdownMessage from "./MarkdownMessage"; // Pastikan ini ada, atau ganti dengan div biasa

interface Props {
  message: Message;
  isOwn: boolean;
  isGroup: boolean;
  showAvatar: boolean;
  showName: boolean;
  // Opsional: tambahkan ini jika Anda menggunakan fitur Lightbox
  onImageClick?: (message: Message) => void;
}

export default function MessageBubble({ message, isOwn, isGroup, showAvatar, showName, onImageClick }: Props) {
  const { user } = useAuthStore();
  const openProfileModal = useModalStore(state => state.openProfileModal);

  const handleAvatarClick = () => {
    if (message.sender) {
      openProfileModal(message.sender.id);
    }
  };

  const getStatusIcon = () => {
    if (!isOwn) return null;
    const statuses = message.statuses || [];
    const readCount = statuses.filter(s => s.status === 'READ' && s.userId !== user?.id).length;
    const deliveredCount = statuses.filter(s => s.status === 'DELIVERED').length;

    if (readCount > 0) return <FaCheckDouble className="text-blue-500 text-[10px]" />;
    if (deliveredCount > 0) return <FaCheckDouble className="text-text-secondary text-[10px]" />;
    return <FaCheck className="text-text-secondary text-[10px]" />;
  };

  const isFile = !!message.fileUrl || !!message.fileKey;
  const isDeleted = !message.content && !isFile && !message.deletedAt;

  return (
    <div 
      className={classNames("flex items-end gap-2 group mb-1", { 
        "justify-end": isOwn, 
        "justify-start": !isOwn 
      })}
    >
      {/* Avatar (Kiri - untuk pesan orang lain) */}
      {!isOwn && (
        <div className="w-8 h-8 flex-shrink-0">
          {showAvatar && message.sender ? (
            <img
              src={toAbsoluteUrl(message.sender.avatarUrl)}
              alt={message.sender.username}
              onClick={handleAvatarClick}
              className="w-8 h-8 rounded-full object-cover cursor-pointer shadow-sm hover:opacity-80 transition-opacity"
            />
          ) : (
            <div className="w-8" /> 
          )}
        </div>
      )}

      {/* Bubble Container */}
      <div className={classNames("relative max-w-[75%] sm:max-w-[60%]", { "items-end": isOwn, "items-start": !isOwn })}>
        
        {/* Nama Pengirim (Grup) */}
        {!isOwn && isGroup && showName && message.sender && (
          <span 
            onClick={handleAvatarClick}
            className="text-xs text-text-secondary ml-1 mb-1 block cursor-pointer hover:underline"
          >
            {message.sender.name || message.sender.username}
          </span>
        )}

        {/* Bubble Body */}
        <div
          className={classNames(
            "relative px-4 py-2 rounded-2xl text-sm shadow-sm break-words",
            {
              "bg-accent text-white rounded-tr-sm": isOwn,
              "bg-bg-surface text-text-primary rounded-tl-sm": !isOwn,
              "italic text-text-secondary border border-border bg-transparent shadow-none": message.deletedAt,
            }
          )}
        >
          {/* Reply Context */}
          {message.repliedTo && (
            <div className={classNames("mb-2 p-2 rounded text-xs border-l-2 opacity-80 cursor-pointer", {
              "bg-white/20 border-white/50": isOwn,
              "bg-black/5 border-accent": !isOwn
            })}>
              <p className="font-bold">{message.repliedTo.sender?.username || 'Unknown'}</p>
              <p className="truncate">{message.repliedTo.content || 'Attachment'}</p>
            </div>
          )}

          {/* Content: File or Text */}
          {message.deletedAt ? (
            <span>🚫 Message deleted</span>
          ) : (
            <>
              {isFile && (
                <FileAttachment 
                  message={message} 
                  isOwn={isOwn} 
                  onImageClick={() => onImageClick?.(message)} 
                />
              )}
              
              {message.content && (
                <div className={classNames("markdown-content", { "text-white": isOwn, "text-text-primary": !isOwn })}>
                  {/* Gunakan MarkdownMessage jika ada, atau render langsung */}
                  {typeof MarkdownMessage !== 'undefined' ? (
                    <MarkdownMessage content={message.content} />
                  ) : (
                    message.content
                  )}
                </div>
              )}

              {message.linkPreview && !isFile && (
                <div className="mt-2">
                  <LinkPreviewCard preview={message.linkPreview} />
                </div>
              )}
            </>
          )}

          {/* Metadata: Waktu & Status */}
          <div className={classNames("flex items-center gap-1 justify-end mt-1 text-[10px]", {
            "text-white/70": isOwn,
            "text-text-secondary": !isOwn
          })}>
            <span>{formatTime(message.createdAt)}</span>
            {isOwn && !message.deletedAt && getStatusIcon()}
          </div>
        </div>

        {/* Reactions Display */}
        {message.reactions && message.reactions.length > 0 && (
          <div className={classNames("absolute -bottom-3 z-10", { "right-0": isOwn, "left-0": !isOwn })}>
            <Reactions reactions={message.reactions} currentUserId={user?.id} />
          </div>
        )}
      </div>
    </div>
  );
}