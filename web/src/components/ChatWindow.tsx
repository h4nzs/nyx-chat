import { useCallback, useRef, ChangeEvent, useState, useEffect, useMemo } from "react";
import { useAuthStore } from "@store/auth";
import { getSocket } from "@lib/socket";
import { Virtuoso } from "react-virtuoso";
import MessageItem from "@components/MessageItem";
import { useConversation } from "@hooks/useConversation";
import { Spinner } from "./Spinner";
import { useConversationStore, type Conversation, type Message } from "@store/conversation";
import { useMessageStore } from '@store/message';
import { useMessageInputStore } from '@store/messageInput';
import { useMessageSearchStore } from '@store/messageSearch';
import { usePresenceStore } from "@store/presence";
import useDynamicIslandStore from "@store/dynamicIsland";
import { toAbsoluteUrl } from "@utils/url";
import { useModalStore } from "@store/modal";
import SearchMessages from './SearchMessages';
import Lightbox from "./Lightbox";
import GroupInfoPanel from './GroupInfoPanel';
import clsx from "clsx";
import { useVerificationStore } from '@store/verification';
import { FiShield, FiMoreHorizontal, FiArrowLeft, FiInfo, FiUsers, FiPhone, FiVideo } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import MessageInput from './MessageInput';
import MessageSkeleton from './MessageSkeleton';
import { useUserProfile } from '@hooks/useUserProfile';
import { useEdgeSwipe } from '@hooks/useEdgeSwipe';
import { useWebRTC } from '@hooks/useWebRTC';

const KeyRotationBanner = () => (
  <div className="bg-yellow-500/10 border-y border-yellow-500/20 px-4 py-3 text-yellow-600 dark:text-yellow-400">
    <div className="flex items-center gap-3">
      <FiShield className="flex-shrink-0 animate-pulse" size={18} />
      <div className="font-mono text-xs">
        <p className="font-bold uppercase tracking-wider">Security Alert: Key Rotation Required</p>
        <p className="opacity-80">Encryption keys desynchronized. Transmit message to re-establish secure handshake.</p>
      </div>
    </div>
  </div>
);

const NewConversationBanner = () => (
  <div className="bg-blue-500/10 border-y border-blue-500/20 px-4 py-3 text-blue-600 dark:text-blue-400">
    <div className="flex items-start gap-3">
      <FiInfo className="flex-shrink-0 mt-0.5" size={18} />
      <div className="font-mono text-xs">
        <p className="font-bold uppercase tracking-wider mb-1">Encryption Protocol Recommendation</p>
        <p className="opacity-90 leading-relaxed">
          For the initial handshake, ensure both parties are <strong>ONLINE</strong>. 
          Sending messages to offline users in a new conversation may require a key refresh if they come online later.
        </p>
      </div>
    </div>
  </div>
);

