import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import clsx from 'clsx';

import { useChatList } from '@hooks/useChatList';
import { useUserProfile } from '@hooks/useUserProfile';
import { useModalStore } from '@store/modal';
import { useCommandPaletteStore } from '@store/commandPalette';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';

import type { User } from '@store/auth';
import type { Conversation } from '@store/conversation';

import { toAbsoluteUrl } from '@utils/url';

import { FiUsers, FiSearch, FiSettings, FiLogOut, FiUser, FiMaximize2, FiSlash, FiTrash2, FiEye, FiEyeOff, FiLock } from 'react-icons/fi';
import { BiQrScan } from 'react-icons/bi';

import CreateGroupChat from './CreateGroupChat';
import ScanQRModal from './ScanQRModal';
import ShareProfileModal from './ShareProfileModal';
import NotificationBell from './NotificationBell';
import { Spinner } from './Spinner';
import SwipeableItem from './SwipeableItem';
import { useContextMenuStore } from '../store/contextMenu';
import { useSettingsStore } from '@store/settings';
import StoryTray from './StoryTray';
import type { UserId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

// --- Sub-components ---

const UserProfile = memo(function UserProfile() {
  const { t } = useTranslation(['modals', 'common']);
  const { user, logout } = useAuthStore(useShallow(state => ({ user: state.user, logout: state.logout })));
  const { showConfirm: confirmLogout } = useModalStore(useShallow(state => ({ showConfirm: state.showConfirm })));
  const { privacyCloak, setPrivacyCloak } = useSettingsStore(useShallow(s => ({ privacyCloak: s.privacyCloak, setPrivacyCloak: s.setPrivacyCloak })));
  const profile = useUserProfile(user);

  const [showShareModal, setShowShareModal] = useState(false);

  const handleLogout = useCallback(() => {
    confirmLogout(
      t('modals:logout.title', 'Confirm Logout'),
      t('modals:logout.desc', 'Are you sure you want to end your session?'),
      logout
    );
  }, [logout, confirmLogout, t]);

  const handleLockVault = useCallback(() => {
    // Clear decoy state and force reload to trigger the lock screen
    sessionStorage.removeItem('nyx_decoy_mode');
    window.location.reload();
  }, []);

  if (!user) return null;

  return (
    <>
      <div className="flex items-center justify-between px-6 py-6 bg-bg-main z-10">
        <div className="flex items-center gap-3 overflow-hidden cursor-pointer group" onClick={() => setShowShareModal(true)}>
          <div className="relative flex-shrink-0">
            <img 
              src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name || t('common:defaults.user')}`} 
              alt={t('common:defaults.avatar', 'Avatar')} 
              className="w-10 h-10 rounded-full object-cover shadow-neu-flat dark:shadow-neu-flat-dark border-2 border-bg-main group-hover:border-accent transition-colors" 
            />
            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border border-bg-surface"></div>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-text-primary truncate group-hover:text-accent transition-colors">{profile.name}</p>
            {user.isVerified && <span className="text-[10px] text-accent font-bold tracking-wider">{t('modals:user_info.verified', 'VERIFIED')}</span>}
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <NotificationBell />
          {/* PRIVACY CLOAK BUTTON */}
          <button
            onClick={() => setPrivacyCloak(!privacyCloak)}
            className={clsx(
              "p-2.5 rounded-xl transition-all shadow-neumorphic-concave focus:outline-none",
              privacyCloak ? "text-accent bg-white/5" : "text-text-secondary hover:text-accent hover:bg-white/5"
            )}
            title={t('common:actions.toggle_cloak', 'Toggle Privacy Cloak')}
            aria-label={t('common:actions.toggle_cloak', 'Toggle Privacy Cloak')}
          >
            {privacyCloak ? <FiEyeOff size={18} /> : <FiEye size={18} />}
          </button>
          <Link 
            to="/settings" 
            aria-label={t('common:actions.settings', 'Settings')}
            title={t('common:actions.settings', 'Settings')}
            className="btn-flat p-2 rounded-full text-text-secondary hover:text-text-primary transition-all"
          >
            <FiSettings size={20} />
          </Link>
          <button 
            onClick={handleLogout} 
            aria-label={t('common:actions.logout', 'Logout')}
            title={t('common:actions.logout', 'Logout')}
            className="btn-flat p-2 rounded-full text-text-secondary hover:text-red-500 transition-all"
          >
            <FiLogOut size={20} />
          </button>
        </div>
      </div>
      {showShareModal && <ShareProfileModal onClose={() => setShowShareModal(false)} />}
    </>
  );
});

const SearchResultItem = ({ user, onSelect }: { user: User, onSelect: (user: User) => void }) => {
  const { t } = useTranslation(['common']);
  const profile = useUserProfile(user);
  // Prioritize the direct user property which might contain the optimistic rawQuery
  const displayName = user.name || profile.name || t('common:defaults.user');
  const displayUsername = user.username || t('common:defaults.unknown');

  return (
    <button 
      onClick={() => onSelect(user)}
      className="
        w-[calc(100%-32px)] mx-4 mb-3 p-3 flex items-center gap-4 rounded-xl text-left
        bg-bg-main transition-all
        shadow-neu-flat dark:shadow-neu-flat-dark hover:-translate-y-0.5
      "
    >
      <img src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${displayName}`} alt={t('common:defaults.avatar', 'Avatar')} className="w-10 h-10 rounded-full bg-secondary object-cover" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
           <p className="font-bold text-sm text-text-primary">{displayName}</p>
           {user.isVerified && <div className="w-2 h-2 rounded-full bg-accent" title={t('modals:user_info.verified', 'Verified')}></div>}
        </div>
        <p className="text-xs text-text-secondary font-mono mt-0.5">@{displayUsername}</p>
      </div>
    </button>
  );
};

