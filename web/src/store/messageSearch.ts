import { createWithEqualityFn } from "zustand/traditional";
import { MessageRepository } from '@lib/db/index';
import type { Message } from "./conversation";
import type { MessageId } from '@nyx/shared';

type State = {
  searchResults: Message[];
  highlightedMessageId: MessageId | null;
  searchQuery: string;
  isSearching: boolean;
  currentSearchToken: string | null;
  
  // Actions
  searchMessages: (query: string, conversationId: string) => Promise<void>;
  setHighlightedMessageId: (messageId: MessageId | null) => void;
  clearSearch: () => void;
};

export const useMessageSearchStore = createWithEqualityFn<State>((set, get) => ({
  searchResults: [],
  highlightedMessageId: null,
  searchQuery: '',
  isSearching: false,
  currentSearchToken: null,

  searchMessages: async (query, conversationId) => {
    if (!query.trim()) {
      set({ searchResults: [], isSearching: false, searchQuery: query });
      return;
    }

    let token: string | null = null;

    try {
      const sodium = await import('@lib/sodiumInitializer').then(m => m.getSodium());
      token = sodium.to_hex(sodium.randombytes_buf(16));
      set({ searchQuery: query, isSearching: true, currentSearchToken: token });
      
      // Use the new chunked, memory-safe repository search
      const results = await MessageRepository.searchMessagesDecrypted(query, conversationId, 30);
        
      // ONLY update if the query hasn't changed while we were decrypting
      if (get().currentSearchToken === token) {
        set({ searchResults: results, isSearching: false });
      }
    } catch (error) {
      console.error("[Search] Local search failed:", error);
      if (get().currentSearchToken === token) {
        set({ searchResults: [], isSearching: false });
      }
    }
  },

  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),
  
  clearSearch: () => set({ searchResults: [], searchQuery: '', isSearching: false, highlightedMessageId: null }),
}));
