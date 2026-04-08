import DefaultAvatar from "@/components/ui/DefaultAvatar";
import { useCallback, useRef, useState, useEffect, useMemo, lazy, Suspense } from "react";
import { useAuthStore } from "@store/auth";
import { useTranslation } from "react-i18next";
import { getSocket } from "@lib/socket";
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import MessageItem from "@components/MessageItem";
import { useConversation } from "@hooks/useConversation";
import { Spinner } from "./Spinner";
import { useConversationStore, type Conversation, type Message } from "@store/conversation";
import { useMessageStore } from '@store/message';
import { useMessageInputStore } from '@store/messageInput';
import { useMessageSearchStore } from '@store/messageSearch';
import { usePresenceStore } from "@store/presence";
import { toAbsoluteUrl } from "@utils/url";
import { useModalStore } from "@store/modal";
import { useShallow } from 'zustand/react/shallow';
import clsx from "clsx";
import { useVerificationStore } from '@store/verification';
import { FiShield, FiMoreHorizontal, FiArrowLeft, FiInfo, FiUsers, FiPhone, FiVideo, FiX, FiTrash2 } from 'react-icons/fi';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MessageInput from './MessageInput';
import MessageSkeleton from './MessageSkeleton';
import { useUserProfile } from '@hooks/useUserProfile';
import { useEdgeSwipe } from '@hooks/useEdgeSwipe';
import { useSettingsStore } from '@store/settings';
import type { MinimalProfile } from '@store/callStore';
import { asConversationId } from '@nyx/shared';

// ✅ 1. DYNAMIC IMPORTS: Komponen berat tidak perlu didownload di awal
const SearchMessages = lazy(() => import('./SearchMessages'));
const Lightbox = lazy(() => import('./Lightbox'));
const GroupInfoPanel = lazy(() => import('./GroupInfoPanel'));

const KeyRotationBanner = () => {
  const { t } = useTranslation(['chat']);
  return (
    <div className="bg-yellow-500/10 border-y border-yellow-500/20 px-4 py-3 text-yellow-600 dark:text-yellow-400">
      <div className="flex items-center gap-3">
        <FiShield className="flex-shrink-0 animate-pulse" size={18} />
        <div className="font-mono text-xs">
          <p className="font-bold uppercase tracking-wider">{t('banners.key_rotation')}</p>
          <p className="opacity-80">{t('banners.key_rotation_desc')}</p>
        </div>
      </div>
    </div>
  );
};

const NewConversationBanner = () => {
  const { t } = useTranslation(['chat']);
  return (
    <div className="bg-blue-500/10 border-y border-blue-500/20 px-4 py-3 text-blue-600 dark:text-blue-400">
      <div className="flex items-start gap-3">
        <FiInfo className="flex-shrink-0 mt-0.5" size={18} />
        <div className="font-mono text-xs">
          <p className="font-bold uppercase tracking-wider mb-1">{t('banners.encryption_recommendation')}</p>
          <p className="opacity-90 leading-relaxed">
            {t('banners.encryption_desc')}
          </p>
        </div>
      </div>
    </div>
  );
};

