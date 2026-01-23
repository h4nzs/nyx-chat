import { useCallback, useRef, ChangeEvent, useState, useEffect } from "react";
import { useAuthStore, type User } from "@store/auth";
import { getSocket } from "@lib/socket";
import { Virtuoso } from "react-virtuoso";
import MessageItem from "@components/MessageItem";
import { useConversation } from "@hooks/useConversation";
import { Spinner } from "./Spinner";
import { useConversationStore, type Conversation, type Message } from "@store/conversation";
import { useMessageStore } from '@store/message';
import { useMessageInputStore as useTypingStore } from '@store/messageInput'; // Alias for clarity
import { useMessageInputStore } from '@store/messageInput';
import { useMessageSearchStore } from '@store/messageSearch';
import { usePresenceStore } from "@store/presence";
import { useThemeStore } from "@store/theme";
import useDynamicIslandStore from "@store/dynamicIsland";
import { toAbsoluteUrl } from "@utils/url";
import { useModalStore } from "@store/modal";
import SearchMessages from './SearchMessages';
import Lightbox from "./Lightbox";
import GroupInfoPanel from './GroupInfoPanel';
import clsx from "clsx";
import { useVerificationStore } from '@store/verification';
import { FiShield, FiSmile, FiMic, FiSquare } from 'react-icons/fi';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

import { useConnectionStore } from "@store/connection";
import LinkPreviewCard from './LinkPreviewCard';

const KeyRotationBanner = () => (
  <div className="bg-yellow-500/20 border-t-2 border-b-2 border-yellow-600 px-4 py-3 text-yellow-800 dark:text-yellow-200">
    <div className="flex items-center">
      <FiShield className="mr-3 flex-shrink-0" size={20} />
      <div>
        <p className="font-bold">Chat Insecure: Key Rotation Needed</p>
        <p className="text-sm">A member has left this group. Send a message to generate a new key and re-secure the chat.</p>
      </div>
    </div>
  </div>
);

// Helper function to prevent spamming the API
function debounce<F extends (...args: any[]) => any>(func: F, waitFor: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<F>) => {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => func(...args), waitFor);
  };

  return debounced as (...args: Parameters<F>) => void;
}