const SearchResults = memo(function SearchResults({ results, onSelect }: { results: User[], onSelect: (user: User) => void }) {
  const { t } = useTranslation('chat');
  return (
    <Virtuoso
      style={{ height: '100%' }}
      data={results}
      components={{
        Header: () => <p className="text-xs font-bold text-text-secondary px-6 mb-4 mt-2">{t('sidebar.global_search')}</p>,
        EmptyPlaceholder: () => <div className="p-6 text-center text-xs text-text-secondary">{t('sidebar.no_users')}</div>,
      }}
      itemContent={(index, user) => <SearchResultItem key={user.id} user={user} onSelect={onSelect} />}
    />
  );
});

const ConversationItem = memo(function ConversationItem({ 
  conversation, 
  meId, 
  isOnline, 
  isBlocked, 
  blockUser, 
  unblockUser, 
  isActive,
  onClick, 
  onUserClick, 
  onMenuSelect, 
  onTogglePin,
  privacyCloak
}: {
  conversation: Conversation;
  meId?: UserId;
  isOnline: boolean;
  isBlocked: boolean;
  blockUser: (userId: UserId) => Promise<void>;
  unblockUser: (userId: UserId) => Promise<void>;
  isActive: boolean;
  onClick: () => void;
  onUserClick: (userId: UserId) => void;
  onMenuSelect: (action: 'deleteGroup' | 'deleteChat') => void;
  onTogglePin: (id: string) => void;
  privacyCloak: boolean;
}) {
  const { t, i18n } = useTranslation(['chat', 'common']);
  const peerUser = !conversation.isGroup ? conversation.participants?.find(p => p.id !== meId) : null;
  const peerProfile = useUserProfile(peerUser as { id: string; encryptedProfile?: string | null });
  const title = conversation.isGroup ? conversation.title : peerProfile.name || t('common:defaults.conversation', 'Conversation');
  const isUnread = conversation.unreadCount > 0;
  const isPinnedByMe = Boolean(conversation.participants?.some(p => p.id === meId && p.isPinned));
  const openMenu = useContextMenuStore(s => s.openMenu);
  
  const cloakClass = privacyCloak ? "blur-[6px] opacity-70 group-hover:blur-none group-hover:opacity-100 group-active:blur-none group-active:opacity-100 transition-all duration-300 select-none" : "";

  const avatarSrc = conversation.isGroup 
    ? (conversation.avatarUrl ? `${toAbsoluteUrl(conversation.avatarUrl)}?t=${conversation.lastUpdated}` : `https://api.dicebear.com/8.x/initials/svg?seed=${conversation.title}`)
    : (peerProfile.avatarUrl ? toAbsoluteUrl(peerProfile.avatarUrl) : `https://api.dicebear.com/8.x/initials/svg?seed=${title}`);

  const formatConversationTime = useCallback((timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();

    // Create Date objects for midnight today and midnight yesterday
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    // Use Intl.DateTimeFormat for better localization support
    if (messageDate.getTime() === today.getTime()) {
        return new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(date);
    }
    if (messageDate.getTime() === yesterday.getTime()) {
        return t('common:time.yesterday', 'Yesterday');
    }
    return new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(date);
  }, [i18n.language, t]);
  const renderPreviewText = () => {
    if (!conversation.lastMessage) return t('chat:messages.no_messages_yet', 'No messages yet');
    if (conversation.lastMessage.isViewOnce) {
        return (
            <span className="flex items-center gap-1 text-accent text-sm font-medium">
               {conversation.lastMessage.isViewed ? (
                 <span className="flex items-center gap-1"><FiLock size={12} /> {t('chat:messages.opened', 'Opened')}</span>
               ) : (
                 <span className="flex items-center gap-1"><FiEyeOff size={12} /> {t('chat:messages.view_once_message', 'View once message')}</span>
               )}
            </span>
        );
    }
    if (conversation.lastMessage.preview !== undefined) {
        return conversation.lastMessage.preview || t('chat:messages.no_messages_yet', 'No messages yet');
    }
    return conversation.lastMessage.content || t('chat:messages.no_messages_yet', 'No messages yet');
  };

  const previewText = renderPreviewText();

  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    openMenu(e, [
      ...(peerUser ? [{ label: t('chat:actions.view_profile', 'View Profile'), icon: <FiUser />, onClick: () => onUserClick(peerUser.id) }] : []),
      { label: isPinnedByMe ? t('chat:actions.unpin_chat', 'Unpin Chat') : t('chat:actions.pin_chat', 'Pin Chat'), icon: <FiMaximize2 />, onClick: () => onTogglePin(conversation.id) },
      ...(!conversation.isGroup ? [{ label: isBlocked ? t('chat:actions.unblock_user', 'Unblock User') : t('chat:actions.block_user', 'Block User'), icon: <FiSlash />, onClick: () => {
         const other = conversation.participants.find(p => p.id !== meId);
         if (other) {
           if (isBlocked) unblockUser(other.id);
           else blockUser(other.id);
         }
      } }] : []),
      { label: conversation.isGroup ? t('chat:actions.delete_group', 'Delete Group') : t('chat:actions.delete_chat', 'Delete Chat'), icon: <FiTrash2 />, destructive: true, onClick: () => onMenuSelect(conversation.isGroup ? 'deleteGroup' : 'deleteChat') },
    ]);
  };

  return (
    <motion.div 
      key={conversation.id} 
      className={clsx(
        'relative mx-4 my-3 rounded-2xl p-1 transition-all duration-200 select-none group',
        isActive 
          ? 'bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark border border-transparent' 
          : 'bg-bg-main shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5 active:scale-[0.98]'
      )}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <SwipeableItem
        leftAction={{ icon: <FiMaximize2 size={24} />, color: isPinnedByMe ? 'bg-blue-500' : 'bg-green-500', onAction: () => onTogglePin(conversation.id) }}
        rightAction={{ icon: <FiTrash2 size={24} />, color: 'bg-red-500', onAction: () => onMenuSelect(conversation.isGroup ? 'deleteGroup' : 'deleteChat') }}
      >
        <div 
          onContextMenu={handleContextMenu}
          className="w-full text-left p-3 pr-4 flex items-center gap-4 cursor-pointer rounded-xl bg-bg-main" 
          onClick={onClick}
        >
          {/* Avatar */}
          <div className="relative flex-shrink-0">
            <button 
              onClick={(e) => {
                if (peerUser) {
                  e.stopPropagation();
                  onUserClick(peerUser.id);
                }
              }}
              disabled={!peerUser}
              className="block"
            >
              <img
                src={avatarSrc}
                alt={t('common:defaults.avatar', 'Avatar')}
                className={clsx(
                  "w-12 h-12 rounded-full object-cover border-2 transition-all pointer-events-none",
                  isActive ? "border-bg-surface shadow-inner" : "border-bg-main shadow-sm",
                  cloakClass
                )}
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  if (conversation.isGroup) {
                    target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${conversation.title}`;
                  } else {
                    target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${title}`;
                  }
                }}
              />
            </button>
            {peerUser && (
              <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-bg-surface ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`} />
            )}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0 pointer-events-none">
            <div className="flex justify-between items-center mb-0.5">
              <div className="flex items-center gap-1.5 min-w-0">
                {isPinnedByMe && (
                  <span className="text-accent flex-shrink-0">
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 8 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                  </span>
                )}
                <p className={clsx(
                  "text-sm font-bold truncate transition-colors",
                  isActive ? 'text-accent' : 'text-text-primary',
                  cloakClass
                )}>
                  {title}
                </p>
              </div>
              {conversation.lastMessage && (
                <p className="text-[10px] font-medium text-text-secondary flex-shrink-0 opacity-80">
                  {formatConversationTime(conversation.lastMessage.createdAt)}
                </p>
              )}
            </div>
            
            <div className="flex justify-between items-center">
              <div className={clsx(
                "text-xs truncate max-w-[85%]",
                isUnread ? 'font-bold text-text-primary' : 'text-text-secondary opacity-80',
                cloakClass
              )}>
                {previewText}
              </div>
              {isUnread && (
                <span className="
                  flex items-center justify-center min-w-[1.25rem] h-5 px-1.5
                  bg-accent text-white text-[10px] font-bold 
                  rounded-full shadow-sm
                ">
                  {conversation.unreadCount}
                </span>
              )}
            </div>
          </div>
        </div>
      </SwipeableItem>
    </motion.div>
  );
}, (prev, next) => {
  return (
    prev.conversation === next.conversation &&
    prev.isActive === next.isActive &&
    prev.isOnline === next.isOnline &&
    prev.isBlocked === next.isBlocked &&
    prev.meId === next.meId &&
    prev.privacyCloak === next.privacyCloak
  );
});

// --- Main Component ---

export default function ChatList() {
  const { t } = useTranslation(['chat', 'common']);
  const navigate = useNavigate();
  const {
    conversations,
    searchResults,
    searchQuery,
    showSearchResults,
    isLoading,
    error,
    activeId,
    presence,
    meId,
    setSearchQuery,
    handleConversationClick,
    handleSelectUser,
    handleRetry,
    deleteGroup,
    deleteConversation,
    togglePinConversation,
  } = useChatList();

  const {
    blockedUserIds,
    blockUser,
    unblockUser
  } = useAuthStore(useShallow(state => ({
    blockedUserIds: state.blockedUserIds,
    blockUser: state.blockUser,
    unblockUser: state.unblockUser
  })));

  const { showConfirm, openProfileModal } = useModalStore(useShallow(state => ({
    showConfirm: state.showConfirm,
    openProfileModal: state.openProfileModal,
  })));

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const { addCommands, removeCommands } = useCommandPaletteStore(useShallow(s => ({
    addCommands: s.addCommands, removeCommands: s.removeCommands
  })));
  const privacyCloak = useSettingsStore(s => s.privacyCloak);

  const openCreateGroupModal = useCallback(() => setShowGroupModal(true), []);

  useEffect(() => {
    const commands = [{
      id: 'new-group', name: t('chat:sidebar.new_group'), action: openCreateGroupModal,
      icon: <FiUsers />, section: 'General', keywords: 'create group chat conversation',
    }];
    addCommands(commands);
    return () => removeCommands(commands.map(c => c.id));
  }, [addCommands, removeCommands, openCreateGroupModal, t]);

  const itemContent = useCallback((index: number, c: Conversation) => {
    const peerUser = !c.isGroup ? c.participants?.find(p => p.id !== meId) : null;
    const isOnline = peerUser ? presence.includes(peerUser.id) : false;
    const isBlocked = peerUser ? blockedUserIds.includes(peerUser.id) : false;

    return (
      <ConversationItem
        conversation={c}
        meId={meId}
        isOnline={isOnline}
        isBlocked={isBlocked}
        blockUser={blockUser}
        unblockUser={unblockUser}
        isActive={c.id === activeId}
        onClick={() => handleConversationClick(c.id)}
        onUserClick={openProfileModal}
        onMenuSelect={(action) => {
           if (action === 'deleteGroup') deleteGroup(c.id);
           else deleteConversation(c.id);
        }}
        onTogglePin={togglePinConversation}
        privacyCloak={privacyCloak}
      />
    );
  }, [meId, presence, blockedUserIds, activeId, handleConversationClick, openProfileModal, deleteGroup, deleteConversation, togglePinConversation, blockUser, unblockUser, privacyCloak]);

  return (
    <div className="
      h-full flex flex-col bg-bg-main relative overflow-hidden
      border-r border-black/5 dark:border-white/5 
      shadow-[1px_0_0_rgba(255,255,255,0.5)] dark:shadow-[1px_0_0_rgba(0,0,0,0.5)]
    ">
      {/* Top Section */}
      <UserProfile />
      
      <div className="px-6 pb-2">
        <div className="relative group">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-secondary z-10 pointer-events-none">
            <FiSearch size={18} />
          </div>
          <input
            id="global-search-input"
            type="text"
            placeholder={t('chat:sidebar.search_placeholder')}
            className="
              w-full h-12 pl-12 pr-12 rounded-full
              bg-bg-main text-text-primary font-medium
              shadow-neu-pressed dark:shadow-neu-pressed-dark
              focus:ring-2 focus:ring-accent/50 outline-none
              transition-all placeholder:text-text-secondary/50
            "
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
            <button 
              onClick={() => setShowScanModal(true)} 
              title={t('chat:sidebar.scan_qr')}
              aria-label={t('chat:sidebar.scan_qr')}
              className="
                p-2 rounded-full text-text-secondary
                hover:text-accent active:scale-95 transition-all
              "
            >
              <BiQrScan size={18} />
            </button>
            <button 
              onClick={openCreateGroupModal} 
              title={t('chat:sidebar.new_group')}
              aria-label={t('chat:sidebar.new_group')}
              className="
                p-2 rounded-full text-text-secondary
                hover:text-accent active:scale-95 transition-all
              "
            >
              <FiUsers size={20} />
            </button>
          </div>
        </div>
      </div>

      {/* STORY TRAY */}
      {!searchQuery && <StoryTray />}

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4 pt-2 scrollbar-hide">
        {isLoading && (
          <div className="flex justify-center items-center h-full">
            <Spinner />
          </div>
        )}
        
        {error && !isLoading && (
          <div className="p-6 mx-4 text-center">
            <div className="text-red-500 font-bold mb-2 text-sm">{t('chat:sidebar.connection_error')}</div>
            <button 
              onClick={handleRetry}
              className="px-4 py-2 rounded-full bg-bg-surface shadow-neumorphic-convex text-xs font-bold hover:text-red-500 active:shadow-neumorphic-pressed"
            >
              {t('chat:sidebar.reconnect')}
            </button>
          </div>
        )}

        {!error && !isLoading && (
          showSearchResults ? (
            <SearchResults results={searchResults} onSelect={handleSelectUser} />
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: '100%' }}
              data={conversations}
              components={{
                Header: () => <div className="h-2"></div>,
                EmptyPlaceholder: () => (
                  <div className="flex flex-col items-center justify-center h-40 text-text-secondary/50">
                    <p className="text-sm font-medium">{t('chat:sidebar.no_conversations')}</p>
                  </div>
                ),
              }}
              itemContent={itemContent}
            />
          )
        )}
      </div>
      
      {showGroupModal && <CreateGroupChat onClose={() => setShowGroupModal(false)} />}
      {showScanModal && (
        <ScanQRModal 
          onClose={() => setShowScanModal(false)} 
          onScanSuccess={(hash) => {
            setShowScanModal(false);
            navigate(`/connect?u=${hash}`);
          }} 
        />
      )}
    </div>
  );
}
