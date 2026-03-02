import { createWithEqualityFn } from "zustand/traditional";
import { useMessageStore } from "./message";
import type { Message } from "./conversation";
import { shadowVault } from '@lib/shadowVaultDb';

type State = {
  searchResults: any[];
  highlightedMessageId: string | null;
  searchQuery: string;
  isSearching: boolean;
  
  // Actions
  searchMessages: (query: string, conversationId: string) => Promise<void>;
  setHighlightedMessageId: (messageId: string | null) => void;
  clearSearch: () => void;
};

export const useMessageSearchStore = createWithEqualityFn<State>((set, get) => ({
  searchResults: [],
  highlightedMessageId: null,
  searchQuery: '',
  isSearching: false,

  searchMessages: async (query, conversationId) => {
    set({ searchQuery: query, isSearching: true });
    
    if (!query.trim()) {
      set({ searchResults: [], isSearching: false });
      return;
    }

    try {
      // ⚡ LIGHTNING FAST DEEP LOCAL SEARCH
      const results = await shadowVault.messages
        .where('conversationId')
        .equals(conversationId)
        .filter(msg => {
          // Privacy layer: Do not return View Once media in text search
          if (msg.isViewOnce) return false;
          return msg.content.toLowerCase().includes(query.toLowerCase());
        })
        .reverse() // Show newest matching messages first
        .sortBy('createdAt');
        
      set({ searchResults: results, isSearching: false });
    } catch (error) {
      console.error("Shadow Search failed:", error);
      set({ searchResults: [], isSearching: false });
    }
  },

  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),
  
  clearSearch: () => set({ searchResults: [], searchQuery: '', isSearching: false, highlightedMessageId: null }),
}));
