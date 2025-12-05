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

import { sanitizeText } from '@utils/sanitize';
import { toAbsoluteUrl } from '@utils/url';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FiUsers } from 'react-icons/fi';

import CreateGroupChat from './CreateGroupChat';
import NotificationBell from './NotificationBell';
import { Spinner } from './Spinner';


// --- Sub-components ---

const UserProfile = () => {
  const { user, logout } = useAuthStore(state => ({ user: state.user, logout: state.logout }));
  if (!user) return null;

  return (
    <div className="p-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <img src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`} alt="Avatar" className="w-10 h-10 rounded-full bg-secondary object-cover" />
        <div>
          <p className="text-lg font-semibold text-text-primary">{user.name}</p>
          <p className="text-xs text-text-secondary">Available</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <NotificationBell />
        <Link to="/settings" aria-label="Settings" className="btn-flat p-2 rounded-full text-text-secondary transition-all">
          <motion.svg whileHover={{ rotate: 90 }} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></motion.svg>
        </Link>
        <button onClick={logout} aria-label="Logout" className="btn-flat p-2 rounded-full text-text-secondary transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
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
      Header: () => <p className="text-xs font-bold text-text-secondary px-4 mb-2">SEARCH RESULTS</p>,
      EmptyPlaceholder: () => <div className="p-4 text-center text-sm text-text-secondary">No users found.</div>,
    }}
    itemContent={(index, user) => (
      <button 
        key={user.id}
        onClick={() => onSelect(user.id)}
        className="w-full text-left p-3 flex items-center gap-3 rounded-lg hover:bg-secondary transition-colors"
      >
        <img src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`} alt="Avatar" className="w-12 h-12 rounded-full bg-secondary object-cover" />
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold truncate text-text-primary">{user.name}</p>
          <p className="text-sm truncate text-text-secondary">@{user.username}</p>
        </div>
      </button>
    )}
  />
);

const ConversationItem = ({ conversation, meId, presence, isActive, isSelected, onClick, onUserClick, onMenuSelect, onTogglePin }: {
  conversation: Conversation;
  meId?: string;
  presence: string[];
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

  const itemClasses = clsx(
    'relative flex items-center justify-between mx-3 my-2 rounded-lg transition-all duration-200',
    {
      'bg-bg-surface shadow-neumorphic-pressed': isActive,
      'shadow-neumorphic-convex hover:shadow-neumorphic-pressed': !isActive,
      'ring-2 ring-accent ring-offset-2 ring-offset-bg-main': isSelected,
    }
  );

  const previewText = conversation.lastMessage?.content || conversation.lastMessage?.preview || 'No messages yet';

  return (
    <motion.div layout key={conversation.id} className={itemClasses}>
      <div className="w-full text-left p-3 pr-10 flex items-center gap-3" onClick={onClick}>
        <div className="relative flex-shrink-0">
          <button 
            onClick={(e) => {
              if (peerUser) {
                e.stopPropagation();
                onUserClick(peerUser.id);
              }
            }}
            disabled={!peerUser}
            className="disabled:cursor-default"
          >
            <img src={avatarSrc} alt="Avatar" className="w-12 h-12 rounded-full bg-secondary object-cover" />
          </button>
          {peerUser && <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-bg-surface ${isOnline ? 'bg-green-500' : 'bg-gray-500'}`} />}
        </div>
        <div className="flex-1 min-w-0 cursor-pointer">
          <div className="flex justify-between items-start">
            <div className="flex items-center">
              {conversation.participants.some(p => p.id === meId && p.isPinned) && (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1 text-accent flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                  <circle cx="12" cy="10" r="3"></circle>
                </svg>
              )}
              <p className={`text-base font-semibold truncate ${isActive ? 'text-accent' : 'text-text-primary'}`}>{title}</p>
            </div>
            {conversation.lastMessage && <p className={`text-xs flex-shrink-0 ml-2 ${isActive ? 'text-text-secondary' : 'text-text-secondary'}`}>{formatConversationTime(conversation.lastMessage.createdAt)}</p>}
          </div>
          <div className="flex justify-between items-center mt-1">
            <p className={`text-sm truncate ${isUnread ? 'font-bold text-text-primary' : 'text-text-secondary'}`}>
              {previewText}
            </p>
            {isUnread && (
              <span className="bg-accent text-accent-foreground text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center flex-shrink-0 ml-2">
                {conversation.unreadCount}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="absolute right-2 top-1/2 -translate-y-1/2">
        <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                  <button onClick={(e) => e.stopPropagation()} aria-label="Conversation options" className={clsx(
                                    'p-2 rounded-full text-text-secondary active:shadow-neumorphic-pressed transition-all',
                                    { 'shadow-neumorphic-convex-sm': isActive }
                                  )}>
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-text-secondary" viewBox="0 0 20 20" fill="currentColor"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg>
                                  </button>
                                </DropdownMenu.Trigger>          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={5} align="end" className="min-w-[180px] bg-surface/80 backdrop-blur-sm rounded-md shadow-lg z-50 p-1">
              <DropdownMenu.Item
                onSelect={() => onTogglePin(conversation.id)}
                className="block w-full text-left px-3 py-2 text-sm rounded cursor-pointer outline-none hover:bg-secondary"
              >
                {conversation.participants.some(p => p.id === meId && p.isPinned) ? (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="2" y1="5" x2="22" y2="5"/>
                      <path d="M12 5v14l6-6H6z"/>
                    </svg>
                    Unpin Conversation
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="2" y1="5" x2="22" y2="5"/>
                      <path d="M12 5v14l6-6H6z"/>
                    </svg>
                    Pin Conversation
                  </>
                )}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                onSelect={() => onMenuSelect(conversation.isGroup ? 'deleteGroup' : 'deleteChat')}
                className="block w-full text-left px-3 py-2 text-sm text-destructive rounded cursor-pointer outline-none hover:bg-destructive hover:text-destructive-foreground"
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSearchResults || conversations.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (selectedIndex + 1) % conversations.length;
        setSelectedIndex(nextIndex);
        virtuosoRef.current?.scrollToIndex({ index: nextIndex, align: 'center' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const nextIndex = (selectedIndex - 1 + conversations.length) % conversations.length;
        setSelectedIndex(nextIndex);
        virtuosoRef.current?.scrollToIndex({ index: nextIndex, align: 'center' });
      } else if (e.key === 'Enter') {
        if (selectedIndex >= 0 && selectedIndex < conversations.length) {
          e.preventDefault();
          handleConversationClick(conversations[selectedIndex].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIndex, conversations, handleConversationClick, showSearchResults]);

  const handleMenuSelect = (id: string, action: 'deleteGroup' | 'deleteChat') => {
    const handler = action === 'deleteGroup' ? deleteGroup : deleteConversation;
    const title = action === 'deleteGroup' ? 'Delete Group' : 'Delete Chat';
    const message = action === 'deleteGroup' 
      ? 'Are you sure you want to permanently delete this group? This action cannot be undone.'
      : 'Are you sure you want to hide this chat? It will be removed from your conversation list.';
    showConfirm(title, message, () => handler(id));
  };

  return (
    <div className="h-full flex flex-col bg-bg-main">
      <UserProfile />
      <div className="p-4 border-b border-border">
        <div className="relative flex items-center">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary z-10">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <input 
            id="global-search-input"
            type="text" 
            placeholder="Search or start new chat..." 
            className="w-full p-3 pl-10 pr-12 bg-bg-surface rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-accent transition-all shadow-neumorphic-concave"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <button 
              onClick={openCreateGroupModal} 
              title="New Group Chat"
              aria-label="Create new group chat"
              className="p-2 rounded-full bg-accent text-accent-foreground shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex justify-center items-center h-full">
            <Spinner />
          </div>
        )}
        {error && !isLoading && (
          <div className="p-4 m-3 text-center text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="mb-2 text-sm">{error}</p>
            <button 
              onClick={handleRetry}
              className="px-3 py-1 text-sm font-semibold bg-destructive/80 text-white rounded-md hover:bg-destructive"
            >
              Retry
            </button>
          </div>
        )}
        {!error && !isLoading && showSearchResults ? (
          <SearchResults results={searchResults} onSelect={handleSelectUser} />
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={conversations}
            components={{
              Header: () => <p className="text-xs font-bold text-text-secondary px-4 pt-2 mb-2">CONVERSATIONS</p>,
              EmptyPlaceholder: () => <div className="text-center p-4 text-text-secondary">No conversations yet.</div>,
            }}
            itemContent={(index, c) => (
              <ConversationItem
                conversation={c}
                meId={meId}
                presence={presence}
                isActive={c.id === activeId}
                isSelected={index === selectedIndex}
                onClick={() => handleConversationClick(c.id)}
                onUserClick={openProfileModal}
                onMenuSelect={(action) => handleMenuSelect(c.id, action)}
                onTogglePin={togglePinConversation}
              />
            )}
          />
        )}
      </div>
      {showGroupModal && <CreateGroupChat onClose={() => setShowGroupModal(false)} />}
    </div>
  );
}