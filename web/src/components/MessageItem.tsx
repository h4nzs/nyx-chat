import { memo, useEffect, useRef, useState } from "react";
import type { Message, Conversation, Participant, MessageStatus } from "@store/conversation";
import { useAuthStore } from "@store/auth";
import { useMessageInputStore } from "@store/messageInput";
import { getSocket } from "@lib/socket";
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from "@lib/api";
import ReactionPopover from "./Reactions";
import { toAbsoluteUrl } from "@utils/url";
import LazyImage from "./LazyImage";
import FileAttachment from "./FileAttachment";
import { useModalStore } from '@store/modal';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import LinkPreviewCard from './LinkPreviewCard';
import { FiRefreshCw, FiShield, FiCopy, FiTrash2, FiCornerUpLeft } from 'react-icons/fi';
import { getUserColor } from '@utils/color';
import { FaCheck, FaCheckDouble } from 'react-icons/fa';
import VoiceMessagePlayer from './VoiceMessagePlayer';
import { decryptMessage } from "@utils/crypto";
import { useKeychainStore } from "@store/keychain";
import { useMessageStore } from '@store/message';
import toast from 'react-hot-toast';
import MarkdownMessage from './MarkdownMessage';
import MessageBubble from "./MessageBubble"; // Import the external component

const MessageStatusIcon = ({ message, participants }: { message: Message; participants: Participant[] }) => {
  const meId = useAuthStore((s) => s.user?.id);
  const retrySendMessage = useMessageInputStore(s => s.retrySendMessage);
  if (message.senderId !== meId) return null;
  if (message.error) return <button onClick={() => retrySendMessage(message)} title="Failed to send. Click to retry."><FiRefreshCw className="text-destructive cursor-pointer" size={16} /></button>;
  if (message.optimistic) return <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><title>Sending...</title><circle cx="12" cy="12" r="10"/></svg>;
  const otherParticipants = participants.filter((p: Participant) => p.id !== meId) || [];
  if (otherParticipants.length === 0) return <FaCheck size={16} />;
  const statuses = message.statuses || [];
  const isReadAll = otherParticipants.every((p: Participant) => statuses.some((s: MessageStatus) => s.userId === p.id && s.status === 'READ'));
  if (isReadAll) return <FaCheckDouble size={16} className="text-green-500" />;
  const isDeliveredAll = otherParticipants.every((p: Participant) => statuses.some((s: MessageStatus) => s.userId === p.id && s.status === 'DELIVERED'));
  if (isDeliveredAll) return <FaCheckDouble size={16} />;
  return <FaCheck size={16} />;
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
  const { removeMessage, addOptimisticMessage } = useMessageStore(state => ({
    removeMessage: state.removeMessage,
    addOptimisticMessage: state.addOptimisticMessage,
  }));
  const mine = message.senderId === meId;
  const ref = useRef<HTMLDivElement>(null);

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

  if (message.type === 'SYSTEM') {
    return (
      <div className="flex justify-center items-center my-2">
        <div className="text-xs text-text-secondary bg-bg-surface rounded-full px-3 py-1 flex items-center gap-2 shadow-sm">
          <FiShield className="text-yellow-500" />
          <span>{message.content}</span>
        </div>
      </div>
    );
  }

  const handleDelete = () => {
    showConfirm('Delete Message', 'Are you sure you want to permanently delete this message?', () => {
      // Optimistically remove the message from the UI
      removeMessage(message.conversationId, message.id);
      // Call the API to delete the message from the server
      api(`/api/messages/${message.id}`, { method: 'DELETE' }).catch((error) => {
        // If the API call fails, revert the change by re-adding the message
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

  return (
    <motion.div ref={ref} id={message.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: 'easeOut' }} className={clsx('group flex items-end gap-2', isFirstInSequence ? 'mt-3' : 'mt-1', mine ? 'justify-end' : 'justify-start', isHighlighted && 'bg-accent/10 rounded-lg p-1 -mx-1')}>
      {!mine && <div className="w-8 flex-shrink-0 mb-1 self-end">{isLastInSequence && <img src={toAbsoluteUrl(message.sender?.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${message.sender?.name || 'U'}`} alt="Avatar" className="w-8 h-8 rounded-full bg-secondary object-cover" />}</div>}
      <div className={`flex items-center gap-2 ${mine ? 'flex-row-reverse' : 'flex-row'}`}>
        <div className="flex flex-col">
          {!mine && isGroup && message.sender?.name && <p className="text-xs font-semibold mb-1 user-color-name" style={{ '--user-color': getUserColor(message.senderId) } as React.CSSProperties}>{message.sender.name}</p>}
          
          <MessageBubble 
            message={message} 
            isOwn={mine} 
            isGroup={isGroup}
            showAvatar={false} // Avatar handled by MessageItem parent
            showName={false} // Name handled by MessageItem parent
            onImageClick={onImageClick}
          />
          
          <ReactionsDisplay reactions={message.reactions} />
        </div>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><button className="p-1.5 rounded-full hover:bg-secondary"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-text-secondary" viewBox="0 0 20 20" fill="currentColor"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 12a2 2 0 110-4 2 2 0 010 4zm0-6a2 2 0 110-4 2 2 0 010 4z" /></svg></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content 
                sideOffset={5} 
                align="center" 
                className="
                  z-50 min-w-[180px] p-2
                  rounded-xl bg-bg-main
                  shadow-[8px_8px_20px_rgba(0,0,0,0.15),-8px_-8px_20px_rgba(255,255,255,1)]
                  dark:shadow-[8px_8px_20px_rgba(0,0,0,0.5),-8px_-8px_20px_rgba(255,255,255,0.05)]
                  border border-white/40 dark:border-white/5
                  border-b-white/10 dark:border-b-black/50
                "
              >
                <DropdownMenu.Item onSelect={() => setReplyingTo(message)} className="group flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg text-sm font-bold text-text-secondary outline-none cursor-pointer transition-all duration-200 data-[highlighted]:text-accent data-[highlighted]:shadow-[inset_3px_3px_6px_rgba(0,0,0,0.1),inset_-3px_-3px_6px_rgba(255,255,255,0.8)] dark:data-[highlighted]:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.5),inset_-2px_-2px_5px_rgba(255,255,255,0.05)]">
                  <FiCornerUpLeft className="opacity-70 group-data-[highlighted]:scale-110 transition-transform" />
                  <span>Reply</span>
                </DropdownMenu.Item>
                
                <ReactionPopover message={message}>
                  <div className="group flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg text-sm font-bold text-text-secondary outline-none cursor-pointer transition-all duration-200 hover:text-accent hover:shadow-[inset_3px_3px_6px_rgba(0,0,0,0.1),inset_-3px_-3px_6px_rgba(255,255,255,0.8)] dark:hover:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.5),inset_-2px_-2px_5px_rgba(255,255,255,0.05)]">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 opacity-70 group-hover:scale-110 transition-transform" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-.464 5.535a.75.75 0 01.028.022l.028.027a.75.75 0 01.027.028l.027.028a.75.75 0 01.022.028l.022.028a.75.75 0 01.016.023l.016.023a.75.75 0 01.01.016l.01.016c.004.005.007.01.01.015l.004.005a.75.75 0 01.005.004l.005.004a.75.75 0 01.002.002l.002.002a.75.75 0 010 .004c0 .001 0 .002 0 .002a.75.75 0 01-.004 0l-.002-.002a.75.75 0 01-.005-.004l-.005-.004a.75.75 0 01-.01-.015l-.01-.016a.75.75 0 01-.016-.023l-.016-.023a.75.T5 0 01-.022-.028l-.022-.028a.75.75 0 01-.027-.028l-.027-.028a.75.75 0 01-.028-.022l-.028-.027a.75.75 0 01-.022-.028l-.022-.028a.75.75 0 01-.016-.023l-.016-.023a.75.75 0 01-.01-.016l-.01-.016a.75.75 0 01-.005-.004l-.005-.004a.75.75 0 01-.002-.002l-.002-.002a.75.75 0 010-.004c.09.34.26.65.49.93a.75.75 0 01-1.06 1.06 5.25 5.25 0 00-1.5 3.75.75.75 0 01-1.5 0 6.75 6.75 0 011.94-4.71.75.75 0 011.06-1.06z" clipRule="evenodd" /></svg>
                    <span>React</span>
                  </div>
                </ReactionPopover>

                {mine && !message.optimistic && (
                  <DropdownMenu.Item onSelect={handleDelete} className="group flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg text-sm font-bold text-destructive outline-none cursor-pointer transition-all duration-200 data-[highlighted]:text-destructive data-[highlighted]:shadow-[inset_3px_3px_6px_rgba(0,0,0,0.1),inset_-3px_-3px_6px_rgba(255,255,255,0.8)] dark:data-[highlighted]:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.5),inset_-2px_-2px_5px_rgba(255,255,255,0.05)]">
                    <FiTrash2 className="opacity-70 group-data-[highlighted]:scale-110 transition-transform" />
                    <span>Delete</span>
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </motion.div>
  );
};

export default memo(MessageItem);