const ChatHeader = ({ conversation, onBack, onInfoToggle, onMenuClick }: { conversation: Conversation; onBack: () => void; onInfoToggle: () => void; onMenuClick: () => void; }) => {
  const user = useAuthStore((s) => s.user);
  const meId = user?.id;
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const { openProfileModal, openChatInfoModal } = useModalStore(s => ({ openProfileModal: s.openProfileModal, openChatInfoModal: s.openChatInfoModal }));
  const { verifiedStatus } = useVerificationStore();
  const { startCall } = useWebRTC();

  const peerUser = !conversation.isGroup ? conversation.participants?.find((p) => p.id !== meId) : null;
  const peerProfile = useUserProfile(peerUser as any);
  const title = conversation.isGroup ? conversation.title : peerProfile.name;
  const avatarUrl = conversation.isGroup ? conversation.avatarUrl : peerProfile.avatarUrl;
  const isOnline = peerUser ? onlineUsers.has(peerUser.id) : false;
  const isConvVerified = verifiedStatus[conversation.id] || false;

  const handleHeaderClick = () => {
    if (peerUser) {
      openProfileModal(peerUser.id);
    } else {
      onInfoToggle();
    }
  };

  const getStatus = () => {
    if (conversation.isGroup) {
      return `${conversation.participants.length} members`;
    }
    return isOnline ? "Online" : "Offline";
  };

  const handleVoiceCall = () => {
    if (peerUser) {
      startCall(peerUser.id, false, user);
    }
  };

  const handleVideoCall = () => {
    if (peerUser) {
      startCall(peerUser.id, true, user);
    }
  };

  return (
    <div className="
      flex items-center justify-between px-4 py-3 z-30
      bg-bg-main
      border-b border-white/10
      shadow-[0_1px_0_rgba(255,255,255,0.05)] dark:shadow-[0_1px_0_rgba(0,0,0,0.2)]
      relative
    ">
      <div className="flex items-center gap-4">
        {/* Mobile Back Button */}
        <button 
          onClick={onMenuClick} 
          aria-label="Menu" 
          className="md:hidden p-3 text-text-secondary active:scale-95 transition-transform"
        >
          <FiMoreHorizontal size={24} />
        </button>
        <button 
          onClick={onBack} 
          aria-label="Back" 
          className="hidden md:block p-3 text-text-secondary hover:text-accent active:scale-95 transition-transform"
        >
          <FiArrowLeft size={20} />
        </button>

        {/* Identity Plate */}
        <button 
          onClick={handleHeaderClick} 
          className="group flex items-center gap-3 p-1 pr-4 rounded-xl transition-all"
        >
          <div className="relative">
             <div className="w-10 h-10 rounded-full shadow-neu-pressed dark:shadow-neu-pressed-dark border-2 border-bg-main p-0.5">
                <img
                  src={toAbsoluteUrl(avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${title}`}
                  alt="ID"
                  className="w-full h-full rounded-full object-cover"
                />
             </div>
             {isOnline && <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-bg-surface shadow-sm"></div>}
          </div>
          
          <div className="text-left">
            <div className="flex items-center gap-2">
              <p className="font-bold text-text-primary text-sm group-hover:text-accent transition-colors">{title}</p>
              {isConvVerified && <FiShield className="text-accent w-3 h-3" />}
            </div>
            <p className="text-xs text-text-secondary opacity-70">
              {getStatus()}
            </p>
          </div>
        </button>
      </div>

      {/* Action Module */}
      <div className="flex items-center gap-2 md:gap-3">
        {!conversation.isGroup && (
          <>
            <button 
              onClick={handleVoiceCall} 
              className="flex items-center justify-center w-9 h-9 rounded-full bg-bg-main text-text-secondary shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark transition-all duration-200"
            >
              <FiPhone size={16} />
            </button>
            <button 
              onClick={handleVideoCall} 
              className="flex items-center justify-center w-9 h-9 rounded-full bg-bg-main text-text-secondary shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark transition-all duration-200"
            >
              <FiVideo size={16} />
            </button>
          </>
        )}
        <SearchMessages conversationId={conversation.id} />
        <button 
          onClick={openChatInfoModal} 
          className="
            flex items-center justify-center w-9 h-9 rounded-full 
            bg-bg-main text-text-secondary
            shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent
            active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark transition-all duration-200
          "
        >
          {conversation.isGroup ? <FiUsers size={18} /> : <FiInfo size={18} />}
        </button>
      </div>
    </div>
  );
};

const ChatSpinner = () => (
  <div className="py-6 flex justify-center items-center">
    <Spinner size="sm" />
  </div>
);

export default function ChatWindow({ id, onMenuClick }: { id: string, onMenuClick: () => void }) {
  const meId = useAuthStore((s) => s.user?.id);
  const { conversation, messages, isLoading, error, actions, isFetchingMore } = useConversation(id);
  const loadMessagesForConversation = useMessageStore(s => s.loadMessagesForConversation);
  const openConversation = useConversationStore(state => state.openConversation);
  
  useEdgeSwipe(() => {
    if (window.innerWidth < 768) {
      openConversation(null);
    }
  });

  const { highlightedMessageId, setHighlightedMessageId } = useMessageSearchStore(state => ({
    highlightedMessageId: state.highlightedMessageId,
    setHighlightedMessageId: state.setHighlightedMessageId,
  }));
  const { handleStopRecording } = useMessageInputStore(state => ({
    handleStopRecording: state.handleStopRecording,
  }));
  
  const typingIndicators = usePresenceStore(state => state.typingIndicators);
  const virtuosoRef = useRef<any>(null);
  const [lightboxMessage, setLightboxMessage] = useState<Message | null>(null);
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (id) loadMessagesForConversation(id);
  }, [id, loadMessagesForConversation]);

  const handleImageClick = useCallback((message: Message) => setLightboxMessage(message), []);

  useEffect(() => {
    if (highlightedMessageId && virtuosoRef.current && messages.length > 0) {
      const index = messages.findIndex(m => m.id === highlightedMessageId);
      if (index !== -1) {
        virtuosoRef.current.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
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
    if (e.target.files?.[0]) actions.uploadFile(e.target.files[0]);
  };

  const handleVoiceSend = (blob: Blob, duration: number) => {
    handleStopRecording(id, blob, duration);
  };

  // Memoize stable conversation parts to prevent list re-renders
  const participants = useMemo(() => conversation?.participants || [], [conversation?.participants]);
  const isGroup = conversation?.isGroup || false;

  const itemContent = useCallback((index: number, message: Message) => {
    const prevMessage = messages[index - 1];
    const nextMessage = messages[index + 1];
    const isFirstInSequence = !prevMessage || prevMessage.senderId !== message.senderId;
    const isLastInSequence = !nextMessage || nextMessage.senderId !== message.senderId;

    return (
      <div className="px-1 md:px-4 py-0.5" key={message.id}>
        <MessageItem 
          message={message} 
          isGroup={isGroup}
          participants={participants}
          isHighlighted={message.id === highlightedMessageId}
          onImageClick={handleImageClick}
          isFirstInSequence={isFirstInSequence}
          isLastInSequence={isLastInSequence}
        />
      </div>
    );
  }, [messages, isGroup, participants, highlightedMessageId, handleImageClick]);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={id}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex flex-col h-full bg-bg-main relative overflow-hidden"
      >
        {(() => {
          if (error) {
            return (
              <div className="flex-1 flex flex-col items-center justify-center text-red-500 font-mono">
                <FiShield size={40} className="mb-4 opacity-50" />
                <p className="uppercase tracking-widest">Signal Lost</p>
                <p className="text-xs mt-2 opacity-70">{error}</p>
              </div>
            );
          }

          if (isLoading || !conversation) {
            return (
              <div className="flex-1 flex flex-col justify-end pb-20">
                <MessageSkeleton />
              </div>
            );
          }

          return (
            <>
              <ChatHeader 
                conversation={conversation} 
                onBack={() => navigate('/chat')} 
                onInfoToggle={() => setIsGroupInfoOpen(true)} 
                onMenuClick={onMenuClick} 
              />
              
              {messages.length === 0 && <NewConversationBanner />}

              {/* Main Display Screen */}
              <div className="flex-1 min-h-0 relative z-0 shadow-neu-pressed dark:shadow-neu-pressed-dark mx-2 md:mx-4 my-2 rounded-2xl bg-bg-main overflow-hidden">
                <div className="h-full px-4 md:px-6 pt-6 pb-2">
                  <Virtuoso
                    ref={virtuosoRef}
                    initialTopMostItemIndex={messages.length - 1}
                    data={messages}
                    startReached={actions.loadPrevious}
                    components={{ Header: () => isFetchingMore ? <ChatSpinner /> : <div className="h-4" /> }}
                    itemContent={itemContent}
                    followOutput="auto"
                  />
                </div>

                {/* Typing Indicator Overlay */}
                <AnimatePresence>
                  {typingUsersInThisConvo.length > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute bottom-4 left-6 z-20"
                    >
                      <div className="
                        px-4 py-2 rounded-full
                        bg-bg-surface/80 backdrop-blur-md border border-white/10
                        shadow-neumorphic-convex
                        flex items-center gap-3
                      ">
                        <div className="flex gap-1">
                          <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                          <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                          <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"></span>
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">Typing...</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {conversation.keyRotationPending && <KeyRotationBanner />}
              
              <MessageInput
                onSend={handleSendMessage}
                onTyping={handleTyping}
                onFileChange={handleFileChange}
                onVoiceSend={handleVoiceSend}
                conversation={conversation}
              />

              {lightboxMessage && <Lightbox message={lightboxMessage} onClose={() => setLightboxMessage(null)} />}
              {isGroupInfoOpen && <GroupInfoPanel conversationId={id} onClose={() => setIsGroupInfoOpen(false)} />}
            </>
          );
        })()}
      </motion.div>
    </AnimatePresence>
  );
}