import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import clsx from 'clsx';

import { useChatList } from '@hooks/useChatList';
import { useUserProfile } from '@hooks/useUserProfile';
import { useModalStore } from '@store/modal';
import { useCommandPaletteStore } from '@store/commandPalette';
import { useAuthStore } from '@store/auth';

import type { User } from '@store/auth';
import type { Conversation } from '@store/conversation';

import { toAbsoluteUrl } from '@utils/url';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FiUsers, FiSearch, FiMoreVertical, FiSettings, FiLogOut } from 'react-icons/fi';

import CreateGroupChat from './CreateGroupChat';
import NotificationBell from './NotificationBell';
import { Spinner } from './Spinner';


// --- Sub-components ---

const UserProfile = memo(() => {
  const { user, logout } = useAuthStore(state => ({ user: state.user, logout: state.logout }));
  const { showConfirm: confirmLogout } = useModalStore(state => ({ showConfirm: state.showConfirm }));
  const profile = useUserProfile(user);

  const handleLogout = useCallback(() => {
    confirmLogout(
      "Confirm Logout",
      "Are you sure you want to end your session?",
      logout
    );
  }, [logout, confirmLogout]);

  if (!user) return null;

  return (
    <div className="flex items-center justify-between px-6 py-6 bg-bg-main z-10">
      {/* Identity Slot */}
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="relative flex-shrink-0">
          <img 
            src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`} 
            alt="Avatar" 
            className="w-10 h-10 rounded-full object-cover shadow-neu-flat dark:shadow-neu-flat-dark border-2 border-bg-main" 
          />
          <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border border-bg-surface"></div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary truncate">{profile.name}</p>
          {user.isVerified && <span className="text-[10px] text-accent font-bold tracking-wider">VERIFIED</span>}
        </div>
      </div>

      {/* Control Cluster */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <NotificationBell />
        
        <Link 
          to="/settings" 
          aria-label="Settings" 
          className="btn-flat p-2 rounded-full text-text-secondary hover:text-text-primary transition-all"
        >
          <FiSettings size={20} />
        </Link>
        
        <button 
          onClick={handleLogout} 
          aria-label="Logout" 
          className="btn-flat p-2 rounded-full text-text-secondary hover:text-red-500 transition-all"
        >
          <FiLogOut size={20} />
        </button>
      </div>
    </div>
  );
});

const SearchResultItem = ({ user, onSelect }: { user: User, onSelect: (id: string) => void }) => {
  const profile = useUserProfile(user);
  return (
    <button 
      onClick={() => onSelect(user.id)}
      className="
        w-[calc(100%-32px)] mx-4 mb-3 p-3 flex items-center gap-4 rounded-xl text-left
        bg-bg-main transition-all
        shadow-neu-flat dark:shadow-neu-flat-dark hover:-translate-y-0.5
      "
    >
      <img src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`} alt="Avatar" className="w-10 h-10 rounded-full bg-secondary object-cover" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
           <p className="font-bold text-sm text-text-primary">{profile.name}</p>
           {user.isVerified && <div className="w-2 h-2 rounded-full bg-accent" title="Verified"></div>}
        </div>
      </div>
    </button>
  );
};

const SearchResults = memo(({ results, onSelect }: { results: User[], onSelect: (userId: string) => void }) => (
  <Virtuoso
    style={{ height: '100%' }}
    data={results}
    components={{
      Header: () => <p className="text-xs font-bold text-text-secondary px-6 mb-4 mt-2">GLOBAL SEARCH</p>,
      EmptyPlaceholder: () => <div className="p-6 text-center text-xs text-text-secondary">No users found.</div>,
    }}
    itemContent={(index, user) => <SearchResultItem key={user.id} user={user} onSelect={onSelect} />}
  />
));

