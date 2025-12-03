import { memo, useEffect, useRef, useState } from "react";
import type { Message, Conversation } from "@store/conversation";
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
import { FiRefreshCw, FiShield } from 'react-icons/fi';
import { getUserColor } from '@utils/color';
import { FaCheck, FaCheckDouble } from 'react-icons/fa';
import VoiceMessagePlayer from './VoiceMessagePlayer';
import { decryptMessage } from "@utils/crypto";
import { useKeychainStore } from "@store/keychain";

const MessageStatusIcon = ({ message, conversation }: { message: Message; conversation: Conversation | undefined }) => {
  const meId = useAuthStore((s) => s.user?.id);
  const retrySendMessage = useMessageInputStore(s => s.retrySendMessage);
  if (message.senderId !== meId) return null;
  if (message.error) return <button onClick={() => retrySendMessage(message)} title="Failed to send. Click to retry."><FiRefreshCw className="text-destructive cursor-pointer" size={16} /></button>;
  if (message.optimistic) return <svg title="Sending..." xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/></svg>;
  const otherParticipants = conversation?.participants?.filter(p => p.id !== meId) || [];
  if (otherParticipants.length === 0) return <FaCheck title="Sent" size={16} />;
  const statuses = message.statuses || [];
  const isReadAll = otherParticipants.every(p => statuses.some(s => s.userId === p.id && s.status === 'READ'));
  if (isReadAll) return <FaCheckDouble title="Read by all" size={16} className="text-green-500" />;
  const isDeliveredAll = otherParticipants.every(p => statuses.some(s => s.userId === p.id && s.status === 'DELIVERED'));
  if (isDeliveredAll) return <FaCheckDouble title="Delivered to all" size={16} />;
  return <FaCheck title="Sent" size={16} />;
};

const ReplyQuote = ({ message }: { message: Message }) => {
  const authorName = message.sender?.name || 'User';
  let contentPreview: string;
  if (message.duration) contentPreview = 'Voice Message';
  else if (message.fileName) contentPreview = message.fileName;
  else if (message.fileUrl) contentPreview = 'File';
  else contentPreview = message.content || '...';
  return (
    <div className="mb-1.5 p-2 rounded-lg bg-black/20 border-l-4 border-accent/50">
      <p className="text-xs font-bold text-accent/80">{authorName}</p>
      <p className="text-text-primary/70 truncate text-sm">{contentPreview}</p>
    </div>
  );
};

const MessageBubble = ({ message, mine, isLastInSequence, onImageClick, conversation }: { message: Message; mine: boolean; isLastInSequence: boolean; onImageClick: (message: Message) => void; conversation: Conversation | undefined; }) => {
  const [decryptedContent, setDecryptedContent] = useState<string | null>(message.content || '');
  const lastKeychainUpdate = useKeychainStore(s => s.lastUpdated);

  useEffect(() => {
    const isPlaceholder = typeof decryptedContent === 'string' && decryptedContent.startsWith('[');

    if (message.fileUrl || (!message.ciphertext && !isPlaceholder) || !message.sessionId) {
      // If it's a file, or if there's no ciphertext and the current content is not a placeholder, do nothing.
      return;
    }

    let isMounted = true;
    const tryDecrypt = async () => {
      // Always use the original ciphertext for decryption attempts
      const sourceCipher = message.ciphertext || message.content;
      if (!sourceCipher) return;

      const result = await decryptMessage(sourceCipher, message.conversationId, message.sessionId);
      if (isMounted) {
        if (result.status === 'success') {
          setDecryptedContent(result.value);
        } else if (result.status === 'pending') {
          setDecryptedContent(result.reason);
        } else {
          setDecryptedContent(`[${result.error.message}]`);
        }
      }
    };

    // Only try to decrypt if the current state is a placeholder (e.g., "[Requesting key...]")
    if (isPlaceholder) {
      tryDecrypt();
    }
    
    return () => { isMounted = false; };
  }, [decryptedContent, message.ciphertext, message.content, message.conversationId, message.sessionId, lastKeychainUpdate, message.fileUrl]);

  const isPlaceholder = !decryptedContent || (typeof decryptedContent === 'string' && decryptedContent.startsWith('['));
  const isImage = message.fileType?.startsWith('image/');
  const isVoiceMessage = message.fileType?.startsWith('audio/webm');
  
  const hasBubbleStyle = !isPlaceholder && !message.fileUrl || message.fileUrl && !isImage && !isVoiceMessage;

  const bubbleClasses = clsx(
    'relative max-w-md md:max-w-lg shadow-neumorphic-bubble',
    {
      'px-4 py-2.5': hasBubbleStyle,
      'bg-accent text-accent-foreground': mine, 'bg-bg-surface text-text-primary': !mine,
      'rounded-t-2xl': true, 'rounded-bl-2xl': mine, 'rounded-br-2xl': !mine,
      'rounded-br-sm': mine && isLastInSequence, 'rounded-bl-sm': !mine && isLastInSequence,
    }
  );

  return (
    <div className={bubbleClasses}>
      {message.repliedTo && <ReplyQuote message={message.repliedTo} />}
      {isVoiceMessage && message.fileUrl && <div className="p-2 w-[250px]"><VoiceMessagePlayer message={message} /></div>}
      {message.fileUrl && isImage && <button onClick={() => onImageClick(message)} className="block w-full"><LazyImage message={message} alt={message.fileName || 'Image attachment'} className="rounded-lg max-h-80 w-full object-cover cursor-pointer" /></button>}
      {message.fileUrl && !isImage && !isVoiceMessage && <FileAttachment message={message} />}
      {!message.fileUrl && (isPlaceholder ? <p className="text-base whitespace-pre-wrap break-words italic text-text-secondary">{decryptedContent}</p> : <p className="text-base whitespace-pre-wrap break-words">{decryptedContent}</p>)}
      {message.linkPreview && <LinkPreviewCard preview={message.linkPreview} />}
      <div className={`text-xs mt-1 flex items-center gap-1.5 ${isImage ? 'absolute bottom-2 right-2 bg-black/50 text-white rounded-full px-2 py-1 pointer-events-none' : `justify-end ${mine ? 'text-accent-foreground/60' : 'text-text-secondary/80'}`}`}>
        <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <MessageStatusIcon message={message} conversation={conversation} />
      </div>
    </div>
  );
};