const ChatHeader = ({ conversation, onBack, onInfoToggle, onMenuClick }: { conversation: Conversation; onBack: () => void; onInfoToggle: () => void; onMenuClick: () => void; }) => {
  const meId = useAuthStore((s) => s.user?.id);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const { openProfileModal, openChatInfoModal } = useModalStore(s => ({ openProfileModal: s.openProfileModal, openChatInfoModal: s.openChatInfoModal }));
  const { verifiedStatus } = useVerificationStore();

  const peerUser = !conversation.isGroup ? conversation.participants?.find((p) => p.id !== meId) : null;
  const title = conversation.isGroup ? conversation.title : peerUser?.name;
  const avatarUrl = conversation.isGroup ? conversation.avatarUrl : peerUser?.avatarUrl;
  const isOnline = peerUser ? onlineUsers.has(peerUser.id) : false;
  const isConvVerified = verifiedStatus[conversation.id] || false;

  const handleHeaderClick = () => {
    if (peerUser) {
      openProfileModal(peerUser.id);
    } else {
      // For group chats, toggle the info panel
      onInfoToggle();
    }
  };

  const getStatus = () => {
    if (conversation.isGroup) {
      return `${conversation.participants.length} members`;
    }
    if (isOnline) {
      return "Online";
    }
    return "Offline";
  };

  return (
    <div className="flex items-center justify-between p-4 border-b border-border">
      <div className="flex items-center gap-3">
        <button onClick={onMenuClick} aria-label="Open menu" className="md:hidden touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <button onClick={onBack} aria-label="Back to conversation list" className="hidden md:block touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button onClick={handleHeaderClick} className="flex items-center gap-3 text-left p-2 -ml-2 rounded-lg transition-colors">
          <img
            src={toAbsoluteUrl(avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${title}`}
            alt="Avatar"
            className="w-10 h-10 rounded-full object-cover bg-secondary"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${title}`;
            }}
          />
          <div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-bold text-text-primary">{title}</p>
              {isConvVerified && <FiShield className="text-[hsl(var(--grad-start))]" title="Verified Contact" />}
            </div>
            <p className="text-sm text-text-secondary">{getStatus()}</p>
          </div>
        </button>
      </div>
      <div className="flex items-center gap-2">
        <SearchMessages conversationId={conversation.id} />
        <button onClick={openChatInfoModal} aria-label="View conversation information" className="touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </button>
      </div>
    </div>
    );
  };
  
  const ReplyPreview = () => {
    const { replyingTo, setReplyingTo } = useMessageInputStore(state => ({
      replyingTo: state.replyingTo,
      setReplyingTo: state.setReplyingTo,
    }));

    if (!replyingTo) return null;

    const authorName = replyingTo.sender?.name || 'User';

    let contentPreview: string;
    if (replyingTo.duration) {
      contentPreview = 'Voice Message';
    } else if (replyingTo.fileName) {
      contentPreview = replyingTo.fileName;
    } else if (replyingTo.fileUrl) {
      contentPreview = 'File';
    } else if (replyingTo.content) {
      contentPreview = replyingTo.content; // This is ciphertext, but we'll truncate it.
    } else {
      contentPreview = '...';
    }

    return (
      <div className="px-4 pt-3">
        <div className="relative bg-bg-surface p-3 rounded-xl shadow-neumorphic-concave">
          <p className="text-xs font-bold text-accent border-l-4 border-accent pl-2">Replying to {authorName}</p>
          <p className="text-sm text-text-secondary truncate">{contentPreview}</p>
          <button
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
            className="absolute top-1 right-1 p-1.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
    );
  };
  
  const MessageInput = ({ onSend, onTyping, onFileChange, onVoiceSend }: { onSend: (data: { content: string }) => void; onTyping: () => void; onFileChange: (e: ChangeEvent<HTMLInputElement>) => void; onVoiceSend: (blob: Blob, duration: number) => void; }) => {
  const [text, setText] = useState('');
  const [isPressed, setIsPressed] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const { typingLinkPreview, fetchTypingLinkPreview, clearTypingLinkPreview } = useMessageInputStore();
  const { status: connectionStatus } = useConnectionStore();

  // --- Voice Recording State ---
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingTimeRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // --- End Voice Recording State ---

  const isConnected = connectionStatus === 'connected';
  const hasText = text.trim().length > 0;

  const debouncedFetchPreview = useCallback(
    debounce((inputText: string) => {
      fetchTypingLinkPreview(inputText);
    }, 500),
    [fetchTypingLinkPreview]
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // --- Voice Recording Logic ---
  const handleStartRecording = async () => {
    if (!isConnected) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        // Use the ref's value to avoid stale state in the closure
        onVoiceSend(audioBlob, recordingTimeRef.current);

        // Clean up stream and reset timer AFTER sending
        stream.getTracks().forEach(track => track.stop());
        setRecordingTime(0);
        recordingTimeRef.current = 0;
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => {
          const newTime = prev + 1;
          // Update both state for UI and ref for the final value
          recordingTimeRef.current = newTime;
          return newTime;
        });
      }, 1000);
    } catch (error) {
      console.error("Error starting recording:", error);
      // You might want to show a toast notification to the user here
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      // Timer and ref are now reset in the onstop handler
    }
  };
  // --- End Voice Recording Logic ---

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    setText(prevText => prevText + emojiData.emoji);
    setShowEmojiPicker(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasText || !isConnected) return;
    onSend({ content: text });
    setText('');
    clearTypingLinkPreview();
  };

  const handleTextChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    setText(newText);
    if (isConnected) {
      onTyping();
      debouncedFetchPreview(newText);
    }
  }

  const sendButtonClasses = clsx(
    'bg-accent text-white rounded-full p-3 transition-all duration-200 shadow-neumorphic-convex',
    {
      'translate-y-px brightness-95': isPressed && hasText,
      'active:shadow-neumorphic-pressed': hasText,
      'scale-100 opacity-100': hasText,
      'scale-90 opacity-60 cursor-not-allowed': !hasText || !isConnected,
    }
  );

  const textInputClasses = clsx(
    'flex-1 input-neumorphic rounded-full px-4 py-2.5',
    { 'opacity-50 cursor-not-allowed': !isConnected }
  );

  const fileButtonClasses = clsx(
    'p-2.5 rounded-full text-text-secondary transition-all duration-150',
    'hover:text-accent',
    'shadow-neumorphic-convex-sm', // Use soft shadow for elevated look
    'active:shadow-neumorphic-pressed-sm', // Use inner shadow for pressed state
    { 'opacity-50 cursor-not-allowed': !isConnected }
  );

  return (
    <div className="border-t border-transparent bg-transparent">
      <ReplyPreview />
      {typingLinkPreview && (
        <div className="px-4 pt-3">
          <LinkPreviewCard preview={typingLinkPreview} />
        </div>
      )}
      <div className="p-4 bg-bg-surface shadow-neumorphic-convex rounded-t-xl relative">
        {showEmojiPicker && (
          <div ref={emojiPickerRef} className="absolute bottom-full mb-2">
            <EmojiPicker
              onEmojiClick={handleEmojiClick}
              autoFocusSearch={false}
              lazyLoadEmojis={true}
              theme={useThemeStore.getState().theme as any}
            />
          </div>
        )}

        {isRecording ? (
          <div className="flex items-center gap-3 w-full">
            <button type="button" onClick={handleStopRecording} aria-label="Stop recording" className={`${fileButtonClasses} bg-red-500 text-white`} disabled={!isConnected}>
              <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1 }}>
                <FiSquare size={22} />
              </motion.div>
            </button>
            <div className="flex-1 bg-bg-main shadow-neumorphic-concave rounded-full flex items-center px-4">
              <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse mr-3"></div>
              <p className="text-text-secondary font-mono">{new Date(recordingTime * 1000).toISOString().substr(14, 5)}</p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex items-center gap-3">
            <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach file" className={`${fileButtonClasses} touch-target`} disabled={!isConnected}>
              <motion.svg
                whileHover={{ scale: 1.1, rotate: -15 }}
                xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></motion.svg>
            </button>
            <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} aria-label="Open emoji picker" className={`${fileButtonClasses} touch-target`} disabled={!isConnected}>
              <motion.div whileHover={{ scale: 1.1 }}>
                <FiSmile size={22} />
              </motion.div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={onFileChange}
              disabled={!isConnected}
            />
            <input
              type="text"
              value={text}
              onChange={handleTextChange}
              placeholder={isConnected ? "Type a message..." : "Disconnected..."}
              className={textInputClasses}
              disabled={!isConnected}
            />
            {hasText ? (
              <button
                type="submit"
                disabled={!hasText || !isConnected}
                onMouseDown={() => hasText && setIsPressed(true)}
                onMouseUp={() => setIsPressed(false)}
                onMouseLeave={() => setIsPressed(false)}
                aria-label="Send message"
                className={`${sendButtonClasses} touch-target`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            ) : (
              <button type="button" onClick={handleStartRecording} aria-label="Start recording" className={`${fileButtonClasses} touch-target`} disabled={!isConnected}>
                <motion.div whileHover={{ scale: 1.1 }}>
                  <FiMic size={22} />
                </motion.div>
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
};

const ChatSpinner = () => (
  <div className="py-4 flex justify-center items-center">
    <Spinner />
  </div>
);

export default function ChatWindow({ id, onMenuClick }: { id: string, onMenuClick: () => void }) {
  const meId = useAuthStore((s) => s.user?.id);
  const openConversation = useConversationStore(s => s.openConversation);
  const { 
    conversation, 
    messages, 
    isLoading, 
    error, 
    actions,
    isFetchingMore, 
  } = useConversation(id);
  const loadMessagesForConversation = useMessageStore(s => s.loadMessagesForConversation);
  
  const { highlightedMessageId, setHighlightedMessageId } = useMessageSearchStore(state => ({
    highlightedMessageId: state.highlightedMessageId,
    setHighlightedMessageId: state.setHighlightedMessageId,
  }));
  const { handleStopRecording, replyingTo, setReplyingTo } = useMessageInputStore(state => ({
    handleStopRecording: state.handleStopRecording,
    replyingTo: state.replyingTo,
    setReplyingTo: state.setReplyingTo,
  }));
  const { typingLinkPreview, clearTypingLinkPreview } = useTypingStore(state => ({
    typingLinkPreview: state.typingLinkPreview,
    clearTypingLinkPreview: state.clearTypingLinkPreview,
  }));
  const { addActivity, updateActivity, removeActivity } = useDynamicIslandStore();
  const typingIndicators = usePresenceStore(state => state.typingIndicators);
  
  const virtuosoRef = useRef<any>(null);
  const [lightboxMessage, setLightboxMessage] = useState<Message | null>(null);
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (id) {
      loadMessagesForConversation(id);
    }
  }, [id, loadMessagesForConversation]);

  const handleImageClick = (message: Message) => setLightboxMessage(message);

  useEffect(() => {
    if (highlightedMessageId && virtuosoRef.current && messages.length > 0) {
      const index = messages.findIndex(m => m.id === highlightedMessageId);
      if (index !== -1) {
        virtuosoRef.current.scrollToIndex({
          index,
          align: 'center',
          behavior: 'smooth',
        });
        setTimeout(() => setHighlightedMessageId(null), 2000);
      }
    }
  }, [highlightedMessageId, messages, setHighlightedMessageId]);

  const typingUsersInThisConvo = typingIndicators.filter(i => i.conversationId === id && i.id !== meId && i.isTyping);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleTyping = useCallback(() => {
    const socket = getSocket();
    socket.emit("typing:start", { conversationId: id });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit("typing:stop", { conversationId: id });
    }, 1500);
  }, [id]);

  const handleSendMessage = (data: { content: string }) => {
    actions.sendMessage(data);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    getSocket().emit("typing:stop", { conversationId: id });
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      actions.uploadFile(e.target.files[0]);
    }
  };

  const handleVoiceSend = (blob: Blob, duration: number) => {
    handleStopRecording(id, blob, duration);
  };

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={id}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex flex-col h-full bg-gradient-to-b from-bg-main to-bg-surface relative"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='0.04'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      >
        {(() => {
          if (error) {
            return (
              <div className="flex-1 flex flex-col items-center justify-center bg-bg-main text-destructive">
                <p>Error loading messages.</p>
                <p className="text-sm text-text-secondary">{error}</p>
              </div>
            );
          }

          if (isLoading || !conversation) {
            return (
              <div className="flex-1 flex items-center justify-center bg-bg-main">
                <Spinner size="lg" />
              </div>
            );
          }

          return (
            <>
              <ChatHeader 
                conversation={conversation} 
                onBack={() => navigate('/chat')} 
                onInfoToggle={() => setIsGroupInfoOpen(true)} 
                onMenuClick={onMenuClick} // Pass prop down
              />
              <div className="flex-1 min-h-0 relative" role="log">
                <Virtuoso
                  ref={virtuosoRef}
                  initialTopMostItemIndex={messages.length - 1}
                  data={messages}
                  startReached={actions.loadPrevious}
                  components={{ Header: () => isFetchingMore ? <ChatSpinner /> : null }}
                  itemContent={(index, message) => {
                    const prevMessage = messages[index - 1];
                    const nextMessage = messages[index + 1];
                    const isFirstInSequence = !prevMessage || prevMessage.senderId !== message.senderId;
                    const isLastInSequence = !nextMessage || nextMessage.senderId !== message.senderId;

                    return (
                      <div className="px-4" key={message.id}>
                        <MessageItem 
                          message={message} 
                          conversation={conversation} 
                          isHighlighted={message.id === highlightedMessageId}
                          onImageClick={handleImageClick}
                          isFirstInSequence={isFirstInSequence}
                          isLastInSequence={isLastInSequence}
                        />
                      </div>
                    );
                  }}
                  followOutput="auto"
                />
                {typingUsersInThisConvo.length > 0 && (
                  <div aria-live="polite" className="absolute bottom-2 left-4 flex items-center gap-2 bg-bg-surface/80 backdrop-blur-sm text-text-secondary text-xs rounded-full px-3 py-1.5 shadow-lg animate-fade-in">
                     <div className="flex gap-1 items-end h-4">
                       <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                       <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                       <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce"></span>
                     </div>
                     <span>typing...</span>
                   </div>
                )}
              </div>
              {conversation.keyRotationPending && <KeyRotationBanner />}
              <MessageInput onSend={handleSendMessage} onTyping={handleTyping} onFileChange={handleFileChange} onVoiceSend={handleVoiceSend} />
              {lightboxMessage && <Lightbox message={lightboxMessage} onClose={() => setLightboxMessage(null)} />}
              {isGroupInfoOpen && <GroupInfoPanel conversationId={id} onClose={() => setIsGroupInfoOpen(false)} />}
            </>
          );
        })()}
      </motion.div>
    </AnimatePresence>
  );
}
