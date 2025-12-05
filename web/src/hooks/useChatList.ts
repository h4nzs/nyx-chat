import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConversationStore } from '@store/conversation';
import { usePresenceStore } from '@store/presence';
import { useAuthStore, type User } from '@store/auth';
import { authFetch } from '@lib/api';
import { debounce } from 'lodash';

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
    } = useConversationStore(state => ({
      conversations: state.conversations,
      error: state.error,
      loading: state.loading,
      loadConversations: state.loadConversations,
      startConversation: state.startConversation,
      clearError: state.clearError,
      deleteGroup: state.deleteGroup,
      deleteConversation: state.deleteConversation,
      togglePinConversation: state.togglePinConversation,
    }));
  
    const onlineUsers = usePresenceStore(state => state.onlineUsers);
    const meId = useAuthStore(state => state.user?.id);
  
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<User[]>([]);
    const [isSearching, setIsSearching] = useState(false);
  
    const handleSearch = useCallback(debounce(async (query: string) => {
      if (!query.trim()) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      try {
        const users = await authFetch<User[]>(`/api/users/search?q=${query}`);
        setSearchResults(users);
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
  
    const handleSelectUser = async (userId: string) => {
      const conversationId = await startConversation(userId);
      navigate(`/chat/${conversationId}`);
      setSearchQuery('');
      setSearchResults([]);
    };
    
    const handleRetry = () => {
      clearError();
      loadConversations();
    }
  
    const filteredConversations = conversations.filter(c => {
      const title = c.title || c.participants?.filter(p => p.id !== meId).map(p => p.name).join(', ') || 'Conversation';
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
      // Actions
      setSearchQuery,
      handleConversationClick,
      handleSelectUser,
      handleRetry,
      deleteGroup,
      deleteConversation,
      togglePinConversation,
    };
  }
