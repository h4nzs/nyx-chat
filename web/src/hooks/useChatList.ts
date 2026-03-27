import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConversationStore } from '@store/conversation';
import { usePresenceStore } from '@store/presence';
import { useAuthStore, type User } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import { authFetch } from '@lib/api';
import { debounce } from 'lodash-es';
import { hashUsername } from '@lib/crypto-worker-proxy';

export function useChatList() {
  const navigate = useNavigate();
  const { conversationId: activeId } = useParams<{ conversationId: string }>();

    const {
      conversations,
      error,
      loading,
      loadConversations,
      startConversation,
      clearError,
      deleteGroup,
      deleteConversation,
      togglePinConversation,
    } = useConversationStore(useShallow(state => ({
      conversations: state.conversations,
      error: state.error,
      loading: state.loading,
      loadConversations: state.loadConversations,
      startConversation: state.startConversation,
      clearError: state.clearError,
      deleteGroup: state.deleteGroup,
      deleteConversation: state.deleteConversation,
      togglePinConversation: state.togglePinConversation,
    })));

    const onlineUsers = usePresenceStore(state => state.onlineUsers);
    const meId = useAuthStore(state => state.user?.id);
    const { blockUser, unblockUser, blockedUserIds } = useAuthStore(useShallow(state => ({
      blockUser: state.blockUser,
      unblockUser: state.unblockUser,
      blockedUserIds: state.blockedUserIds,
    })));
  
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<User[]>([]);
    const [isSearching, setIsSearching] = useState(false);
  
    const handleSearch = useCallback(debounce(async (query: string) => {
      const rawQuery = query.trim();
      if (!rawQuery) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      try {
        const hashedQuery = await hashUsername(rawQuery);
        const users = await authFetch<User[]>(`/api/users/search?q=${encodeURIComponent(hashedQuery)}`);
        
        // Inject optimistic query as username/name since it was an exact hash match
        // Guard: If we already know the user locally (friend/existing chat), use their real name.
        const knownUsers = useConversationStore.getState().conversations.flatMap(c => c.participants);
        
        const optimisticUsers = users.map(u => {
            const known = knownUsers.find(k => k.id === u.id);
            if (known?.name && known.name !== 'Unknown') {
                return { ...u, name: known.name, username: known.username || rawQuery };
            }
            return { ...u, username: rawQuery, name: rawQuery };
        });
        
        setSearchResults(optimisticUsers);
      } catch (err) {
        console.error("Search failed", err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300), []);
  
    useEffect(() => {
      handleSearch(searchQuery);
    }, [searchQuery, handleSearch]);
  
    const handleConversationClick = (id: string) => {
      navigate(`/chat/${id}`);
    };
  
    const handleSelectUser = async (user: User) => {
      const conversationId = await startConversation(user.id, { name: user.name || 'Unknown', username: user.username || 'unknown' });
      navigate(`/chat/${conversationId}`);
      setSearchQuery('');
      setSearchResults([]);
    };
    
    const handleRetry = () => {
      clearError();
      loadConversations();
    }
  
    const filteredConversations = conversations.filter(c => {
      const title = c.isGroup 
          ? (c.decryptedMetadata?.title || 'Unknown Group') 
          : (c.participants.find(p => p.id !== meId)?.name || 'Unknown User');
      return title.toLowerCase().includes(searchQuery.toLowerCase());
    });  
    const showSearchResults = searchQuery.trim().length > 0;
  
    return {
      // State
      conversations: filteredConversations,
      searchResults,
      searchQuery,
      showSearchResults,
      isLoading: loading,
      isSearching,
      error,
      activeId,
      presence: Array.from(onlineUsers),
      meId,
      blockedUserIds,
      // Actions
      setSearchQuery,
      handleConversationClick,
      handleSelectUser,
      handleRetry,
      deleteGroup,
      deleteConversation,
      togglePinConversation,
      blockUser,
      unblockUser,
    };
  }