const ChatHeader = ({ conversation, onBack, onInfoToggle, onMenuClick }: { conversation: Conversation; onBack: () => void; onInfoToggle: () => void; onMenuClick: () => void; }) => {
  const { t } = useTranslation(['chat', 'common']);
  const user = useAuthStore((s) => s.user);
  const meId = user?.id;
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const { openProfileModal, openChatInfoModal } = useModalStore(useShallow(s => ({ openProfileModal: s.openProfileModal, openChatInfoModal: s.openChatInfoModal })));
  const { verifiedStatus } = useVerificationStore();
  const privacyCloak = useSettingsStore(s => s.privacyCloak);
  
  const cloakClass = privacyCloak ? "blur-[6px] opacity-70 group-hover:blur-none group-hover:opacity-100 group-active:blur-none group-active:opacity-100 transition-all duration-300 select-none" : "";

  const peerUser = !conversation.isGroup ? conversation.participants?.find((p) => p.id !== meId) : null;
  const peerProfile = useUserProfile(peerUser as unknown as { id: string; encryptedProfile?: string | null });
  const title = conversation.isGroup 
    ? (conversation.decryptedMetadata?.title || t('common:defaults.group_unknown', 'Unknown Group'))
    : peerProfile.name;
  const avatarUrl = conversation.isGroup 
    ? conversation.decryptedMetadata?.avatarUrl 
    : peerProfile.avatarUrl;
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
      return t('header.members', { count: conversation.participants.length });
    }
    return isOnline ? t('header.online') : t('header.offline');
  };

  const handleVoiceCall = async () => {
    if (peerUser) {
      const { startCall } = await import('@lib/webrtc');
      startCall(peerUser.id, false, (user as unknown as MinimalProfile) || { id: user?.id || 'unknown' });
    }
  };

  const handleVideoCall = async () => {
    if (peerUser) {
      const { startCall } = await import('@lib/webrtc');
      startCall(peerUser.id, true, (user as unknown as MinimalProfile) || { id: user?.id || 'unknown' });
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
          aria-label={t('common:actions.menu', 'Menu')} 
          className="md:hidden p-3 text-text-secondary active:scale-95 transition-transform"
        >
          <FiMoreHorizontal size={24} />
        </button>
        <button 
          onClick={onBack} 
          aria-label={t('common:actions.back', 'Back')} 
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
                {avatarUrl ? (
                  <img
                    src={toAbsoluteUrl(avatarUrl)}
                    alt={t('common:defaults.avatar', 'Avatar')}
                    className={clsx("w-full h-full rounded-full object-cover", cloakClass)}
                  />
                ) : (
                  <DefaultAvatar
                    name={title}
                    id={conversation.isGroup ? conversation.id : peerUser?.id}
                    className={clsx("w-full h-full", cloakClass)}
                  />
                )}
             </div>
             {isOnline && <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-bg-surface shadow-sm"></div>}
          </div>
          
          <div className="text-left">
            <div className="flex items-center gap-2">
              <p className={clsx("font-bold text-text-primary text-sm group-hover:text-accent transition-colors", cloakClass)}>{title}</p>
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
              aria-label={t('actions.voice_call')}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-bg-main text-text-secondary shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark transition-all duration-200"
            >
              <FiPhone size={16} />
            </button>
            <button
              onClick={handleVideoCall}
              aria-label={t('actions.video_call')}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-bg-main text-text-secondary shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark transition-all duration-200"
            >
              <FiVideo size={16} />
            </button>
          </>
        )}
        
        {/* ✅ SUSPENSE: Jaring pengaman saat fitur Search dimuat */}
        <Suspense fallback={<div className="w-9 h-9"></div>}>
            <SearchMessages conversationId={conversation.id} />
        </Suspense>

        <button
          onClick={openChatInfoModal}
          aria-label={t('actions.info')}
          className="
            flex items-center justify-center w-9 h-9 rounded-full
            bg-bg-main text-text-secondary
            shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent
            active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark transition-all duration-200
          "
        >
          {conversation.isGroup ? <FiUsers size={18} /> : <FiInfo size={18} />}
        </button>
      </div>    </div>
  );
};

const ChatSpinner = () => (
  <div className="py-6 flex justify-center items-center">
    <Spinner size="sm" />
  </div>
);

