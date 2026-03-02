import { useState, useEffect, useRef } from 'react';
import { useMessageSearchStore } from '@store/messageSearch';
import { FiSearch, FiX } from 'react-icons/fi';

interface SearchMessagesProps {
  conversationId: string;
}

export default function SearchMessages({ conversationId }: SearchMessagesProps) {
  const [isOpen, setIsOpen] = useState(false);
  const {
    searchQuery,
    searchResults,
    isSearching,
    searchMessages,
    clearSearch,
    setHighlightedMessageId,
  } = useMessageSearchStore(state => ({
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    isSearching: state.isSearching,
    searchMessages: state.searchMessages,
    clearSearch: state.clearSearch,
    setHighlightedMessageId: state.setHighlightedMessageId,
  }));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    } else {
      clearSearch();
    }
  }, [isOpen, clearSearch]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    searchMessages(query, conversationId);
  };

  const handleResultClick = (messageId: string) => {
    setHighlightedMessageId(messageId);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button 
        onClick={() => setIsOpen(!isOpen)} 
        aria-label={isOpen ? "Close search" : "Search messages in this conversation"}
        className="p-2 rounded-full text-text-secondary hover:text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
      >
        {isOpen ? <FiX /> : <FiSearch />}
      </button>

      {isOpen && (
        <div className="absolute top-12 right-0 w-72 rounded-lg bg-bg-surface shadow-neumorphic-convex z-50">
          <form onSubmit={(e) => e.preventDefault()} className="p-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder="Search messages..."
              className="w-full bg-transparent p-3 rounded-lg text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent shadow-neumorphic-concave"
            />
          </form>
          <div className="max-h-80 overflow-y-auto relative">
            {isSearching && (
              <div className="absolute top-0 left-0 w-full h-1 bg-accent/20 overflow-hidden">
                 <div className="h-full bg-accent w-1/3 animate-pulse rounded-full"></div>
              </div>
            )}
            
            {searchResults.length > 0 ? (
              searchResults.map((msg) => (
                <div
                  key={msg.id}
                  onClick={() => handleResultClick(msg.id)}
                  className="p-3 hover:bg-secondary cursor-pointer border-b border-border last:border-b-0"
                >
                  <p className="text-sm text-text-primary truncate">{msg.content}</p>
                  <p className="text-xs text-text-secondary mt-1">{new Date(msg.createdAt).toLocaleString()}</p>
                </div>
              ))
            ) : (
              searchQuery && !isSearching && <p className="p-4 text-sm text-text-secondary text-center">No results found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}