const ReactionsDisplay = ({ reactions }: { reactions: Message['reactions'] }) => {
  if (!reactions || reactions.length === 0) return null;
  const grouped = reactions.reduce((acc, r) => {
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
  conversation: Conversation | undefined;
  isHighlighted?: boolean;
  onImageClick: (message: Message) => void;
  isFirstInSequence: boolean;
  isLastInSequence: boolean;
}

const MessageItem = ({ message, conversation, isHighlighted, onImageClick, isFirstInSequence, isLastInSequence }: MessageItemProps) => {
  const meId = useAuthStore((s) => s.user?.id);
  const setReplyingTo = useMessageInputStore(state => state.setReplyingTo);
  const showConfirm = useModalStore(state => state.showConfirm);
  const mine = message.senderId === meId;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || mine) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        const alreadyRead = message.statuses?.some(s => s.userId === meId && s.status === 'READ');
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
      api(`/api/messages/${message.id}`, { method: 'DELETE' }).catch(console.error);
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
    <motion.div ref={ref} id={message.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: 'easeOut' }} className={clsx('group flex items-end gap-2', isFirstInSequence ? 'mt-2' : 'mt-0.5', mine ? 'justify-end' : 'justify-start', isHighlighted && 'bg-accent/10 rounded-lg')}>
      {!mine && <div className="w-8 flex-shrink-0 mb-1 self-end">{isLastInSequence && <img src={toAbsoluteUrl(message.sender?.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${message.sender?.name || 'U'}`} alt="Avatar" className="w-8 h-8 rounded-full bg-secondary object-cover" />}</div>}
      <div className={`flex items-center gap-2 ${mine ? 'flex-row-reverse' : 'flex-row'}`}>
        <div className="flex flex-col">
          {!mine && conversation?.isGroup && message.sender?.name && <p className="text-xs font-semibold mb-1 user-color-name" style={{ '--user-color': getUserColor(message.senderId) } as React.CSSProperties}>{message.sender.name}</p>}
          <MessageBubble message={message} mine={mine} isLastInSequence={isLastInSequence} onImageClick={onImageClick} conversation={conversation} />
          <ReactionsDisplay reactions={message.reactions} />
        </div>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><button className="p-1.5 rounded-full hover:bg-secondary"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-text-secondary" viewBox="0 0 20 20" fill="currentColor"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 12a2 2 0 110-4 2 2 0 010 4zm0-6a2 2 0 110-4 2 2 0 010 4z" /></svg></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content sideOffset={5} align="center" className="min-w-[150px] bg-surface/80 backdrop-blur-sm rounded-md shadow-lg z-50 p-1">
                <DropdownMenu.Item onSelect={() => setReplyingTo(message)} className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-secondary rounded cursor-pointer outline-none"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>Reply</DropdownMenu.Item>
                <ReactionPopover message={message}><div className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-secondary rounded cursor-pointer outline-none"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-.464 5.535a.75.75 0 01.028.022l.028.027a.75.75 0 01.027.028l.027.028a.75.75 0 01.022.028l.022.028a.75.75 0 01.016.023l.016.023a.75.75 0 01.01.016l.01.016c.004.005.007.01.01.015l.004.005a.75.75 0 01.005.004l.005.004a.75.75 0 01.002.002l.002.002a.75.75 0 010 .004c0 .001 0 .002 0 .002a.75.75 0 01-.004 0l-.002-.002a.75.75 0 01-.005-.004l-.005-.004a.75.75 0 01-.01-.015l-.01-.016a.75.75 0 01-.016-.023l-.016-.023a.75.75 0 01-.022-.028l-.022-.028a.75.75 0 01-.027-.028l-.027-.028a.75.75 0 01-.028-.022l-.028-.027a.75.75 0 01-.022-.028l-.022-.028a.75.75 0 01-.016-.023l-.016-.023a.75.75 0 01-.01-.016l-.01-.016a.75.75 0 01-.005-.004l-.005-.004a.75.75 0 01-.002-.002l-.002-.002a.75.75 0 010-.004c.09.34.26.65.49.93a.75.75 0 01-1.06 1.06 5.25 5.25 0 00-1.5 3.75.75.75 0 01-1.5 0 6.75 6.75 0 011.94-4.71.75.75 0 011.06-1.06z" clipRule="evenodd" /></svg>React</div></ReactionPopover>
                {mine && <DropdownMenu.Item onSelect={handleDelete} className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground rounded cursor-pointer outline-none"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg>Delete Message</DropdownMenu.Item>}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </motion.div>
  );
};

export default memo(MessageItem);