export default function ChatWindow({ id, onMenuClick }: { id: string, onMenuClick: () => void }) {
  const { t } = useTranslation(['chat', 'common']);
  const meId = useAuthStore((s) => s.user?.id);
  const { conversation, messages, isLoading, error, actions, isFetchingMore } = useConversation(id);
  const { loadMessagesForConversation, selectedMessageIds, clearMessageSelection, removeMessages } = useMessageStore(useShallow(s => ({
      loadMessagesForConversation: s.loadMessagesForConversation,
      selectedMessageIds: s.selectedMessageIds,
      clearMessageSelection: s.clearMessageSelection,
      removeMessages: s.removeMessages
  })));
  const isSelectionMode = selectedMessageIds.length > 0;
  const loadMessageContext = useMessageStore(s => s.loadMessageContext);
  const openConversation = useConversationStore(state => state.openConversation);
  const showConfirm = useModalStore(s => s.showConfirm);
  
  useEdgeSwipe(() => {
    if (window.innerWidth < 768) {
      openConversation(null);
    }
  });

  const { highlightedMessageId, setHighlightedMessageId } = useMessageSearchStore(useShallow(state => ({
    highlightedMessageId: state.highlightedMessageId,
    setHighlightedMessageId: state.setHighlightedMessageId,
  })));

  const handleStopRecording = useMessageInputStore(state => state.handleStopRecording);
  
  const typingIndicators = usePresenceStore(state => state.typingIndicators);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [lightboxMessage, setLightboxMessage] = useState<Message | null>(null);
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (id) {
        // Muat riwayat dan sinkronisasi pesan tertunda DARI SERVER
        loadMessagesForConversation(id);
    }
    // Bersihkan mode seleksi setiap kali pindah ruang chat
    clearMessageSelection();
  }, [id, loadMessagesForConversation, clearMessageSelection]);


  // 2. MARK AS READ: Hanya ACK pesan yang benar-benar terlihat di viewport
  // Menggunakan IntersectionObserver dari MessageItem.tsx yang sudah ada
  // untuk menghindari ACK pesan off-screen
  const visibleMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!id || !messages || !meId) return;

    const markUnreadAsRead = async () => {
         // Beri sedikit jeda agar pesan selesai di-render ke DOM (Virtuoso)
         await new Promise(r => setTimeout(r, 300));

         const socket = getSocket();
         if (!socket?.connected) return;

         // Hanya ACK pesan yang terlihat di viewport DAN belum READ
         const visibleMessageIds = visibleMessageIdsRef.current;
         const unreadVisible = messages.filter(m =>
             m.senderId !== meId &&
             visibleMessageIds.has(m.id) &&
             (!m.statuses || !m.statuses.some(s => s.userId === meId && s.status === 'READ'))
         );

         // Batasi maksimal 20 pesan sekaligus untuk mencegah spam socket
         const msgsToAck = unreadVisible.slice(-20);

         msgsToAck.forEach(msg => {
             socket.emit('message:mark_as_read', {
                 messageId: msg.id,
                 conversationId: id
             });
         });
    };

    markUnreadAsRead();
  }, [id, meId, messages.length]);

  // Expose visibility tracking ref untuk MessageItem
  const trackMessageVisibility = useCallback((messageId: string, visible: boolean) => {
    if (visible) {
      visibleMessageIdsRef.current.add(messageId);
    } else {
      visibleMessageIdsRef.current.delete(messageId);
    }
  }, []);

  const handleImageClick = useCallback((message: Message) => setLightboxMessage(message), []);

  const handleBulkDelete = () => {
    if (!conversation || !messages || !meId) return;

    const selectedMessages = messages.filter(m => selectedMessageIds.includes(m.id));
    const allMine = selectedMessages.every(m => m.senderId === meId);

    const confirmMessage = allMine 
      ? t('messages.bulk_delete_confirm', { count: selectedMessageIds.length })
      : t('messages.bulk_delete_confirm_mixed', { 
          count: selectedMessageIds.length, 
          defaultValue: `${t('messages.bulk_delete_confirm', { count: selectedMessageIds.length })} ${t('messages.bulk_delete_desc')}` 
        });

    showConfirm(
      t('actions.bulk_delete_title'),
      confirmMessage,
      async () => {
          await removeMessages(conversation.id, selectedMessageIds);
          toast.success(t('messages.processed', { count: selectedMessageIds.length }));
      }
    );
  };
  
  useEffect(() => {
    if (!highlightedMessageId) return;

    const handleJump = async () => {
      let el = document.getElementById(`msg-${highlightedMessageId}`);
      
      if (!el) {
        await loadMessageContext(highlightedMessageId);
        await new Promise(resolve => setTimeout(resolve, 300));
        el = document.getElementById(`msg-${highlightedMessageId}`);
      }

      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-bg-main', 'scale-[1.02]', 'transition-all', 'duration-500', 'z-10');
        
        setTimeout(() => {
          el?.classList.remove('ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-bg-main', 'scale-[1.02]', 'z-10');
          setHighlightedMessageId(null);
        }, 2000);
      }
    };

    handleJump();
  // ✅ 2. FIX DEPENDENCY: Hapus `messages` agar tidak re-render saat pesan baru masuk
  }, [highlightedMessageId, loadMessageContext, setHighlightedMessageId]);

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

  const handleVoiceSend = (blob: Blob, duration: number) => {
    handleStopRecording(id, blob, duration);
  };

  const participants = useMemo(() => conversation?.participants || [], [conversation?.participants]);
  const isGroup = conversation?.isGroup || false;

  // ✅ 3. FIX RE-RENDER MASSAL: Hapus `messages` dari dependency array
  const itemContent = useCallback((index: number, message: Message) => {
      // Cek pesan sebelum dan sesudahnya untuk menentukan bentuk gelembung chat
      const prevMessage = messages[index - 1];
      const nextMessage = messages[index + 1];
      
      const isFirstInSequence = !prevMessage || prevMessage.senderId !== message.senderId;
      const isLastInSequence = !nextMessage || nextMessage.senderId !== message.senderId;
      const stableKey = message.tempId ? `t-${message.tempId}` : message.id;
  
      return (
        <div className="px-1 md:px-4 py-0.5" key={message.id}>
          <MessageItem
            message={message}
            isGroup={isGroup}
            participants={participants}
            isHighlighted={message.id === highlightedMessageId}
            onImageClick={handleImageClick}
            isFirstInSequence={isFirstInSequence} // 👈 Props ini wajib ada
            isLastInSequence={isLastInSequence}   // 👈 Props ini wajib ada
            onVisibilityChange={trackMessageVisibility}
          />
        </div>
      );
    }, [messages, isGroup, participants, highlightedMessageId, handleImageClick, trackMessageVisibility]); // 👈 'messages' dikembalikan

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
                <p className="uppercase tracking-widest">{t('status.signal_lost')}</p>
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
              {isSelectionMode ? (
                  <div className="h-16 flex items-center justify-between px-4 bg-accent/10 border-b border-white/5 backdrop-blur-md z-30">
                      <div className="flex items-center gap-4">
                          <button onClick={clearMessageSelection} aria-label={t('common:actions.cancel_bracket')} className="p-2 hover:bg-white/10 rounded-full transition-colors text-text-secondary hover:text-white">
                              <FiX size={20} />
                          </button>
                          <span className="font-bold text-lg text-accent tracking-wide">{t('messages.selected_count', { count: selectedMessageIds.length })}</span>
                      </div>
                      <button
                          onClick={handleBulkDelete}
                          className="p-2 text-red-500 hover:bg-red-500/20 rounded-full transition-all active:scale-95 shadow-neumorphic-concave"
                          title={t('actions.delete_selected')}
                          aria-label={t('actions.delete_selected')}
                      >
                          <FiTrash2 size={20} />
                      </button>
                  </div>              ) : (
                  <ChatHeader 
                    conversation={conversation} 
                    onBack={() => navigate('/chat')} 
                    onInfoToggle={() => setIsGroupInfoOpen(true)} 
                    onMenuClick={onMenuClick} 
                  />
              )}
              
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
                    increaseViewportBy={200} // 🔥 Optimasi scroll cepat
                    computeItemKey={(index, item) => item.tempId ? `virtuoso-t-${item.tempId}` : `virtuoso-r-${item.id}`} // 🔥 Ini menghilangkan kedip/glitch dari framework list
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
                        <span className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">{t('header.typing')}</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {conversation.keyRotationPending && <KeyRotationBanner />}
              
              <MessageInput
                onSend={handleSendMessage}
                onTyping={handleTyping}
                onVoiceSend={handleVoiceSend}
                conversation={conversation}
              />

              {/* ✅ SUSPENSE: Jaring pengaman saat Lightbox atau Info Grup dipanggil */}
              <Suspense fallback={null}>
                {lightboxMessage && <Lightbox message={lightboxMessage} onClose={() => setLightboxMessage(null)} />}
                {isGroupInfoOpen && <GroupInfoPanel conversationId={asConversationId(id)} onClose={() => setIsGroupInfoOpen(false)} />}
              </Suspense>
            </>
          );
        })()}
      </motion.div>
    </AnimatePresence>
  );
}
