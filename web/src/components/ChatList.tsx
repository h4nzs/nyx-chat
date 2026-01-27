import { useState, useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import clsx from 'clsx';

import { useChatList } from '@hooks/useChatList';
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

const UserProfile = () => {
  const { user, logout } = useAuthStore(state => ({ user: state.user, logout: state.logout }));
  const { showConfirm } = useModalStore();

  const handleLogout = () => {
    showConfirm(
      "Confirm Logout",
      "Are you sure you want to end your session?",
      logout
    );
  };

  if (!user) return null;

  return (
    <div className="flex items-center justify-between px-6 py-6 bg-bg-main z-10">
      {/* Identity Slot */}
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="relative flex-shrink-0">
          <img 
            src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`} 
            alt="Avatar" 
            className="w-10 h-10 rounded-full object-cover shadow-neumorphic-convex border-2 border-bg-surface" 
          />
          <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border border-bg-surface"></div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary truncate">{user.name}</p>
          <p className="text-[10px] font-medium text-text-secondary truncate opacity-70">@{user.username}</p>
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
};

const SearchResults = ({ results, onSelect }: { results: User[], onSelect: (userId: string) => void }) => (
  <Virtuoso
    style={{ height: '100%' }}
    data={results}
    components={{
      Header: () => <p className="text-xs font-bold text-text-secondary px-6 mb-4 mt-2">GLOBAL SEARCH</p>,
      EmptyPlaceholder: () => <div className="p-6 text-center text-xs text-text-secondary">No users found.</div>,
    }}
    itemContent={(index, user) => (
      <button 
        key={user.id}
        onClick={() => onSelect(user.id)}
        className="
          w-[calc(100%-32px)] mx-4 mb-3 p-3 flex items-center gap-4 rounded-xl text-left
          bg-bg-surface transition-all
          shadow-neumorphic-convex hover:shadow-neumorphic-convex-sm
        "
      >
        <img src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`} alt="Avatar" className="w-10 h-10 rounded-full bg-secondary object-cover" />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-text-primary">{user.name}</p>
          <p className="text-xs text-text-secondary">@{user.username}</p>
        </div>
      </button>
    )}
  />
);

const ConversationItem = ({ conversation, meId, presence, blockedUserIds, blockUser, unblockUser, isActive, isSelected, onClick, onUserClick, onMenuSelect, onTogglePin }: {
  conversation: Conversation;
  meId?: string;
  presence: string[];
  blockedUserIds: string[];
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
  onUserClick: (userId: string) => void;
  onMenuSelect: (action: 'deleteGroup' | 'deleteChat') => void;
  onTogglePin: (id: string) => void;
}) => {
  const peerUser = !conversation.isGroup ? conversation.participants?.find(p => p.id !== meId) : null;
  const title = conversation.isGroup ? conversation.title : peerUser?.name || 'Conversation';
  const isOnline = peerUser ? presence.includes(peerUser.id) : false;
  const isUnread = conversation.unreadCount > 0;
  const isPinnedByMe = Boolean(conversation.participants?.some(p => p.id === meId && p.isPinned));

  const avatarSrc = conversation.isGroup 
    ? (conversation.avatarUrl ? `${toAbsoluteUrl(conversation.avatarUrl)}?t=${conversation.lastUpdated}` : `https://api.dicebear.com/8.x/initials/svg?seed=${conversation.title}`)
    : (peerUser?.avatarUrl ? toAbsoluteUrl(peerUser.avatarUrl) : `https://api.dicebear.com/8.x/initials/svg?seed=${title}`);

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
      layout 
      key={conversation.id} 
      className={clsx(
        'relative mx-4 my-3 rounded-2xl p-1 transition-all duration-200 select-none group',
        isActive 
          ? 'bg-bg-surface shadow-neumorphic-pressed' 
          : 'bg-bg-surface shadow-neumorphic-convex hover:-translate-y-0.5'
      )}
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
                p-1.5 rounded-full text-text-secondary 
                hover:bg-bg-main hover:text-accent
                transition-colors
              "
            >
              <FiMoreVertical size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={5} align="end" className="
              min-w-[160px] bg-bg-surface 
              rounded-xl shadow-neumorphic-convex
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
                    if (other) blockedUserIds.includes(other.id) ? unblockUser(other.id) : blockUser(other.id);
                  }}
                  className="w-full text-left px-3 py-2 text-xs font-medium rounded-lg cursor-pointer hover:bg-bg-main hover:text-accent outline-none transition-colors"
                >
                   {conversation.participants.find(p => p.id !== meId) && blockedUserIds.includes(conversation.participants.find(p => p.id !== meId)!.id) ? 'Unblock' : 'Block'} User
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
};


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

  return (
    <div className="h-full flex flex-col bg-bg-main relative overflow-hidden">
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
              shadow-neumorphic-concave
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
              itemContent={(index, c) => (
                <ConversationItem
                  conversation={c}
                  meId={meId}
                  presence={presence}
                  blockedUserIds={blockedUserIds}
                  blockUser={blockUser}
                  unblockUser={unblockUser}
                  isActive={c.id === activeId}
                  isSelected={index === selectedIndex}
                  onClick={() => handleConversationClick(c.id)}
                  onUserClick={openProfileModal}
                  onMenuSelect={(action) => {
                     if (action === 'deleteGroup') deleteGroup(c.id);
                     else deleteConversation(c.id);
                  }}
                  onTogglePin={togglePinConversation}
                />
              )}
            />
          )
        )}
      </div>
      
      {showGroupModal && <CreateGroupChat onClose={() => setShowGroupModal(false)} />}
    </div>
  );
}