const ConversationItem = memo(({ 
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
  onTogglePin 
}: {
  conversation: Conversation;
  meId?: string;
  isOnline: boolean;
  isBlocked: boolean;
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  isActive: boolean;
  onClick: () => void;
  onUserClick: (userId: string) => void;
  onMenuSelect: (action: 'deleteGroup' | 'deleteChat') => void;
  onTogglePin: (id: string) => void;
}) => {
  const peerUser = !conversation.isGroup ? conversation.participants?.find(p => p.id !== meId) : null;
  const peerProfile = useUserProfile(peerUser as any); // Cast as any because Participant might not perfectly match but has id and encryptedProfile
  const title = conversation.isGroup ? conversation.title : peerProfile.name || 'Conversation';
  const isUnread = conversation.unreadCount > 0;
  const isPinnedByMe = Boolean(conversation.participants?.some(p => p.id === meId && p.isPinned));

  const avatarSrc = conversation.isGroup 
    ? (conversation.avatarUrl ? `${toAbsoluteUrl(conversation.avatarUrl)}?t=${conversation.lastUpdated}` : `https://api.dicebear.com/8.x/initials/svg?seed=${conversation.title}`)
    : (peerProfile.avatarUrl ? toAbsoluteUrl(peerProfile.avatarUrl) : `https://api.dicebear.com/8.x/initials/svg?seed=${title}`);

  const formatConversationTime = useCallback((timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffInDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffInDays === 1) return 'Yesterday';
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, []);

  const previewText = conversation.lastMessage?.content || conversation.lastMessage?.preview || 'No messages yet';

  return (
    <motion.div 
      // Removed 'layout' prop for performance
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
      <div className="w-full text-left p-3 pr-8 flex items-center gap-4 cursor-pointer rounded-xl" onClick={onClick}>
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
              alt="Avatar"
              className={clsx(
                "w-12 h-12 rounded-full object-cover border-2 transition-all",
                isActive ? "border-bg-surface shadow-inner" : "border-bg-main shadow-sm"
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
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center mb-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {isPinnedByMe && (
                <span className="text-accent flex-shrink-0">
                   <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 8 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </span>
              )}
              <p className={clsx(
                "text-sm font-bold truncate transition-colors",
                isActive ? 'text-accent' : 'text-text-primary'
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
            <p className={clsx(
              "text-xs truncate max-w-[85%]",
              isUnread ? 'font-bold text-text-primary' : 'text-text-secondary opacity-80'
            )}>
              {previewText}
            </p>
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

      {/* Dropdown Menu */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button 
              onClick={(e) => e.stopPropagation()} 
              aria-label="Options" 
              className="
                p-3 rounded-full text-text-secondary 
                hover:bg-bg-main hover:text-accent
                transition-colors
              "
            >
              <FiMoreVertical size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={5} align="end" className="
              min-w-[160px] bg-bg-main 
              rounded-xl shadow-neu-float dark:shadow-neu-float-dark
              border border-white/50 dark:border-white/5
              p-1.5 z-50
            ">
              <DropdownMenu.Item
                onSelect={() => onTogglePin(conversation.id)}
                className="w-full text-left px-3 py-2 text-xs font-medium rounded-lg cursor-pointer hover:bg-bg-main hover:text-accent outline-none transition-colors"
              >
                {isPinnedByMe ? 'Unpin' : 'Pin'} Chat
              </DropdownMenu.Item>
              
              {!conversation.isGroup && (
                <DropdownMenu.Item
                  onSelect={() => {
                    const other = conversation.participants.find(p => p.id !== meId);
                    if (other) {
                      isBlocked ? unblockUser(other.id) : blockUser(other.id);
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-xs font-medium rounded-lg cursor-pointer hover:bg-bg-main hover:text-accent outline-none transition-colors"
                >
                   {isBlocked ? 'Unblock' : 'Block'} User
                </DropdownMenu.Item>
              )}
              
              <div className="h-px bg-border my-1" />
              
              <DropdownMenu.Item
                onSelect={() => onMenuSelect(conversation.isGroup ? 'deleteGroup' : 'deleteChat')}
                className="w-full text-left px-3 py-2 text-xs font-medium text-red-500 rounded-lg cursor-pointer hover:bg-red-500/10 outline-none transition-colors"
              >
                {conversation.isGroup ? 'Delete Group' : 'Delete Chat'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </motion.div>
  );
}, (prev, next) => {
  // Custom comparison for Memo
  return (
    prev.conversation === next.conversation &&
    prev.isActive === next.isActive &&
    prev.isOnline === next.isOnline &&
    prev.isBlocked === next.isBlocked &&
    prev.meId === next.meId
  );
});


// --- Main Component ---

export default function ChatList() {
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
  } = useAuthStore(state => ({
    blockedUserIds: state.blockedUserIds,
    blockUser: state.blockUser,
    unblockUser: state.unblockUser
  }));

  const { showConfirm, openProfileModal } = useModalStore(state => ({
    showConfirm: state.showConfirm,
    openProfileModal: state.openProfileModal,
  }));

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const { addCommands, removeCommands } = useCommandPaletteStore();

  const openCreateGroupModal = useCallback(() => setShowGroupModal(true), []);

  useEffect(() => {
    const commands = [{
      id: 'new-group', name: 'New Group', action: openCreateGroupModal,
      icon: <FiUsers />, section: 'General', keywords: 'create group chat conversation',
    }];
    addCommands(commands);
    return () => removeCommands(commands.map(c => c.id));
  }, [addCommands, removeCommands, openCreateGroupModal]);

  // Memoized Item Renderer to prevent re-creating the function on every render
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
      />
    );
  }, [meId, presence, blockedUserIds, activeId, selectedIndex, handleConversationClick, openProfileModal, deleteGroup, deleteConversation, togglePinConversation, blockUser, unblockUser]);

  return (
    <div className="
      h-full flex flex-col bg-bg-main relative overflow-hidden
      border-r border-black/5 dark:border-white/5 
      shadow-[1px_0_0_rgba(255,255,255,0.5)] dark:shadow-[1px_0_0_rgba(0,0,0,0.5)]
    ">
      {/* Top Section */}
      <UserProfile />
      
      <div className="px-6 pb-6">
        <div className="relative group">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-secondary z-10 pointer-events-none">
            <FiSearch size={18} />
          </div>
          <input
            id="global-search-input"
            type="text"
            placeholder="Search..."
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
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <button 
              onClick={openCreateGroupModal} 
              title="New Group Chat"
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

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4 scrollbar-hide">
        {isLoading && (
          <div className="flex justify-center items-center h-full">
            <Spinner />
          </div>
        )}
        
        {error && !isLoading && (
          <div className="p-6 mx-4 text-center">
            <div className="text-red-500 font-bold mb-2 text-sm">Connection Error</div>
            <button 
              onClick={handleRetry}
              className="px-4 py-2 rounded-full bg-bg-surface shadow-neumorphic-convex text-xs font-bold hover:text-red-500 active:shadow-neumorphic-pressed"
            >
              Reconnect
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
                    <p className="text-sm font-medium">No conversations yet</p>
                  </div>
                ),
              }}
              itemContent={itemContent}
            />
          )
        )}
      </div>
      
      {showGroupModal && <CreateGroupChat onClose={() => setShowGroupModal(false)} />}
    </div>
  );
}