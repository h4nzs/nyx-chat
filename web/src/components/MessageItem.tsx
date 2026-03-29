import { memo, useEffect, useRef, useState } from "react";
import type { Message, Conversation, Participant, MessageStatus } from "@store/conversation";
import { useAuthStore } from "@store/auth";
import { useMessageInputStore } from "@store/messageInput";
import { getSocket } from "@lib/socket";
import { api } from "@lib/api";
import { toAbsoluteUrl } from "@utils/url";
import { useModalStore } from '@store/modal';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiRefreshCw, FiShield, FiCopy, FiTrash2, FiCornerUpLeft, FiClock, FiInfo, FiEdit2, FiCheckSquare, FiCheck, FiPaperclip, FiLock, FiAlertTriangle } from 'react-icons/fi';
import { getUserColor } from '@utils/color';
import { FaCheck, FaCheckDouble } from 'react-icons/fa';
import { useMessageStore } from '@store/message';
import { useShallow } from 'zustand/react/shallow';
import toast from 'react-hot-toast';
import MessageBubble from "./MessageBubble";
import { useUserProfile } from '@hooks/useUserProfile';
import SwipeableItem from "./SwipeableItem";
import { useContextMenuStore } from "../store/contextMenu";
import { useTranslation } from "react-i18next";

const MessageStatusIcon = ({ message, participants }: { message: Message; participants: Participant[] }) => {
  const meId = useAuthStore((s) => s.user?.id);
  const retrySendMessage = useMessageInputStore(s => s.retrySendMessage);
  const { t } = useTranslation('chat');
  
  if (message.senderId !== meId) return null;
  
  if (message.status === 'FAILED' || message.error) {
    return (
      <button onClick={() => retrySendMessage(message)} title={t('messages.failed_retry')}>
        <FiRefreshCw className="text-red-500 cursor-pointer" size={14} />
      </button>
    );
  }

  if (message.status === 'SENDING' || message.optimistic) {
     return <FiClock size={14} className="text-text-secondary opacity-70" />;
  }

  const otherParticipants = participants.filter((p: Participant) => p.id !== meId) || [];
  if (otherParticipants.length === 0) return <FaCheck size={14} className="text-text-secondary" />;
  
  const statuses = message.statuses || [];
  const isReadAll = otherParticipants.every((p: Participant) => statuses.some((s: MessageStatus) => s.userId === p.id && s.status === 'READ'));
  if (isReadAll) return <FaCheckDouble size={14} className="text-blue-500" />;
  
  const isDeliveredAll = otherParticipants.every((p: Participant) => statuses.some((s: MessageStatus) => s.userId === p.id && s.status === 'DELIVERED'));
  if (isDeliveredAll) return <FaCheckDouble size={14} className="text-text-secondary" />;
  
  return <FaCheck size={14} className="text-text-secondary" />;
};

