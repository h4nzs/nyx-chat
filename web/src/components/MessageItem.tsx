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
import { FiRefreshCw, FiShield, FiCopy, FiTrash2, FiCornerUpLeft, FiClock, FiInfo } from 'react-icons/fi';
import { getUserColor } from '@utils/color';
import { FaCheck, FaCheckDouble } from 'react-icons/fa';
import { useMessageStore } from '@store/message';
import toast from 'react-hot-toast';
import MessageBubble from "./MessageBubble";
import { useUserProfile } from '@hooks/useUserProfile';
import SwipeableItem from "./SwipeableItem";
import { useContextMenuStore } from "../store/contextMenu";

const MessageStatusIcon = ({ message, participants }: { message: Message; participants: Participant[] }) => {
  const meId = useAuthStore((s) => s.user?.id);
  const retrySendMessage = useMessageInputStore(s => s.retrySendMessage);
  
  if (message.senderId !== meId) return null;
  
  if (message.status === 'FAILED' || message.error) {
    return (
      <button onClick={() => retrySendMessage(message)} title="Failed to send. Click to retry.">
        <FiRefreshCw className="text-destructive cursor-pointer" size={14} />
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
        <span key={emoji} className="px-2 py-0.5 rounded-full bg-secondary/80 text-text-primary text-xs cursor-default">
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
  const meId = useAuthStore((s) => s.user?.id);
  const setReplyingTo = useMessageInputStore(state => state.setReplyingTo);
  const showConfirm = useModalStore(state => state.showConfirm);
  const { removeMessage, addOptimisticMessage, sendReaction, removeLocalReaction } = useMessageStore(state => ({
    removeMessage: state.removeMessage,
    addOptimisticMessage: state.addOptimisticMessage,
    sendReaction: state.sendReaction,
    removeLocalReaction: state.removeLocalReaction,
  }));
  const user = useAuthStore((s) => s.user);

  const profile = useUserProfile(message.sender as any);
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

  if (message.type === 'SYSTEM' || message.content?.startsWith('🔒')) {
    const isError = message.content?.includes('Error') || message.content?.includes('Unreadable');
    return (
      <div className="flex justify-center items-center my-3 opacity-80">
        <div className={clsx(
          "text-xs px-3 py-1.5 rounded-full flex items-center gap-2 shadow-sm border",
          isError 
            ? "bg-red-500/10 text-red-600 border-red-500/20 dark:text-red-400" 
            : "bg-bg-surface text-text-secondary border-white/5"
        )}>
          <FiShield size={12} className={isError ? "text-red-500" : "text-yellow-500"} />
          <span>{message.content}</span>
        </div>
      </div>
    );
  }

  const handleDelete = () => {
    showConfirm('Delete Message', 'Are you sure you want to permanently delete this message?', () => {
      removeMessage(message.conversationId, message.id);
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
          } catch (e) {
              console.error("Failed to parse file URL for deletion:", e);
          }
      }

      api(`/api/messages/${message.id}${query}`, { method: 'DELETE' }).catch((error) => {
        console.error("Failed to delete message:", error);
        toast.error("Failed to delete message.");
        addOptimisticMessage(message.conversationId, message);
      });
    });
  };

  if (message.content === "[This message was deleted]") {
    return (
      <div ref={ref} className={`flex items-center p-2 ${mine ? 'justify-end' : 'justify-start'}`}>
        <p className="text-xs italic text-text-secondary">This message was deleted</p>
      </div>
    );
  }

  const reactToMessage = async (emoji: string) => {
    if (!user) return;
    const userReaction = message.reactions?.find(r => r.userId === user.id);
    
    if (userReaction?.emoji === emoji) {
      removeLocalReaction(message.conversationId, message.id, userReaction.id);
      try {
        if ((userReaction as any).isMessage) {
            await api(`/api/messages/${userReaction.id}`, { method: 'DELETE' });
        } else {
            await api(`/api/messages/reactions/${userReaction.id}`, { method: 'DELETE' });
        }
      } catch (e) {
        console.error("Failed to remove reaction:", e);
      }
      return;
    }

    if (userReaction) {
        removeLocalReaction(message.conversationId, message.id, userReaction.id);
        const deletePromise = (userReaction as any).isMessage
            ? api(`/api/messages/${userReaction.id}`, { method: 'DELETE' })
            : api(`/api/messages/reactions/${userReaction.id}`, { method: 'DELETE' });
        deletePromise.catch(console.error);
    }

    try {
        await sendReaction(message.conversationId, message.id, emoji);
    } catch (e) {
        console.error("Failed to send reaction:", e);
    }
  };

  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    openMenu(e, [
      { label: 'Reply', icon: <FiCornerUpLeft />, onClick: () => setReplyingTo(message) },
      { label: 'Copy Text', icon: <FiCopy />, onClick: () => navigator.clipboard.writeText(message.content || '') },
      { label: 'Security Info', icon: <FiShield />, onClick: () => toast('End-to-End Encrypted via Signal Protocol', { icon: '🔒' }) },
      { label: 'Copy Message ID', icon: <FiInfo />, onClick: () => navigator.clipboard.writeText(message.id) },
      ...(mine && !message.optimistic ? [{ label: 'Delete', icon: <FiTrash2 />, destructive: true, onClick: handleDelete }] : [])
    ], [
      { emoji: '👍', onClick: () => reactToMessage('👍') },
      { emoji: '❤️', onClick: () => reactToMessage('❤️') },
      { emoji: '😂', onClick: () => reactToMessage('😂') },
      { emoji: '😮', onClick: () => reactToMessage('😮') },
      { emoji: '😢', onClick: () => reactToMessage('😢') },
    ]);
  };

  return (
    <motion.div ref={ref} id={message.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: 'easeOut' }} className={clsx('group flex flex-col', isFirstInSequence ? 'mt-3' : 'mt-1', mine ? 'items-end' : 'items-start', isHighlighted && 'bg-accent/10 rounded-lg p-1 -mx-1')}>
      <SwipeableItem 
        leftAction={{ icon: <FiCornerUpLeft size={20} />, color: 'bg-blue-500/80', onAction: () => setReplyingTo(message) }}
        rightAction={{ icon: <FiInfo size={20} />, color: 'bg-secondary/80', onAction: () => toast('Message ID: ' + message.id, { icon: 'ℹ️' }) }}
      >
        <div onContextMenu={handleContextMenu} className={`flex items-end gap-2 w-full select-none ${mine ? 'flex-row-reverse justify-start' : 'flex-row justify-start'}`}>
          {!mine && (
            <div className="w-8 flex-shrink-0 mb-1 self-end">
              {isLastInSequence && (
                <img 
                  src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`} 
                  alt="Avatar" 
                  className="w-8 h-8 rounded-full bg-secondary object-cover shadow-sm cursor-pointer hover:scale-105 transition-transform pointer-events-auto" 
                />
              )}
            </div>
          )}
          
          <div className={clsx("flex flex-col max-w-[85%] sm:max-w-[70%]", mine ? "items-end" : "items-start")}>
            {!mine && isGroup && profile.name && isFirstInSequence && (
              <p className="text-[10px] font-bold mb-1 ml-1 user-color-name cursor-pointer hover:underline uppercase tracking-wide pointer-events-auto" style={{ '--user-color': getUserColor(message.senderId) } as React.CSSProperties}>
                {profile.name}
              </p>
            )}
            
            <div className="pointer-events-auto w-full">
              <MessageBubble 
                message={message} 
                isOwn={mine} 
                onImageClick={onImageClick}
                isLastInSequence={isLastInSequence}
              />
            </div>
            
            <ReactionsDisplay reactions={message.reactions} />
          </div>
        </div>
      </SwipeableItem>
    </motion.div>
  );
};

export default memo(MessageItem);