const ReactionsDisplay = ({ reactions }: { reactions: Message['reactions'] }) => {
  if (!reactions || reactions.length === 0) return null;
  const grouped = reactions.reduce((acc, r: { emoji: string; }) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return (
    <div className="flex gap-1 mt-1.5">
      {Object.entries(grouped).map(([emoji, count]) => (
        <span key={emoji} className="px-2 py-0.5 rounded-full bg-bg-surface/80 text-text-primary text-xs cursor-default">
          {emoji} {count > 1 ? count : ''}
        </span>
      ))}
    </div>
  );
};

interface MessageItemProps {
  message: Message;
  isGroup: boolean;
  participants: Participant[];
  isHighlighted?: boolean;
  onImageClick: (message: Message) => void;
  isFirstInSequence: boolean;
  isLastInSequence: boolean;
}

const MessageItem = ({ message, isGroup, participants, isHighlighted, onImageClick, isFirstInSequence, isLastInSequence }: MessageItemProps) => {
  const { t } = useTranslation(['chat', 'common']);
  const meId = useAuthStore((s) => s.user?.id);
  const setReplyingTo = useMessageInputStore(state => state.setReplyingTo);
  const setEditingMessage = useMessageInputStore(state => state.setEditingMessage);
  const showConfirm = useModalStore(state => state.showConfirm);
  const { selectedMessageIds, toggleMessageSelection, removeMessage, addOptimisticMessage, sendReaction, removeLocalReaction } = useMessageStore(useShallow(s => ({
      selectedMessageIds: s.selectedMessageIds,
      toggleMessageSelection: s.toggleMessageSelection,
      removeMessage: s.removeMessage,
      addOptimisticMessage: s.addOptimisticMessage,
      sendReaction: s.sendReaction,
      removeLocalReaction: s.removeLocalReaction
  })));
  const user = useAuthStore(useShallow((s) => s.user));

  const isSelectionMode = selectedMessageIds.length > 0;
  const isSelected = selectedMessageIds.includes(message.id);

  const profile = useUserProfile(message.sender as { id: string; encryptedProfile?: string | null });
  const mine = message.senderId === meId;
  const ref = useRef<HTMLDivElement>(null);
  const openMenu = useContextMenuStore(s => s.openMenu);

  useEffect(() => {
    if (!ref.current || mine) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        const alreadyRead = message.statuses?.some((s: MessageStatus) => s.userId === meId && s.status === 'READ');
        if (!alreadyRead) {
          getSocket().emit('message:mark_as_read', { messageId: message.id, conversationId: message.conversationId });
        }
        observer.disconnect();
      }
    }, { threshold: 0.8 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [message.id, message.conversationId, mine, meId, message.statuses]);

  if (message.type === 'SYSTEM' || message.content?.startsWith('You sent') || message.content?.startsWith('Secure session') || message.content?.startsWith('System')) {
    const getSystemIcon = (text: string) => {
      const lowerText = text.toLowerCase();
      if (lowerText.includes('encrypt') || lowerText.includes('decrypt') || lowerText.includes('key')) return <FiLock size={12} className="text-emerald-500" />;
      if (lowerText.includes('file') || lowerText.includes('attachment')) return <FiPaperclip size={12} className="text-blue-400" />;
      if (lowerText.includes('restart') || lowerText.includes('sync')) return <FiRefreshCw size={12} className="text-blue-500" />;
      if (lowerText.includes('error') || lowerText.includes('failed')) return <FiAlertTriangle size={12} className="text-red-500" />;
      return <FiInfo size={12} className="text-text-secondary" />;
    };

    const isError = message.content?.includes('Error') || message.content?.includes('Unreadable') || message.content?.includes('Key out of sync');
    const isDesyncError = message.content?.includes('Key out of sync');

    return (
      <div className="flex justify-center my-4 w-full">
        <div className="flex flex-col items-center gap-2">
          <div className={clsx(
            "flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium shadow-neu-pressed-dark border border-white/5",
            isError 
              ? "bg-red-500/10 text-red-500" 
              : "bg-black/20 text-text-secondary"
          )}>
            {getSystemIcon(message.content || '')}
            <span>{message.content}</span>
          </div>
          
          {isDesyncError && (
              <button 
                  onClick={() => useMessageStore.getState().repairSecureSession(message.conversationId, isGroup)}
                  className="text-[10px] text-blue-500 hover:text-blue-400 font-bold bg-blue-500/10 hover:bg-blue-500/20 px-3 py-1.5 rounded-lg transition-colors uppercase tracking-wide"
              >
                  {t('chat:messages.repair_session')}
              </button>
          )}
        </div>
      </div>
    );
  }

  const handleDelete = () => {
    showConfirm(
      t('chat:actions.delete_message_title'), 
      t('chat:actions.delete_message_desc'), 
      () => {
      // 1. Hapus dari UI dan Local Vault secara instan
      removeMessage(message.conversationId, message.id);

      // Hanya kirim instruksi hapus ke server dan lawan bicara JIKA ini pesan milik kita
      if (mine) {
          const socket = getSocket();
          if (socket?.connected) {
              // 2. Beritahu Server untuk memusnahkannya (jika pesan masih nyangkut/belum dibaca)
              socket.emit("message:unsend", { messageId: message.id, conversationId: message.conversationId });

              // 3. E2EE TOMBSTONE: Kirim sinyal terenkripsi ke lawan bicara agar mereka menghapusnya dari IndexedDB mereka
              const unsendPayload = { type: "UNSEND", targetMessageId: message.id };
              useMessageStore.getState().sendMessage(message.conversationId, {
                  content: JSON.stringify(unsendPayload),
                  isSilent: true
              });
          }
      }

      // 4. Bersihkan file dari Cloudflare R2 (Storage) jika ini adalah file gambar/media
      let query = '';
      let targetUrl = message.fileUrl;
      try {
          if (message.content && message.content.startsWith('{')) {
              const metadata = JSON.parse(message.content);
              if (metadata.url) targetUrl = metadata.url;
          }
      } catch (e) {}

      if (targetUrl && !targetUrl.startsWith('blob:')) {
          try {
              const url = new URL(targetUrl);
              const key = url.pathname.substring(1);
              if (key) query = `?r2Key=${encodeURIComponent(key)}`;
              // Panggil API hanya untuk hapus objek storage, bukan hapus pesan DB
              api(`/api/uploads/file${query}`, { method: 'DELETE' }).catch(() => {});
          } catch (e) {
              console.error("Failed to parse file URL for deletion:", e);
          }
      }
    });
  };

  const handleClick = (e: React.MouseEvent) => {
    if (isSelectionMode) {
        e.preventDefault();
        e.stopPropagation();
        toggleMessageSelection(message.id);
    }
  };

  if (message.isDeletedLocal || message.deletedAt || message.content === "[This message was deleted]") {
    return (
      <div ref={ref} className={`flex items-center p-2 ${mine ? 'justify-end' : 'justify-start'}`}>
        <div className="flex items-center gap-2 text-xs italic text-text-secondary bg-bg-surface px-3 py-1.5 rounded-xl border border-white/5 shadow-sm">
           <FiTrash2 size={12} />
           <span>{t('chat:messages.message_deleted')}</span>
        </div>
      </div>
    );
  }

  const reactToMessage = async (emoji: string) => {
    if (!user) return;
    const userReaction = message.reactions?.find(r => r.userId === user.id);
    
    // SKENARIO 1: Pengguna mengklik emoji yang sama (HAPUS REAKSI)
    if (userReaction?.emoji === emoji) {
      removeLocalReaction(message.conversationId, message.id, userReaction.id);
      
      // E2EE Tombstone: Kirim sinyal hapus reaksi ke lawan bicara
      const removeReactPayload = { type: "reaction_remove", targetMessageId: message.id, emoji: emoji };
      useMessageStore.getState().sendMessage(message.conversationId, {
          content: JSON.stringify(removeReactPayload),
          isSilent: true
      });
      return;
    }

    // SKENARIO 2: Pengguna mengganti emoji (HAPUS YANG LAMA DULU)
    if (userReaction) {
        removeLocalReaction(message.conversationId, message.id, userReaction.id);
        const removeReactPayload = { type: "reaction_remove", targetMessageId: message.id, emoji: userReaction.emoji };
        useMessageStore.getState().sendMessage(message.conversationId, {
            content: JSON.stringify(removeReactPayload),
            isSilent: true
        });
    }

    // SKENARIO 3: Kirim Reaksi Baru
    try {
        await sendReaction(message.conversationId, message.id, emoji);
    } catch (e) {
        console.error("Failed to send reaction:", e);
    }
  };

  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (isSelectionMode) return;
    
    // BLACK OPS: Temporarily store this specific message's reaction handler globally
    // so the expanded EmojiPicker in ContextMenu can access it.
    (window as { currentReactionHandler?: (emoji: string) => void }).currentReactionHandler = reactToMessage;

    // Limit edit window to 5 minutes (300,000 ms)
    const isWithinEditWindow = (Date.now() - new Date(message.createdAt).getTime()) < 5 * 60 * 1000;
    
    const isEditable = mine && 
                       !message.optimistic && 
                       !message.fileUrl && 
                       !message.type && 
                       !message.content?.startsWith('{') && 
                       !message.content?.startsWith('[') &&
                       isWithinEditWindow;

    openMenu(e, [
      { label: t('chat:actions.reply'), icon: <FiCornerUpLeft />, onClick: () => setReplyingTo(message) },
      { label: t('chat:actions.select'), icon: <FiCheckSquare />, onClick: () => toggleMessageSelection(message.id) },
      ...(isEditable ? [{ label: t('chat:actions.edit'), icon: <FiEdit2 />, onClick: () => setEditingMessage(message) }] : []),
      { label: t('chat:actions.copy_text'), icon: <FiCopy />, onClick: () => navigator.clipboard.writeText(message.content || '') },
      { label: t('chat:actions.security_info'), icon: <FiShield />, onClick: () => toast(t('chat:messages.security_info')) },
      { label: t('chat:actions.copy_id'), icon: <FiInfo />, onClick: () => navigator.clipboard.writeText(message.id) },
      ...(mine && !message.optimistic ? [{ label: t('chat:actions.delete'), icon: <FiTrash2 />, destructive: true, onClick: handleDelete }] : [])
    ], [
      { emoji: '👍', onClick: () => reactToMessage('👍') },
      { emoji: '❤️', onClick: () => reactToMessage('❤️') },
      { emoji: '😂', onClick: () => reactToMessage('😂') },
      { emoji: '😮', onClick: () => reactToMessage('😮') },
      { emoji: '😢', onClick: () => reactToMessage('😢') },
    ]);
  };

  return (
    <motion.div ref={ref} id={`msg-${message.id}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: 'easeOut' }} className={clsx('group flex flex-col', isFirstInSequence ? 'mt-3' : 'mt-1', mine ? 'items-end' : 'items-start', isHighlighted && 'bg-accent/10 rounded-lg p-1 -mx-1')}>
      <SwipeableItem 
        leftAction={{ icon: <FiCornerUpLeft size={20} />, color: 'bg-blue-500/80', onAction: () => setReplyingTo(message) }}
        rightAction={{ icon: <FiInfo size={20} />, color: 'bg-bg-surface/80', onAction: () => toast(t('chat:messages.message_id_toast', { id: message.id })) }}
      >
        <div onContextMenu={handleContextMenu} onClick={handleClick} className={`flex items-end gap-2 w-full select-none ${mine ? 'flex-row-reverse justify-start' : 'flex-row justify-start'}`}>
          {isSelectionMode && (
              <div className="flex items-center justify-center px-2 cursor-pointer z-10 transition-all">
                <div className={clsx(
                    "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shadow-sm", 
                    isSelected ? "bg-accent border-accent" : "border-text-secondary/50 bg-black/20"
                )}>
                    {isSelected && <FiCheck size={14} className="text-white" />}
                </div>
              </div>
          )}
          {!mine && (
            <div className="w-8 flex-shrink-0 mb-1 self-end">
              {isLastInSequence && (
                <img 
                  src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name || t('common:defaults.user')}`} 
                  alt={t('common:defaults.avatar', 'Avatar')} 
                  className="w-8 h-8 rounded-full bg-secondary object-cover shadow-sm cursor-pointer hover:scale-105 transition-transform pointer-events-auto" 
                />
              )}
            </div>
          )}
          
          <div className={clsx("flex flex-col max-w-[85%] sm:max-w-[70%]", mine ? "items-end" : "items-start")}>
            {!mine && isGroup && profile.name && isFirstInSequence && (
              <p className="text-[10px] font-bold mb-1 ml-1 user-color-name cursor-pointer hover:underline uppercase tracking-wide pointer-events-auto" style={{ '--user-color': getUserColor(message.senderId) } as React.CSSProperties}>
                {profile.name || t('common:defaults.user')}
              </p>
            )}
            
            <div className="pointer-events-auto w-full flex items-end gap-1">
              <MessageBubble 
                message={message} 
                isOwn={mine} 
                onImageClick={onImageClick}
                isLastInSequence={isLastInSequence}
              />
              <div className="flex-shrink-0 mb-1">
                  <MessageStatusIcon message={message} participants={participants} />
              </div>
            </div>
            
            <ReactionsDisplay reactions={message.reactions} />
          </div>
        </div>
      </SwipeableItem>
    </motion.div>
  );
};

export default memo(MessageItem);
